import { describe, expect, it } from "vitest";
import {
  isUnregistered,
  msmedApplies,
  type VendorFacts as Vendor,
} from "./purchases.ts";
import {
  adviseTds,
  billTotals,
  clockFor,
  deductionAtRiskPaise,
  deductionLostPaise,
  reverseChargeFor,
  suggestSection,
  type PurchaseBill,
} from "./purchases.ts";

const NOW = new Date("2026-08-07T10:00:00");
/** The three vendors the seed carries, as plain facts. */
const SEED_VENDORS: Vendor[] = [
  { id: "ven_1", gstin: "07AAACK1234F1Z9", pan: "AAACK1234F", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamActivity: "MANUFACTURING", hasWrittenAgreement: true },
  { id: "ven_2", gstin: null, pan: "ABCPV7788K", panType: "INDIVIDUAL_HUF", msmeClass: "MICRO", udyamActivity: "SERVICE", hasWrittenAgreement: false },
  { id: "ven_3", gstin: "07AAFCM5566P1ZR", pan: "AAFCM5566P", panType: "COMPANY_FIRM_OTHER", msmeClass: "SMALL", udyamActivity: "TRADING", hasWrittenAgreement: true },
];

const vendor = (over: Partial<Vendor> = {}): Vendor => ({
  ...SEED_VENDORS[0]!,
  ...over,
});

const bill = (over: Partial<PurchaseBill> = {}): PurchaseBill => ({
  id: "pb_1",
  vendorBillNumber: "KSD/26-27/118",
  vendorId: "ven_1",
  vendorName: "Kirloskar Spares Depot",
  billDate: "2026-07-01",
  description: "Generator AMC — quarterly labour",
  taxablePaise: 50_000_00,
  gstPercent: 18,
  gstPaise: 9_000_00,
  reverseCharge: false,
  tdsSection: "194C",
  tdsPaise: 1_000_00,
  payablePaise: 58_000_00,
  status: "UNPAID",
  ...over,
});

describe("FR-906 — an AMC is work, not professional services", () => {
  it("suggests 194C for maintenance, repair and AMC wording", () => {
    // The single commonest TDS error in this industry is deducting 10% under
    // 194J on a maintenance contract that belongs under 194C.
    for (const text of [
      "Generator AMC — quarterly",
      "AC repair labour",
      "Supply and fitting of ducting",
      "Annual maintenance contract",
    ]) {
      expect(suggestSection(text), text).toBe("194C");
    }
  });

  it("suggests 194J only for genuinely professional work", () => {
    expect(suggestSection("Energy audit consultancy")).toBe("194J");
    expect(suggestSection("Legal advisory")).toBe("194J");
  });

  it("deducts 2% from a company and 1% from an individual", () => {
    const company = adviseTds("194C", 50_000_00, vendor({ panType: "COMPANY_FIRM_OTHER" }));
    const individual = adviseTds("194C", 50_000_00, vendor({ panType: "INDIVIDUAL_HUF" }));
    expect(company.kind === "deduct" && company.amountPaise).toBe(1_000_00);
    expect(individual.kind === "deduct" && individual.amountPaise).toBe(500_00);
  });

  it("deducts nothing below both 194C thresholds", () => {
    // Deducting anyway is not caution — it is withholding money the vendor is
    // owed and handing the firm's working capital to the department.
    const advice = adviseTds("194C", 12_000_00, vendor());
    expect(advice.kind).toBe("below_threshold");
  });

  it("deducts once the year's total crosses ₹1,00,000 even on a small bill", () => {
    const advice = adviseTds("194C", 12_000_00, vendor(), 95_000_00);
    expect(advice.kind).toBe("deduct");
  });

  it("charges 20% under §206AA when there is no PAN", () => {
    const advice = adviseTds("194C", 50_000_00, vendor({ pan: null }));
    expect(advice.kind === "deduct" && advice.ratePercent).toBe(20);
    expect(advice.kind === "deduct" && advice.reason).toContain("206AA");
  });

  it("computes on the taxable value, never the GST-inclusive total", () => {
    // Deducting on the gross over-deducts by 18% of the tax.
    const advice = adviseTds("194C", 1_00_000_00, vendor());
    expect(advice.kind === "deduct" && advice.amountPaise).toBe(2_000_00);
  });
});

