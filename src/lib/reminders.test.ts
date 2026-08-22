import { describe, expect, it } from "vitest";

import {
  addDays,
  dedupeKey,
  planReminders,
  sendableAt,
  slotWords,
  type PlannableJob,
} from "./reminders.ts";

/** A visit on the 24th, with a customer and a technician to tell. */
function job(over: Partial<PlannableJob> = {}): PlannableJob {
  return {
    id: "job-1",
    jobNumber: "J-2608-0001",
    scheduledDate: "2026-08-24",
    slot: "9-1",
    serviceType: "Cockroach treatment",
    customerName: "Annapurna Restaurant",
    siteLabel: "Main site",
    siteLocality: "Green Park",
    status: "ASSIGNED",
    technician: { id: "tech-1", name: "Pushkar Malhotra", phoneE164: "919810000001" },
    customerContact: { name: "Ramesh Nair", phoneE164: "919871203344", email: "ramesh@annapurna.test" },
    ...over,
  };
}

const OFFICE = [{ email: "priya@shakticooling.test", userId: "user-priya" }];
const FIRM = "Shakti Cooling";

describe("when a reminder fires", () => {
  it("tells the customer the day before — Raunak's 23rd for a visit on the 24th", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    const customer = planned.filter((p) => p.audience === "customer");
    expect(customer.length).toBeGreaterThan(0);
    expect(customer.every((p) => p.kind === "visit_tomorrow")).toBe(true);
    expect(customer[0]!.body).toContain("due tomorrow");
  });

  it("tells them a week ahead too", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-17",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned.some((p) => p.kind === "visit_in_7_days")).toBe(true);
  });

  it("says nothing on a day that is neither", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-20",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned).toEqual([]);
  });
});

describe("who gets told", () => {
  it("reaches the customer on both channels and the technician on WhatsApp", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned.filter((p) => p.audience === "customer" && p.channel === "whatsapp")).toHaveLength(1);
    expect(planned.filter((p) => p.audience === "customer" && p.channel === "email")).toHaveLength(1);
    expect(planned.filter((p) => p.audience === "technician")).toHaveLength(1);
  });

  it("never names the technician to the customer", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    // Assignment changes between the reminder and the visit; naming the wrong
    // person gets the right one turned away at the gate.
    for (const p of planned.filter((x) => x.audience === "customer")) {
      expect(p.body).not.toContain("Pushkar");
    }
  });

  it("gives the office ONE digest, not one message per job", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      job({ id: `job-${i}`, jobNumber: `J-000${i}` }),
    );
    const planned = planReminders({
      jobs: many,
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    const office = planned.filter((p) => p.audience === "office");
    // Twenty-five a day to the same person is a mail rule inside a week.
    expect(office).toHaveLength(1);
    expect(office[0]!.body).toContain("25 visits tomorrow");
  });

  it("names the unassigned ones in the digest, because that is the actionable part", () => {
    const planned = planReminders({
      jobs: [job({ id: "a" }), job({ id: "b", jobNumber: "J-BARE", technician: null })],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    const office = planned.find((p) => p.audience === "office")!;
    expect(office.body).toContain("1 still has nobody assigned");
    expect(office.body).toContain("NOBODY ASSIGNED");
  });

  it("skips the digest when there is nothing tomorrow", () => {
    const planned = planReminders({
      jobs: [job({ scheduledDate: "2026-09-30" })],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned.filter((p) => p.audience === "office")).toHaveLength(0);
  });
});

describe("what is deliberately not sent", () => {
  it.each(["CANCELLED", "SIGNED_OFF", "WORK_DONE"])(
    "says nothing about a %s visit",
    (status) => {
      const planned = planReminders({
        jobs: [job({ status })],
        today: "2026-08-23",
        firmName: FIRM,
        officeEmails: OFFICE,
      });
      expect(planned).toEqual([]);
    },
  );

  it("skips a channel the contact has no address for", () => {
    const planned = planReminders({
      jobs: [job({ customerContact: { name: "R", phoneE164: null, email: null } })],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned.filter((p) => p.audience === "customer")).toHaveLength(0);
  });

  it("still tells the technician when the customer cannot be reached", () => {
    const planned = planReminders({
      jobs: [job({ customerContact: null })],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(planned.filter((p) => p.audience === "technician")).toHaveLength(1);
  });
});

describe("sending twice is impossible", () => {
  it("gives one key per job, kind, channel and recipient", () => {
    const planned = planReminders({
      jobs: [job()],
      today: "2026-08-23",
      firmName: FIRM,
      officeEmails: OFFICE,
    });
    expect(new Set(planned.map((p) => p.dedupeKey)).size).toBe(planned.length);
  });

  it("gives the same key on a re-run, so the second insert loses", () => {
    const args = { jobs: [job()], today: "2026-08-23", firmName: FIRM, officeEmails: OFFICE };
    expect(planReminders(args).map((p) => p.dedupeKey)).toEqual(
      planReminders(args).map((p) => p.dedupeKey),
    );
  });

  it("scopes the digest by day, not by job, so nulls cannot make it distinct", () => {
    const key = dedupeKey({
      kind: "daily_digest",
      channel: "email",
      recipient: "a@b.test",
      day: "2026-08-24",
    });
    expect(key).toBe("digest:2026-08-24:daily_digest:email:a@b.test");
  });
});

describe("quiet hours", () => {
  it("lets a message through inside the window", () => {
    // 12:00 IST = 06:30 UTC.
    const noon = new Date("2026-08-23T06:30:00Z");
    expect(sendableAt(noon).toISOString()).toBe(noon.toISOString());
  });

  it("holds a 03:00 IST message to 09:00 IST the same morning", () => {
    // 03:00 IST = 21:30 UTC the previous day.
    const night = new Date("2026-08-22T21:30:00Z");
    // 09:00 IST on the 23rd = 03:30 UTC on the 23rd.
    expect(sendableAt(night).toISOString()).toBe("2026-08-23T03:30:00.000Z");
  });

  it("holds an evening message to the next morning", () => {
    // 20:00 IST = 14:30 UTC.
    const evening = new Date("2026-08-23T14:30:00Z");
    expect(sendableAt(evening).toISOString()).toBe("2026-08-24T03:30:00.000Z");
  });
});

describe("the words a customer reads", () => {
  it("turns a slot into a window rather than a code", () => {
    expect(slotWords("9-1")).toBe("9 am and 1 pm");
    expect(slotWords(null)).toBe("the day");
  });

  it("counts days without dragging a Date across a timezone", () => {
    expect(addDays("2026-08-24", -1)).toBe("2026-08-23");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
