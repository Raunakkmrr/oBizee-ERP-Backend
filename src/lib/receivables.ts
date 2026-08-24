/**
 * What is actually owed on an invoice.
 *
 * **Why this is one function and not six expressions.** The answer was written
 * out separately in `customers.ts`, `money.ts`, `invoices.ts`, `payments.ts`,
 * `home.ts` and `job-detail.ts`, and they had already drifted once: the
 * Customers screen counted cancelled and draft invoices as money owed while the
 * Money screen did not, so the same customer owed two different amounts
 * depending on which screen you opened.
 *
 * Credit notes make that worse, not better. Every one of those six places now
 * has a third term to subtract, and six copies of a three-term formula is six
 * chances to forget one — in the direction of chasing a customer for money they
 * no longer owe.
 *
 * ⚠️ Not tax advice. A credit note reduces the *receivable* the moment it is
 * issued, which is what this computes. Whether it reduces the *output tax*
 * depends on the customer accepting it in IMS (Rule 67B) — a different
 * question, answered by `imsState`, and one the CA signs off.
 */

/** Only an issued document charges or credits anybody. */
export const COUNTS_TOWARD_BALANCE = "ISSUED" as const;

export type BalanceInput = {
  /** The invoice's own total. */
  grandTotalPaise: number;
  /** Everything received against it. */
  paidPaise: number;
  /**
   * Credit notes raised against it — issued ones only.
   *
   * A draft credit note has promised the customer nothing and must not reduce
   * what they owe; a cancelled one never did.
   */
  creditedPaise: number;
};

/**
 * The balance, floored at zero.
 *
 * A payment cannot exceed what is owed and a credit note cannot exceed the
 * invoice, so this cannot go negative by accident.
 *
 * ⚠️ **It can go negative legitimately, and this hides it.** Crediting is capped
 * at the invoice's value, not at its *unpaid* part — deliberately, because a
 * customer who has paid in full can still be credited, and that is a refund.
 * When that happens the firm owes the customer money, and flooring at zero says
 * "settled" instead.
 *
 * Left as a floor rather than fixed here because a refund is a payment *out*,
 * and this product has no such document yet: reporting a negative receivable
 * would put money owed to a customer inside a total that means the opposite.
 * The gap is real and belongs on the roadmap next to the refund voucher, not
 * papered over with a minus sign.
 */
export function outstandingOf(input: BalanceInput): number {
  return Math.max(0, input.grandTotalPaise - input.paidPaise - input.creditedPaise);
}

/** Whether anything is still owed, in the words the screens use. */
export function isSettled(input: BalanceInput): boolean {
  return outstandingOf(input) === 0;
}

/**
 * How much of an invoice a credit note may still take.
 *
 * Credit notes cannot exceed the invoice between them: the total credited plus
 * this one has to stay within the document's own value, or the register is
 * claiming back more tax than it ever declared.
 */
export function creditableRemaining(input: {
  grandTotalPaise: number;
  creditedPaise: number;
}): number {
  return Math.max(0, input.grandTotalPaise - input.creditedPaise);
}

/**
 * How much GST has been paid on money that has not arrived.
 *
 * **The number Raunak asked about first**, and one nothing in the product could
 * answer: *"the company fills out the GST of the bills which are not yet
 * totally paid… paying for the money which never showed up."*
 *
 * The tax was paid in full when the invoice was issued — §13(2) makes the whole
 * liability fall due then, whatever has been collected. So the share of it
 * sitting against uncollected money is the tax apportioned to the outstanding
 * balance.
 *
 * **Apportioned, not "the tax on the unpaid part".** A part-payment is not
 * earmarked to particular lines; a customer paying ₹4,000 of ₹7,080 has paid
 * ₹4,000 of the whole thing, tax included. Treating the first rupees received
 * as taxable value and the last as tax — or the reverse — would be a fiction
 * either way, and would give a different answer depending on which.
 *
 * ⚠️ This is exposure, not a refund. Recovering it needs a credit note inside
 * the §34(2) window and the customer's acceptance under Rule 67B; where the
 * money is simply late rather than lost, the right answer is to collect it.
 * The CA confirms the treatment.
 */
export function taxOnUncollected(input: {
  grandTotalPaise: number;
  totalTaxPaise: number;
  outstandingPaise: number;
}): number {
  if (input.grandTotalPaise <= 0) return 0;
  const share = Math.min(1, input.outstandingPaise / input.grandTotalPaise);
  return Math.round(input.totalTaxPaise * share);
}
