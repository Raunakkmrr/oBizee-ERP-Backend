import { describe, expect, it } from "vitest";

import { creditNoteWindow, financialYearOf } from "./credit-note-window.ts";

describe("which year a supply falls in", () => {
  it("runs April to March", () => {
    expect(financialYearOf("2026-04-01")).toBe(2026);
    expect(financialYearOf("2027-03-31")).toBe(2026);
    expect(financialYearOf("2026-03-31")).toBe(2025);
  });
});

describe("the §34(2) window", () => {
  it("is 30 November after the year ends, when nobody has said otherwise", () => {
    const w = creditNoteWindow({ invoiceIssueDate: "2026-08-17", today: "2026-08-23" });
    // FY 2026-27 ends 31 Mar 2027; the outside date is 30 Nov 2027.
    expect(w.deadline).toBe("2027-11-30");
    expect(w.assumed).toBe(true);
    expect(w.closed).toBe(false);
  });

  it("closes EARLIER when the annual return was filed early", () => {
    /*
      The trap that only exists above ₹2 crore, where GSTR-9 is mandatory: a
      firm whose CA files in September loses two months against the statute,
      and being well-organised is what costs it.
    */
    const w = creditNoteWindow({
      invoiceIssueDate: "2026-08-17",
      gstr9FiledOn: "2027-09-15",
      today: "2026-08-23",
    });
    expect(w.deadline).toBe("2027-09-15");
    expect(w.assumed).toBe(false);
  });

  it("does not let a late filing extend the statutory date", () => {
    // The statute is an outside limit, not a race.
    const w = creditNoteWindow({
      invoiceIssueDate: "2026-08-17",
      gstr9FiledOn: "2027-12-20",
      today: "2026-08-23",
    });
    expect(w.deadline).toBe("2027-11-30");
  });

  it("counts the days left", () => {
    const w = creditNoteWindow({
      invoiceIssueDate: "2026-08-17",
      gstr9FiledOn: "2027-09-15",
      today: "2027-09-01",
    });
    expect(w.daysLeft).toBe(14);
    expect(w.closed).toBe(false);
  });

  it("is open on the deadline itself and shut the day after", () => {
    const on = creditNoteWindow({
      invoiceIssueDate: "2026-08-17",
      today: "2027-11-30",
    });
    expect(on.closed).toBe(false);

    const after = creditNoteWindow({
      invoiceIssueDate: "2026-08-17",
      today: "2027-12-01",
    });
    expect(after.closed).toBe(true);
    // Once shut, the tax is sunk: GST has no bad-debt relief.
    expect(after.daysLeft).toBeLessThan(0);
  });

  it("gives a March invoice a much shorter run than an April one", () => {
    /*
      Worth pinning because it is counter-intuitive and expensive: two invoices
      six weeks apart can have deadlines a year apart.
    */
    const march = creditNoteWindow({ invoiceIssueDate: "2027-03-30", today: "2027-04-01" });
    const april = creditNoteWindow({ invoiceIssueDate: "2027-04-02", today: "2027-04-01" });
    expect(march.deadline).toBe("2027-11-30");
    expect(april.deadline).toBe("2028-11-30");
  });
});
