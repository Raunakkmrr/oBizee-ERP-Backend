import { z } from "zod";
/**
 * Ported from `obez-erp-web/src/lib/data/purchases.ts`, where the rules were
 * worked out and tested. The vendor shape it needs is structural rather than
 * the database row, so a caller can pass either.
 */
export type VendorFacts = {
  id: string;
  gstin: string | null;
  pan: string | null;
  panType: "INDIVIDUAL_HUF" | "COMPANY_FIRM_OTHER";
  msmeClass: "MICRO" | "SMALL" | "MEDIUM" | "NOT_REGISTERED" | "UNVERIFIED";
  udyamActivity: "MANUFACTURING" | "SERVICE" | "TRADING" | null;
  hasWrittenAgreement: boolean;
};

export function isUnregistered(v: Pick<VendorFacts, "gstin">): boolean {
  return v.gstin === null || v.gstin.trim() === "";
}

/**
 * Whether a vendor's bills fall under the MSMED payment timeline at all.
 * Returns a reason either way — "no timeline" is a fact somebody will be asked
 * to justify, not an absence.
 */
export function msmedApplies(
  v: Pick<VendorFacts, "msmeClass" | "udyamActivity" | "hasWrittenAgreement">,
): { applies: true; limitDays: 15 | 45 } | { applies: false; reason: string } {
  if (v.msmeClass === "UNVERIFIED") {
    return { applies: false, reason: "Udyam status unverified — the risk is unquantified, not absent" };
  }
  if (v.msmeClass === "MEDIUM" || v.msmeClass === "NOT_REGISTERED") {
    return { applies: false, reason: "Only micro and small enterprises attract the MSMED timeline" };
  }
  if (v.udyamActivity === "TRADING") {
    return { applies: false, reason: "Udyam registration is for trading, which the timeline excludes" };
  }
  return { applies: true, limitDays: v.hasWrittenAgreement ? 45 : 15 };
}

type Vendor = VendorFacts;

/**
 * Purchase bills, reverse charge and TDS — FR-705, FR-807, FR-906.
 *
 * Three rules live here, and each exists because getting it wrong costs money
 * in a way nobody notices until an assessment.
 *
 * **FR-807 — reverse charge is flagged, never computed silently.** When a
 * registered business buys from an unregistered supplier, or buys certain
 * notified services, the *buyer* pays the GST instead of the seller. Software
 * that quietly adds it to a bill produces a liability the owner did not know he
 * had; software that quietly omits it produces a shortfall. So this returns a
 * flag with a reason, and the screen asks.
 *
 * **FR-906 — an AMC is "work", not "professional services".** This is the
 * single most common TDS error in this industry: maintenance contracts get
 * deducted at 10% under §194J when they belong under §194C at 2% — or 1% if the
 * vendor is an individual or HUF. Over-deducting is the firm's own working
 * capital handed to the department for a year.
 *
 * **FR-905's clock starts here.** The countdown already existed in `money.ts`
 * against a fixture; a bill recorded through this module feeds it real dates.
 */

export const TDS_SECTIONS = ["194C", "194J", "NONE"] as const;
export type TdsSection = (typeof TDS_SECTIONS)[number];

export const TDS_SECTION_LABEL: Record<TdsSection, string> = {
  "194C": "194C — work, including AMC and repairs",
  "194J": "194J — professional or technical services",
  NONE: "No TDS on this bill",
};

/**
 * §194C thresholds: ₹30,000 on a single bill, or ₹1,00,000 in the year.
 * Below both, nothing is deducted — and deducting anyway is not "being safe",
 * it is withholding money the vendor is owed.
 */
export const TDS_194C_SINGLE_LIMIT_PAISE = 30_000_00;
export const TDS_194C_ANNUAL_LIMIT_PAISE = 1_00_000_00;
/** §194J has one threshold of ₹50,000 in the year. */
export const TDS_194J_ANNUAL_LIMIT_PAISE = 50_000_00;

