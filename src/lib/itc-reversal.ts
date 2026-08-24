/**
 * When the customer's own input tax credit turns against them — Rule 37.
 *
 * **Why this is the strongest thing a small supplier has, and why nobody uses
 * it.** The second proviso to §16(2), read with Rule 37: a recipient who has
 * not paid the supplier within **180 days of the invoice date** must reverse
 * the input tax credit they claimed, **with interest**, and may only re-avail
 * it once they actually pay. It bites where the invoice is unpaid **wholly or
 * partly** — so a customer who paid half still has the other half's credit at
 * risk.
 *
 * That inverts the conversation. Today a corporate customer's slow payment
 * costs them nothing and costs the supplier the GST. At day 180 it costs *them*
 * the credit plus interest — and it is a fact about their own books, so their
 * own finance team will act on it. A dunning line that says "your ITC of ₹1,800
 * reverses on 14 October" is worth more than ten polite reminders.
 *
 * **It only exists for a registered customer.** Somebody with no GSTIN claimed
 * no credit and has none to reverse; showing them this would be both wrong and
 * embarrassing, so the caller must pass whether they are registered.
 *
 * ⚠️ Our reading of the rule, not advice — on the CA's checklist to confirm.
 */

/** The rule's own number. Not a policy, so it is not configurable. */
export const ITC_REVERSAL_DAYS = 180;

/** Amber inside a month: enough notice for an AP department to act on it. */
export const ITC_WARNING_DAYS = 30;

export type ItcReversal =
  /** No GSTIN, so no credit was claimed and none can be reversed. */
  | { readonly applies: false; readonly reason: "customer_not_registered" }
  /** Nothing outstanding, so nothing is at risk. */
  | { readonly applies: false; readonly reason: "settled" }
  | {
      readonly applies: true;
      /** `2027-02-13` — 180 days after the invoice. */
      readonly reversesOn: string;
      readonly daysUntil: number;
      /** True once the date has passed: the credit should already be reversed. */
      readonly passed: boolean;
      /**
       * What the customer stands to lose.
       *
       * The same apportionment as the firm's own exposure, and that is not a
       * coincidence: Rule 37 reverses the credit proportionate to the unpaid
       * amount, which is exactly the tax sitting against money not received.
       * One number, read from either side of the invoice.
       */
      readonly creditAtRiskPaise: number;
    };

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

export function itcReversal(input: {
  invoiceIssueDate: string;
  /** Null or empty when the customer is unregistered. */
  customerGstin: string | null;
  outstandingPaise: number;
  taxOnUncollectedPaise: number;
  today: string;
}): ItcReversal {
  if (!input.customerGstin) return { applies: false, reason: "customer_not_registered" };
  if (input.outstandingPaise <= 0) return { applies: false, reason: "settled" };

  const reversesOn = addDays(input.invoiceIssueDate, ITC_REVERSAL_DAYS);
  const daysUntil = daysBetween(input.today, reversesOn);

  return {
    applies: true,
    reversesOn,
    daysUntil,
    passed: daysUntil < 0,
    creditAtRiskPaise: input.taxOnUncollectedPaise,
  };
}

/**
 * The sentence to send them — about their books, not ours.
 *
 * A reminder that says "kindly release the payment" is asking a favour. This
 * states a consequence in the recipient's own ledger, which is what gets it
 * escalated past whoever reads the inbox.
 */
export function itcChaseMessage(input: {
  customer: string;
  invoiceNumber: string;
  invoiceDateWord: string;
  reversal: Extract<ItcReversal, { applies: true }>;
  firmName: string;
}): string {
  const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;
  const { reversal } = input;

  if (reversal.passed) {
    return (
      `Dear ${input.customer}, invoice ${input.invoiceNumber} dated ${input.invoiceDateWord} ` +
      `has been outstanding for more than 180 days. Under Rule 37 the input tax credit of ` +
      `${rupees(reversal.creditAtRiskPaise)} claimed on it is now reversible with interest, and ` +
      `can be re-availed once payment is made. Please let us know when we can expect it. ` +
      `— ${input.firmName}`
    );
  }

  return (
    `Dear ${input.customer}, invoice ${input.invoiceNumber} dated ${input.invoiceDateWord} ` +
    `is still open. Under Rule 37, if it remains unpaid on ${reversal.reversesOn} — 180 days from ` +
    `the invoice — the input tax credit of ${rupees(reversal.creditAtRiskPaise)} claimed on it ` +
    `has to be reversed with interest. We would rather you kept it. ` +
    `— ${input.firmName}`
  );
}
