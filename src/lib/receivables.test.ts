import { describe, expect, it } from "vitest";

import { creditableRemaining, isSettled, outstandingOf, taxOnUncollected } from "./receivables.ts";

describe("what is owed", () => {
  it("is the invoice less what came in", () => {
    expect(outstandingOf({ grandTotalPaise: 7_080_00, paidPaise: 4_000_00, creditedPaise: 0 }))
      .toBe(3_080_00);
  });

  it("subtracts a credit note as well as a payment", () => {
    /*
      The whole point: a customer who paid ₹4,000 and was credited ₹3,080 owes
      nothing. Chasing them for ₹3,080 is the failure this exists to prevent.
    */
    expect(
      outstandingOf({ grandTotalPaise: 7_080_00, paidPaise: 4_000_00, creditedPaise: 3_080_00 }),
    ).toBe(0);
  });

  it("never goes negative", () => {
    // The write paths refuse over-payment and over-crediting, so a negative
    // here is a bug — and reporting it would read as money owed to the customer
    // in a total with no way to say that.
    expect(outstandingOf({ grandTotalPaise: 1_000_00, paidPaise: 900_00, creditedPaise: 500_00 }))
      .toBe(0);
  });

  it("calls it settled only when nothing is left", () => {
    expect(isSettled({ grandTotalPaise: 100_00, paidPaise: 100_00, creditedPaise: 0 })).toBe(true);
    expect(isSettled({ grandTotalPaise: 100_00, paidPaise: 99_00, creditedPaise: 0 })).toBe(false);
  });
});

describe("how much may still be credited", () => {
  it("is the invoice less what is already credited", () => {
    expect(creditableRemaining({ grandTotalPaise: 7_080_00, creditedPaise: 3_080_00 }))
      .toBe(4_000_00);
  });

  it("does not care what has been paid", () => {
    /*
      Deliberate. A customer who paid in full can still be credited — that is a
      refund situation, and the cap is the value of the supply, not the unpaid
      part of it.
    */
    expect(creditableRemaining({ grandTotalPaise: 7_080_00, creditedPaise: 0 })).toBe(7_080_00);
  });

  it("reaches zero and stops", () => {
    expect(creditableRemaining({ grandTotalPaise: 7_080_00, creditedPaise: 7_080_00 })).toBe(0);
  });
});

describe("the refund case this cannot yet express", () => {
  it("floors at zero when a paid invoice is credited, and that hides a refund", () => {
    /*
      Legitimate, not a bug in the inputs: crediting is capped at the invoice's
      value rather than its unpaid part, so a fully-paid invoice can still be
      credited — and then the firm owes the customer.

      Pinned as a test so the limitation is stated rather than discovered. When
      a refund voucher exists, this expectation is the thing that should change.
    */
    expect(
      outstandingOf({ grandTotalPaise: 7_080_00, paidPaise: 7_080_00, creditedPaise: 1_180_00 }),
    ).toBe(0);
  });
});

describe("GST paid on money that never arrived", () => {
  it("is the whole tax when nothing has been collected", () => {
    expect(
      taxOnUncollected({ grandTotalPaise: 7_080_00, totalTaxPaise: 1_080_00, outstandingPaise: 7_080_00 }),
    ).toBe(1_080_00);
  });

  it("is nothing once the invoice is settled", () => {
    expect(
      taxOnUncollected({ grandTotalPaise: 7_080_00, totalTaxPaise: 1_080_00, outstandingPaise: 0 }),
    ).toBe(0);
  });

  it("apportions a part payment across the whole document", () => {
    /*
      ₹4,000 of ₹7,080 collected leaves ₹3,080 outstanding — 43.5% of the
      invoice — so 43.5% of the ₹1,080 tax sits against money not received.

      Deliberately NOT "the tax on the unpaid part": a payment is not earmarked
      to particular lines, and treating the first rupees in as taxable value and
      the last as tax is a fiction that gives a different answer if reversed.
    */
    const exposure = taxOnUncollected({
      grandTotalPaise: 7_080_00,
      totalTaxPaise: 1_080_00,
      outstandingPaise: 3_080_00,
    });
    expect(exposure).toBe(46_983);
    expect(exposure).toBeLessThan(1_080_00);
  });

  it("cannot exceed the tax actually charged", () => {
    // Defensive: a bad outstanding figure must not invent tax that was never paid.
    expect(
      taxOnUncollected({ grandTotalPaise: 1_000_00, totalTaxPaise: 180_00, outstandingPaise: 5_000_00 }),
    ).toBe(180_00);
  });

  it("says nothing about an invoice worth nothing", () => {
    expect(
      taxOnUncollected({ grandTotalPaise: 0, totalTaxPaise: 0, outstandingPaise: 0 }),
    ).toBe(0);
  });
});
