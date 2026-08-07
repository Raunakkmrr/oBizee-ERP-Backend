import { STATE_BY_CODE } from "./states.ts";
/**
 * GST derivation and invoice rounding — FR-802, FR-806, FR-812.
 *
 * These are pure functions because they are the part of the product that must
 * be *provably* right. §6.11.2 calls the place-of-supply derivation "the single
 * most valuable element in the billing module":
 *
 * > "Charging CGST+SGST where IGST was due is the commonest and most expensive
 * > GST error a small service firm makes, invisible until a notice arrives, and
 * > no incumbent tool explains its reasoning."
 *
 * So the derivation returns its **reasoning as a sentence**, not just a result —
 * the screen renders that sentence verbatim, and a user who disagrees with the
 * outcome can see exactly which fact produced it.
 */

/** Indian state codes that appear in a GSTIN's first two digits. */
/**
 * Every GST state code, not the six this file used to carry.
 *
 * The old table held Delhi, Gujarat, Maharashtra, Karnataka, Tamil Nadu and
 * Telangana, so a site in Punjab rendered "State 03" on its own invoice — on
 * the very line FR-802 exists to make readable. Re-exported from the PIN module
 * so there is one list, and adding a state cannot leave the two disagreeing.
 */
export const STATE_NAMES: Record<string, string> = STATE_BY_CODE;

export type TaxHead = "CGST_SGST" | "IGST";

export type Derivation = {
  head: TaxHead;
  /** Rendered verbatim on the invoice — FR-802's "plain-language derivation". */
  explanation: string;
  siteState: string;
  supplierState: string;
};

/**
 * Place of supply for a service — FR-802.
 *
 * For services related to immovable property (which covers maintenance and
 * repair of a building or equipment affixed to it) the place of supply is the
 * **location of the property**, under §12 of the IGST Act. So the comparison is
 * always *site state* against *the supplier's GSTIN state* — not the customer's
 * billing address, which is the mistake this function exists to prevent.
 */
export function derivePlaceOfSupply(
  siteStateCode: string,
  supplierStateCode: string,
): Derivation {
  const siteState = STATE_NAMES[siteStateCode] ?? `State ${siteStateCode}`;
  const supplierState =
    STATE_NAMES[supplierStateCode] ?? `State ${supplierStateCode}`;
  const sameState = siteStateCode === supplierStateCode;

  return {
    head: sameState ? "CGST_SGST" : "IGST",
    explanation: sameState
      ? `Site in ${siteState} · your GSTIN in ${siteState} (${supplierStateCode}) → CGST + SGST`
      : `Site in ${siteState} (${siteStateCode}) · your GSTIN in ${supplierState} (${supplierStateCode}) → IGST`,
    siteState,
    supplierState,
  };
}

export type InvoiceLine = {
  description: string;
  /** SAC for services, HSN for goods — the same column, labelled `SAC/HSN`. */
  code: string;
  kind: "service" | "goods";
  qty: number;
  ratePaise: number;
  /** Slab in whole percent: 0, 5, 18 or 40 (FR-804, GST 2.0). */
  ratePercent: number;
};

export type InvoiceTotals = {
  taxablePaise: number;
  /** Present when the head is CGST+SGST. */
  cgstPaise: number | null;
  sgstPaise: number | null;
  /** Present when the head is IGST. */
  igstPaise: number | null;
  totalTaxPaise: number;
  /** Explicit line, at most ±₹0.50 (FR-812). */
  roundOffPaise: number;
  grandTotalPaise: number;
};

const lineAmount = (line: InvoiceLine) => line.qty * line.ratePaise;

/**
 * FR-812's rounding rule, implemented **once**.
 *
 * Three properties the spec demands, and which the tests pin:
 *
 * 1. **Tax is computed in paise per line**, and the invoice's total tax is the
 *    sum of line taxes — not a percentage of the summed taxable value, which
 *    rounds differently.
 * 2. **`cgst = floor(total_tax / 2)`, `sgst = total_tax − cgst`**, so no paisa
 *    is created or destroyed by the split.
 * 3. **The grand total is rounded to the nearest rupee** with the difference as
 *    an explicit `Round off` line of at most ±₹0.50, and *"the sum of all line
 *    taxes plus the round-off equals the printed grand total exactly, every
 *    time."*
 */
