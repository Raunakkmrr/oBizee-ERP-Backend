import { describe, expect, it } from "vitest";

import { customerDeductionRisk, deductionChaseMessage } from "./deduction-risk.ts";

const MICRO_SERVICE = { msmeClass: "MICRO", udyamActivity: "SERVICE" } as const;

const BASE = {
  invoiceIssueDate: "2026-08-17",
  outstandingPaise: 3_080_00,
  grandTotalPaise: 7_080_00,
  taxableValuePaise: 6_000_00,
  tenant: MICRO_SERVICE,
  customerHasWrittenAgreement: false,
  today: "2026-08-24",
};

describe("when a customer's own deduction turns against them", () => {
  it("is 15 days after the invoice without a written agreement", () => {
    const r = customerDeductionRisk(BASE);
    expect(r.applies).toBe(true);
    if (!r.applies) return;
    expect(r.limitDays).toBe(15);
    expect(r.lapsesOn).toBe("2026-09-01");
  });

  it("is 45 days with a written agreement", () => {
    const r = customerDeductionRisk({ ...BASE, customerHasWrittenAgreement: true });
    expect(r.applies).toBe(true);
    if (!r.applies) return;
    expect(r.limitDays).toBe(45);
    expect(r.lapsesOn).toBe("2026-10-01");
  });

  it("counts down, and knows when it has passed", () => {
    const before = customerDeductionRisk({ ...BASE, today: "2026-08-31" });
    const after = customerDeductionRisk({ ...BASE, today: "2026-09-02" });
    expect(before.applies && before.daysUntil).toBe(1);
    expect(before.applies && before.passed).toBe(false);
    expect(after.applies && after.passed).toBe(true);
  });

  it("does not apply when the firm's own registration is unverified", () => {
    const r = customerDeductionRisk({ ...BASE, tenant: { msmeClass: "UNVERIFIED", udyamActivity: null } });
    expect(r).toEqual({
      applies: false,
      reason: "Udyam status unverified — the risk is unquantified, not absent",
    });
  });

  it("does not apply when the firm is not a micro or small enterprise", () => {
    const r = customerDeductionRisk({
      ...BASE,
      tenant: { msmeClass: "NOT_REGISTERED", udyamActivity: null },
    });
    expect(r.applies).toBe(false);
  });

  it("does not apply once the invoice is settled", () => {
    const r = customerDeductionRisk({ ...BASE, outstandingPaise: 0 });
    expect(r).toEqual({ applies: false, reason: "settled" });
  });

  it("still applies when the invoice is only PARTLY unpaid", () => {
    const r = customerDeductionRisk({ ...BASE, outstandingPaise: 1_00 });
    expect(r.applies).toBe(true);
  });

  it("apportions the deduction at risk to the outstanding share", () => {
    const r = customerDeductionRisk(BASE);
    expect(r.applies).toBe(true);
    if (!r.applies) return;
    // outstanding is 3,080 of 7,080 → 43.5028...% of the 6,000 taxable value.
    expect(r.deductionAtRiskPaise).toBe(Math.round(6_000_00 * (3_080_00 / 7_080_00)));
  });
});

describe("the sentence sent to them", () => {
  const risk = customerDeductionRisk(BASE);

  it("states the consequence in their ledger, with the date and the amount", () => {
    if (!risk.applies) throw new Error("fixture should apply");
    const message = deductionChaseMessage({
      customer: "Shakti Industries",
      invoiceNumber: "SVC/26-27/0347",
      invoiceDateWord: "17 Aug 2026",
      risk,
      firmName: "Shakti Cooling",
    });
    expect(message).toContain("2026-09-01");
    expect(message).toContain("§37(2)(g)");
    // Not a plea. The whole point is that it is about their books.
    expect(message).not.toContain("kindly release");
  });

  it("changes tense once the date has gone", () => {
    const past = customerDeductionRisk({ ...BASE, today: "2026-09-10" });
    if (!past.applies) throw new Error("fixture should apply");
    const message = deductionChaseMessage({
      customer: "Shakti Industries",
      invoiceNumber: "SVC/26-27/0347",
      invoiceDateWord: "17 Aug 2026",
      risk: past,
      firmName: "Shakti Cooling",
    });
    expect(message).toContain("is now disallowed for the year");
    expect(message).toContain("no way to recover it");
  });
});