describe("FR-807 — reverse charge is flagged, not computed silently", () => {
  it("flags an unregistered supplier, with the reason", () => {
    const rc = reverseChargeFor(vendor({ gstin: null }));
    expect(rc.applies).toBe(true);
    expect(rc.reason).toContain("no GSTIN");
  });

  it("does not flag a registered supplier", () => {
    expect(reverseChargeFor(vendor({ gstin: "07AAACK1234F1Z9" })).applies).toBe(false);
  });

  it("keeps the GST out of what the vendor is paid", () => {
    /*
      Under reverse charge the buyer remits the tax directly. Paying it to the
      vendor as well overpays them by 18% and leaves the liability on the return
      regardless.
    */
    const normal = billTotals({ taxablePaise: 10_000_00, gstPercent: 18, reverseCharge: false, tdsPaise: 0 });
    const rcm = billTotals({ taxablePaise: 10_000_00, gstPercent: 18, reverseCharge: true, tdsPaise: 0 });
    expect(normal.payablePaise).toBe(11_800_00);
    expect(rcm.payablePaise).toBe(10_000_00);
    // The tax still exists — it is just not the vendor's to collect.
    expect(rcm.gstPaise).toBe(1_800_00);
  });

  it("takes TDS off what is actually paid", () => {
    const totals = billTotals({ taxablePaise: 50_000_00, gstPercent: 18, reverseCharge: false, tdsPaise: 1_000_00 });
    expect(totals.payablePaise).toBe(58_000_00);
  });
});

describe("FR-905 — the §43B(h) clock, on real bills", () => {
  it("gives 45 days with a written agreement and 15 without", () => {
    expect(msmedApplies(vendor({ hasWrittenAgreement: true }))).toEqual({
      applies: true,
      limitDays: 45,
    });
    expect(msmedApplies(vendor({ hasWrittenAgreement: false }))).toEqual({
      applies: true,
      limitDays: 15,
    });
  });

  it("excludes a trading registration, and says why", () => {
    const result = msmedApplies(vendor({ udyamActivity: "TRADING" }));
    expect(result.applies).toBe(false);
    expect(!result.applies && result.reason).toContain("trading");
  });

  it("treats unverified as unquantified risk, not as no risk", () => {
    const result = msmedApplies(vendor({ msmeClass: "UNVERIFIED" }));
    expect(result.applies).toBe(false);
    expect(!result.applies && result.reason).toContain("not absent");
  });

  it("counts down, then lapses — two different shapes", () => {
    const v = vendor({ hasWrittenAgreement: true });
    const counting = clockFor(bill({ billDate: "2026-07-20" }), v, NOW);
    expect(counting.kind).toBe("counting");
    expect(counting.kind === "counting" && counting.daysLeft).toBe(27);

    const lapsed = clockFor(bill({ billDate: "2026-05-01" }), v, NOW);
    expect(lapsed.kind).toBe("lapsed");
  });

  it("stops counting once the bill is paid", () => {
    expect(clockFor(bill({ status: "PAID" }), vendor(), NOW).kind).toBe("paid");
  });

  it("never counts already-lost money as still at risk", () => {
    /*
      The distinction the whole screen turns on: money on day 38 of 45 is saved
      by paying today, money on day 60 is not. Adding them together understates
      the loss and overstates what can still be rescued.
    */
    const bills = [
      bill({ id: "a", billDate: "2026-07-20", taxablePaise: 50_000_00 }),
      bill({ id: "b", billDate: "2026-05-01", taxablePaise: 80_000_00 }),
    ];
    const vendors = [vendor({ id: "ven_1", hasWrittenAgreement: true })];
    expect(deductionAtRiskPaise(bills, vendors, NOW)).toBe(50_000_00);
    expect(deductionLostPaise(bills, vendors, NOW)).toBe(80_000_00);
  });
});

describe("the seed vendors cover the cases that differ", () => {
  it("has an unregistered individual, and a trader", () => {
    expect(SEED_VENDORS.some((v) => isUnregistered(v))).toBe(true);
    expect(SEED_VENDORS.some((v) => v.udyamActivity === "TRADING")).toBe(true);
    expect(SEED_VENDORS.some((v) => v.panType === "INDIVIDUAL_HUF")).toBe(true);
  });
});