export type TdsAdvice =
  | {
      kind: "deduct";
      section: TdsSection;
      ratePercent: number;
      amountPaise: number;
      reason: string;
    }
  | { kind: "below_threshold"; section: TdsSection; reason: string }
  | { kind: "none"; reason: string };

/**
 * What to deduct, and why.
 *
 * TDS is computed on the **taxable value, not the GST-inclusive total** — a
 * mistake that quietly over-deducts by 18% of the tax.
 */
export function adviseTds(
  section: TdsSection,
  taxablePaise: number,
  vendor: Pick<Vendor, "panType" | "pan">,
  paidToVendorThisYearPaise = 0,
): TdsAdvice {
  if (section === "NONE") {
    return { kind: "none", reason: "Marked as not liable to deduction" };
  }

  // No PAN means §206AA: 20%, and it is the vendor's problem to fix, not
  // something to quietly absorb.
  if (vendor.pan === null || vendor.pan.trim() === "") {
    return {
      kind: "deduct",
      section,
      ratePercent: 20,
      amountPaise: Math.round(taxablePaise * 0.2),
      reason: "No PAN on file — §206AA requires 20%. Get the PAN to reduce it.",
    };
  }

  if (section === "194C") {
    const yearTotal = paidToVendorThisYearPaise + taxablePaise;
    if (
      taxablePaise < TDS_194C_SINGLE_LIMIT_PAISE &&
      yearTotal < TDS_194C_ANNUAL_LIMIT_PAISE
    ) {
      return {
        kind: "below_threshold",
        section,
        reason:
          "Under ₹30,000 on this bill and ₹1,00,000 for the year — nothing to deduct",
      };
    }
    const ratePercent = vendor.panType === "INDIVIDUAL_HUF" ? 1 : 2;
    return {
      kind: "deduct",
      section,
      ratePercent,
      amountPaise: Math.round((taxablePaise * ratePercent) / 100),
      reason:
        vendor.panType === "INDIVIDUAL_HUF"
          ? "§194C at 1% — the vendor is an individual or HUF"
          : "§194C at 2% — the vendor is a company, firm or other",
    };
  }

  const yearTotal = paidToVendorThisYearPaise + taxablePaise;
  if (yearTotal < TDS_194J_ANNUAL_LIMIT_PAISE) {
    return {
      kind: "below_threshold",
      section,
      reason: "Under ₹50,000 for the year — nothing to deduct",
    };
  }
  return {
    kind: "deduct",
    section,
    ratePercent: 10,
    amountPaise: Math.round(taxablePaise * 0.1),
    reason: "§194J at 10% — professional or technical services",
  };
}

/**
 * The section this bill most likely falls under, offered as a default.
 *
 * An AMC, a repair, a service visit and a supply-and-fit are all "work". The
 * suggestion exists because 194J is the wrong answer people reach for, and it
 * is a suggestion because only the payer can decide.
 */
export function suggestSection(description: string): TdsSection {
  const text = description.toLowerCase();
  if (/amc|maintenance|repair|service|labour|install|fitting|contract/.test(text)) {
    return "194C";
  }
  if (/consult|design|audit|advis|professional|technical|legal/.test(text)) {
    return "194J";
  }
  return "194C";
}

export type ReverseCharge =
  | { applies: true; reason: string }
  | { applies: false; reason: string };

/** FR-807 — flagged with its reason, for a human to confirm. */
export function reverseChargeFor(vendor: Vendor): ReverseCharge {
  if (isUnregistered(vendor)) {
    return {
      applies: true,
      reason:
        "This supplier has no GSTIN, so the tax on their supply is yours to pay and claim",
    };
  }
  return {
    applies: false,
    reason: "The supplier is registered and charges GST on their own invoice",
  };
}