export function computeTotals(
  lines: InvoiceLine[],
  head: TaxHead,
): InvoiceTotals {
  const taxable = lines.reduce((sum, line) => sum + lineAmount(line), 0);

  // Per line, in paise. Rounded half-up at the line, which is where the
  // statute applies the rate.
  const totalTax = lines.reduce(
    (sum, line) =>
      sum + Math.round((lineAmount(line) * line.ratePercent) / 100),
    0,
  );

  let cgst: number | null = null;
  let sgst: number | null = null;
  let igst: number | null = null;

  if (head === "CGST_SGST") {
    // floor + remainder, so the two halves always sum to the whole.
    cgst = Math.floor(totalTax / 2);
    sgst = totalTax - cgst;
  } else {
    igst = totalTax;
  }

  const beforeRounding = taxable + totalTax;
  // Nearest rupee = nearest 100 paise.
  const grandTotal = Math.round(beforeRounding / 100) * 100;
  const roundOff = grandTotal - beforeRounding;

  return {
    taxablePaise: taxable,
    cgstPaise: cgst === null ? null : cgst,
    sgstPaise: sgst === null ? null : sgst,
    igstPaise: igst === null ? null : igst,
    totalTaxPaise: totalTax,
    roundOffPaise: roundOff,
    grandTotalPaise: grandTotal,
  };
}

/**
 * HSN/SAC digit count follows turnover — 4 digits at AATO ≤ ₹5 crore, 6 above
 * (FR-803, §12.3). Shown **as emitted**, so the CA can verify without opening a
 * return.
 */
export function codeForAato(code: string, aatoPaise: number): string {
  const THRESHOLD = 5_00_00_000_00; // ₹5 crore in paise
  const digits = aatoPaise > THRESHOLD ? 6 : 4;
  return code.slice(0, digits);
}


/* ------------------------------------------------- FR-806 composite supply */

/**
 * Whether an invoice is mixing goods and services in a way that needs a look.
 *
 * §8 of the CGST Act: where goods and services are **naturally bundled** and
 * supplied together in the ordinary course of business, the whole supply takes
 * the rate of the *principal* supply — a composite supply. Where they are not
 * naturally bundled, each line stands on its own rate.
 *
 * **Advisory, never blocking**, exactly as FR-806 requires. Which of the two an
 * AC service with a replaced capacitor is depends on facts the software does
 * not have — the contract, the way it was sold, what the customer agreed. A
 * product that decided this silently would be putting a tax position in a
 * taxpayer's name; one that refused to file until it was answered would stop
 * work over a question that is usually obvious to the person raising it.
 */
export type SupplyAdvice =
  | { kind: "single_rate" }
  | {
      kind: "mixed";
      /** The rate the principal supply would carry if this is composite. */
      principalPercent: number;
      /** What the reader has to decide, in words. */
      question: string;
      rates: number[];
    };

export function adviseSupply(lines: readonly InvoiceLine[]): SupplyAdvice {
  const rates = [...new Set(lines.map((line) => line.ratePercent))].sort(
    (a, b) => a - b,
  );
  const hasGoods = lines.some((line) => line.kind === "goods");
  const hasService = lines.some((line) => line.kind === "service");

  // One rate, or one kind, needs no decision at all.
  if (rates.length <= 1 || !hasGoods || !hasService) return { kind: "single_rate" };

  // The principal supply is the one carrying the most value, which for a
  // service business is nearly always the labour.
  const byValue = new Map<number, number>();
  for (const line of lines) {
    const value = line.qty * line.ratePaise;
    byValue.set(line.ratePercent, (byValue.get(line.ratePercent) ?? 0) + value);
  }
  // `noUncheckedIndexedAccess` is on here and was not in the web app. The
  // guard above already proves the map is non-empty; this keeps the compiler
  // agreeing rather than asserting past it.
  const ranked = [...byValue.entries()].sort((a, b) => b[1] - a[1]);
  const principalPercent = ranked[0]?.[0] ?? 0;

  return {
    kind: "mixed",
    principalPercent,
    rates,
    question:
      "Goods and services at different rates on one invoice. If they were naturally bundled and sold as one job, this is a composite supply and the whole invoice takes the principal rate. If they were sold separately, leave the lines as they are.",
  };
}
