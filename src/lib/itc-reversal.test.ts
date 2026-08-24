import { describe, expect, it } from "vitest";

import { itcChaseMessage, itcReversal, ITC_REVERSAL_DAYS } from "./itc-reversal.ts";

const BASE = {
  invoiceIssueDate: "2026-08-17",
  customerGstin: "27AABCS1234M1Z5",
  outstandingPaise: 3_080_00,
  taxOnUncollectedPaise: 469_83,
  today: "2026-08-24",
};

describe("when the customer's credit turns against them", () => {
  it("is 180 days after the invoice", () => {
    const r = itcReversal(BASE);
    expect(r.applies).toBe(true);
    if (!r.applies) return;
    expect(r.reversesOn).toBe("2027-02-13");
    expect(ITC_REVERSAL_DAYS).toBe(180);
  });

  it("counts down, and knows when it has passed", () => {
    const before = itcReversal({ ...BASE, today: "2027-02-12" });
    const after = itcReversal({ ...BASE, today: "2027-02-14" });
    expect(before.applies && before.daysUntil).toBe(1);
    expect(before.applies && before.passed).toBe(false);
    expect(after.applies && after.passed).toBe(true);
  });

  it("does not apply to an unregistered customer", () => {
    /*
      Somebody with no GSTIN claimed no credit and has none to reverse.
      Threatening them with it would be wrong and embarrassing in equal measure.
    */
    const r = itcReversal({ ...BASE, customerGstin: null });
    expect(r).toEqual({ applies: false, reason: "customer_not_registered" });
  });

  it("does not apply once the invoice is settled", () => {
    const r = itcReversal({ ...BASE, outstandingPaise: 0 });
    expect(r).toEqual({ applies: false, reason: "settled" });
  });

  it("still applies when the invoice is only PARTLY unpaid", () => {
    // Rule 37 bites on an invoice unpaid "wholly or partly" — the half-paid
    // case is exactly the one this firm keeps hitting.
    const r = itcReversal({ ...BASE, outstandingPaise: 1_00 });
    expect(r.applies).toBe(true);
  });
});

describe("the sentence sent to them", () => {
  const reversal = itcReversal(BASE);

  it("states the consequence in their ledger, with the date and the amount", () => {
    if (!reversal.applies) throw new Error("fixture should apply");
    const message = itcChaseMessage({
      customer: "Shakti Industries",
      invoiceNumber: "SVC/26-27/0347",
      invoiceDateWord: "17 Aug 2026",
      reversal,
      firmName: "Shakti Cooling",
    });
    expect(message).toContain("2027-02-13");
    expect(message).toContain("₹469.83");
    expect(message).toContain("Rule 37");
    // Not a plea. The whole point is that it is about their books.
    expect(message).not.toContain("kindly release");
  });

  it("changes tense once the date has gone", () => {
    const past = itcReversal({ ...BASE, today: "2027-03-01" });
    if (!past.applies) throw new Error("fixture should apply");
    const message = itcChaseMessage({
      customer: "Shakti Industries",
      invoiceNumber: "SVC/26-27/0347",
      invoiceDateWord: "17 Aug 2026",
      reversal: past,
      firmName: "Shakti Cooling",
    });
    expect(message).toContain("is now reversible");
    expect(message).toContain("re-availed once payment is made");
  });
});
