
/**
 * Advances received, and the Receipt Voucher that has to accompany them —
 * FR-810.
 *
 * **The gap this closes.** An AMC billed `UPFRONT_ANNUAL` or `UPFRONT_HALF`
 * takes the customer's money before a single visit has happened. Under GST that
 * receipt is itself a taxable event for a *service*: tax falls due on receipt,
 * and §31(3)(d) requires a **Receipt Voucher** — its own sequential series,
 * not an invoice number — at the moment the money arrives. The advance is then
 * reported in GSTR-1 until an invoice adjusts it.
 *
 * The product already *said* this on the contract form. Nothing produced the
 * voucher, so the sentence was a warning about work the software left to the
 * accountant — which is the failure mode this module exists to remove.
 *
 * **Why the tax is back-calculated.** A customer paying "₹3,60,000 for the
 * year" pays a gross figure; they have not separately handed over the tax. So
 * the receipt is treated as inclusive and split, rather than grossed up — which
 * would collect tax the customer never sent and leave the ledger short.
 */

export const ADVANCE_STATUSES = ["OPEN", "ADJUSTED"] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** Structural, so a database row satisfies it without a mapping layer. */
export type Advance = {
  voucherNumber: string;
  receiptPaise: number;
  ratePercent: number;
  head: "CGST_SGST" | "IGST";
  status: "OPEN" | "ADJUSTED";
  receivedOn: string;
};

export type AdvanceTax = {
  /** The taxable value hiding inside the receipt. */
  taxablePaise: number;
  totalTaxPaise: number;
  cgstPaise: number | null;
  sgstPaise: number | null;
  igstPaise: number | null;
};

/**
 * Split a gross receipt into value and tax.
 *
 * The taxable value is rounded and the tax is taken as the remainder, so the
 * two always sum back to exactly what the customer paid — the same discipline
 * FR-812 imposes on an invoice, for the same reason.
 */
export function advanceTax(
  receiptPaise: number,
  ratePercent: number,
  head: "CGST_SGST" | "IGST",
): AdvanceTax {
  const taxablePaise = Math.round(
    (receiptPaise * 100) / (100 + ratePercent),
  );
  const totalTaxPaise = receiptPaise - taxablePaise;

  if (head === "IGST") {
    return {
      taxablePaise,
      totalTaxPaise,
      cgstPaise: null,
      sgstPaise: null,
      igstPaise: totalTaxPaise,
    };
  }

  // Halve, then give the odd paisa to CGST — never create or destroy one.
  const cgstPaise = Math.round(totalTaxPaise / 2);
  return {
    taxablePaise,
    totalTaxPaise,
    cgstPaise,
    sgstPaise: totalTaxPaise - cgstPaise,
    igstPaise: null,
  };
}

/**
 * `2026-04-18` as `18 Apr` — stored sortable, read as a date.
 *
 * The record keeps ISO because the list sorts on it; every other date in this
 * product is shown the way an Indian office writes one, and a raw ISO string in
 * the middle of that reads as a database leak.
 */
export function receivedWord(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/** `RV/26-27/0007` — financial year, 1 April boundary, its own counter. */
export function receiptVoucherNumber(seq: number, now: Date): string {
  const year = now.getFullYear();
  const startYear = now.getMonth() >= 3 ? year : year - 1;
  const label = `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
  return `RV/${label}/${String(seq).padStart(4, "0")}`;
}

/**
 * What still sits unadjusted, oldest first.
 *
 * Oldest first because an advance that has been open for months is the one
 * carrying tax already paid against a service still owed — the position an
 * auditor asks about.
 */
export function openAdvances(advances: readonly Advance[]): Advance[] {
  return advances
    .filter((advance) => advance.status === "OPEN")
    .slice()
    .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn));
}

/** Tax already paid on money for work not yet done. */
export function unadjustedTaxPaise(advances: readonly Advance[]): number {
  return openAdvances(advances).reduce(
    (sum, advance) =>
      sum + advanceTax(advance.receiptPaise, advance.ratePercent, advance.head).totalTaxPaise,
    0,
  );
}

/**
 * Adjust an open advance against an invoice.
 *
 * Returns the list unchanged when the advance is already adjusted — closing a
 * voucher twice would double-count the credit, and silently.
 */
export function adjustAdvance(
  advances: readonly Advance[],
  voucherNumber: string,
  invoiceNumber: string,
): Advance[] {
  return advances.map((advance) =>
    advance.voucherNumber === voucherNumber && advance.status === "OPEN"
      ? { ...advance, status: "ADJUSTED" as const, adjustedByInvoice: invoiceNumber }
      : advance,
  );
}