export const purchaseBillSchema = z.object({
  id: z.string(),
  /** The vendor's own bill number — never ours; this is an inward document. */
  vendorBillNumber: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  billDate: z.string(),
  description: z.string(),
  taxablePaise: z.number().int().nonnegative(),
  gstPercent: z.number(),
  gstPaise: z.number().int().nonnegative(),
  reverseCharge: z.boolean(),
  tdsSection: z.enum(TDS_SECTIONS),
  tdsPaise: z.number().int().nonnegative(),
  /** What the vendor is actually paid: bill total, less TDS. */
  payablePaise: z.number().int(),
  status: z.enum(["UNPAID", "PAID"]),
});

export type PurchaseBill = z.infer<typeof purchaseBillSchema>;
export const purchaseBillsSchema = z.array(purchaseBillSchema);

/**
 * The arithmetic of one bill, in one place.
 *
 * Under reverse charge the GST is **not** paid to the vendor — the buyer remits
 * it directly — so it must not appear in what the vendor is owed. Adding it
 * there is how a vendor gets overpaid by 18% and the liability still shows up
 * on the return.
 */
export function billTotals(input: {
  taxablePaise: number;
  gstPercent: number;
  reverseCharge: boolean;
  tdsPaise: number;
}): { gstPaise: number; grossPaise: number; payablePaise: number } {
  const gstPaise = Math.round((input.taxablePaise * input.gstPercent) / 100);
  const grossPaise = input.reverseCharge
    ? input.taxablePaise
    : input.taxablePaise + gstPaise;
  return {
    gstPaise,
    grossPaise,
    payablePaise: grossPaise - input.tdsPaise,
  };
}

/** Days since a bill was dated, for FR-905's clock. */
export function daysSince(billDateIso: string, now: Date): number {
  const then = new Date(`${billDateIso}T00:00:00`);
  if (Number.isNaN(then.getTime())) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - then.getTime()) / 86_400_000),
  );
}

/**
 * The §43B(h) position for a recorded bill — FR-905, now on real data.
 *
 * Deliberately mirrors `money.ts`'s `Countdown` union: "lapsed" is a different
 * shape from "counting" because paying today still saves the deduction in one
 * case and cannot in the other.
 */
export type BillClock =
  | { kind: "counting"; day: number; limit: 15 | 45; daysLeft: number }
  | { kind: "lapsed"; day: number; limit: 15 | 45 }
  | { kind: "not_applicable"; reason: string }
  | { kind: "paid" };

export function clockFor(
  bill: PurchaseBill,
  vendor: Vendor,
  now: Date,
): BillClock {
  if (bill.status === "PAID") return { kind: "paid" };

  const msmed = msmedApplies(vendor);
  if (!msmed.applies) {
    return { kind: "not_applicable", reason: msmed.reason };
  }

  const day = daysSince(bill.billDate, now);
  if (day > msmed.limitDays) {
    return { kind: "lapsed", day, limit: msmed.limitDays };
  }
  return { kind: "counting", day, limit: msmed.limitDays, daysLeft: msmed.limitDays - day };
}

/** Money whose deduction is still savable — never including what is already lost. */
export function deductionAtRiskPaise(
  bills: readonly PurchaseBill[],
  vendors: readonly Vendor[],
  now: Date,
): number {
  return bills.reduce((sum, bill) => {
    const vendor = vendors.find((entry) => entry.id === bill.vendorId);
    if (!vendor) return sum;
    const clock = clockFor(bill, vendor, now);
    return clock.kind === "counting" ? sum + bill.taxablePaise : sum;
  }, 0);
}

/** Deductions already gone for the year — stated separately, because they are. */
export function deductionLostPaise(
  bills: readonly PurchaseBill[],
  vendors: readonly Vendor[],
  now: Date,
): number {
  return bills.reduce((sum, bill) => {
    const vendor = vendors.find((entry) => entry.id === bill.vendorId);
    if (!vendor) return sum;
    return clockFor(bill, vendor, now).kind === "lapsed"
      ? sum + bill.taxablePaise
      : sum;
  }, 0);
}
