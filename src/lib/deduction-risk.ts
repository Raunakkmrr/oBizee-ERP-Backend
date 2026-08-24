import { msmedApplies } from "./purchases.ts";
import { expenseOnUncollected } from "./receivables.ts";

/**
 * When a customer's own tax deduction turns against them — §37(2)(g).
 *
 * **The other side of the clock `purchases.ts` already runs.** That module
 * asks whether *this firm*, buying from a vendor, must pay within 15 or 45
 * days of the bill or lose the deduction for the whole expense — §15 MSMED
 * Act for the payment obligation, §37(2)(g) of the Income-tax Act 2025
 * (successor to §43B(h) of the 1961 Act, in force from 1 April 2026, which is
 * now) for the consequence.
 *
 * The same rule runs the other way whenever the *firm* is the registered
 * micro or small enterprise: a corporate customer who pays this firm late
 * loses their own deduction for the whole bill, not just the part still
 * outstanding when the clock runs out. That is worth telling them, in exactly
 * the spirit `itc-reversal.ts` tells a registered customer about Rule 37 — a
 * fact about their books, not a request for a favour.
 *
 * **It only exists once the firm has said what it is registered as.**
 * `msmedApplies` already refuses to guess for a vendor; the same refusal
 * applies here; `UNVERIFIED` — the honest default — means this lever is
 * unavailable, not absent.
 *
 * ⚠️ Our reading of the rule, not advice — on the CA's checklist to confirm,
 * same as Rule 37.
 */

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const [ay, am, ad] = fromIso.split("-").map(Number);
  const [by, bm, bd] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

export type TenantMsmedFacts = {
  msmeClass: "MICRO" | "SMALL" | "MEDIUM" | "NOT_REGISTERED" | "UNVERIFIED";
  udyamActivity: "MANUFACTURING" | "SERVICE" | "TRADING" | null;
};

export type DeductionRisk =
  /** The firm's own registration does not attract the MSMED timeline at all. */
  | { readonly applies: false; readonly reason: string }
  /** Nothing outstanding, so nothing is at risk. */
  | { readonly applies: false; readonly reason: "settled" }
  | {
      readonly applies: true;
      readonly limitDays: 15 | 45;
      /** `2026-09-21` — 15 or 45 days after the invoice, whichever applies. */
      readonly lapsesOn: string;
      readonly daysUntil: number;
      /** True once the date has passed: the deduction is already gone. */
      readonly passed: boolean;
      /** The taxable value the customer stands to lose the deduction on. */
      readonly deductionAtRiskPaise: number;
    };

export function customerDeductionRisk(input: {
  invoiceIssueDate: string;
  outstandingPaise: number;
  grandTotalPaise: number;
  taxableValuePaise: number;
  tenant: TenantMsmedFacts;
  customerHasWrittenAgreement: boolean;
  today: string;
}): DeductionRisk {
  if (input.outstandingPaise <= 0) return { applies: false, reason: "settled" };

  const msmed = msmedApplies({
    msmeClass: input.tenant.msmeClass,
    udyamActivity: input.tenant.udyamActivity,
    hasWrittenAgreement: input.customerHasWrittenAgreement,
  });
  if (!msmed.applies) return { applies: false, reason: msmed.reason };

  const lapsesOn = addDays(input.invoiceIssueDate, msmed.limitDays);
  const daysUntil = daysBetween(input.today, lapsesOn);

  return {
    applies: true,
    limitDays: msmed.limitDays,
    lapsesOn,
    daysUntil,
    passed: daysUntil < 0,
    deductionAtRiskPaise: expenseOnUncollected({
      grandTotalPaise: input.grandTotalPaise,
      taxableValuePaise: input.taxableValuePaise,
      outstandingPaise: input.outstandingPaise,
    }),
  };
}

/**
 * The sentence to send them — about their books, not ours.
 *
 * Mirrors `itcChaseMessage`: a statement of consequence in the recipient's own
 * ledger, not a request. `limitDays` names itself in the message because 15
 * and 45 read as different urgencies and the reader should not have to guess
 * which applies to them.
 */
export function deductionChaseMessage(input: {
  customer: string;
  invoiceNumber: string;
  invoiceDateWord: string;
  risk: Extract<DeductionRisk, { applies: true }>;
  firmName: string;
}): string {
  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
  const { risk } = input;

  if (risk.passed) {
    return (
      `Dear ${input.customer}, invoice ${input.invoiceNumber} dated ${input.invoiceDateWord} ` +
      `has been outstanding for more than ${risk.limitDays} days. Under §37(2)(g) the deduction ` +
      `for ${rupees(risk.deductionAtRiskPaise)} claimed against it is now disallowed for the ` +
      `year, with no way to recover it by paying later. Please let us know when we can expect it. ` +
      `— ${input.firmName}`
    );
  }

  return (
    `Dear ${input.customer}, invoice ${input.invoiceNumber} dated ${input.invoiceDateWord} ` +
    `is still open. Under §37(2)(g), if it remains unpaid on ${risk.lapsesOn} — ${risk.limitDays} ` +
    `days from the invoice — the deduction for ${rupees(risk.deductionAtRiskPaise)} claimed ` +
    `against it is disallowed for the year. We would rather you kept it. ` +
    `— ${input.firmName}`
  );
}
