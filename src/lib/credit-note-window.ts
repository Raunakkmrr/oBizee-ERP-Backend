/**
 * How long a credit note may still be raised against an invoice — §34(2).
 *
 * **The rule.** A credit note must be issued by **30 November following the end
 * of the financial year the supply falls in**, *or* the date the annual return
 * for that year was filed, **whichever is earlier**. After that the output tax
 * is permanently sunk: there is no bad-debt relief under GST, so an invoice
 * that is never going to be paid and never credited in time is money the firm
 * has given the government for revenue it never saw.
 *
 * **Why the annual return matters here, and only for firms this size.** GSTR-9
 * is optional below ₹2 crore turnover and mandatory above it. A firm above the
 * line whose CA files in September has its credit-note window shut in
 * September — two months earlier than the statute's outside date. So a
 * hardcoded 30 November is wrong for exactly the firms that need this most, and
 * being well-organised makes it worse.
 *
 * `gstr9FiledOn` is null when nobody has told us. That is not the same as "not
 * filed", and the caller is expected to say which it is rather than let the
 * reader assume — see `assumed` on the result.
 *
 * ⚠️ Not tax advice. The CA confirms the deadline for the firm's own filings
 * before anything is decided on it.
 */

export type CreditNoteWindow = {
  /** `2027-11-30` — the last day a note may be issued. */
  readonly deadline: string;
  /** Which financial year the supply fell in. `2026` means 2026-27. */
  readonly financialYear: number;
  /**
   * True when the annual-return date is unknown, so the statutory outside date
   * is being used. The screen must say so: a firm that files early has less
   * time than this, and presenting the assumption as a fact is how somebody
   * misses it by six weeks.
   */
  readonly assumed: boolean;
  readonly daysLeft: number;
  readonly closed: boolean;
};

/** 1 April boundary — 2026 covers April 2026 to March 2027. */
export function financialYearOf(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return 0;
  return m >= 4 ? y : y - 1;
}

function daysBetween(fromIso: string, toIso: string): number {
  const [ay, am, ad] = fromIso.split("-").map(Number);
  const [by, bm, bd] = toIso.split("-").map(Number);
  const a = Date.UTC(ay!, am! - 1, ad!);
  const b = Date.UTC(by!, bm! - 1, bd!);
  return Math.round((b - a) / 86_400_000);
}

export function creditNoteWindow(input: {
  /** The invoice's issue date — the supply's year is taken from this. */
  invoiceIssueDate: string;
  /** When the annual return for that year was filed, if anybody has said. */
  gstr9FiledOn?: string | null;
  /** Passed rather than read, so the whole rule is testable. */
  today: string;
}): CreditNoteWindow {
  const financialYear = financialYearOf(input.invoiceIssueDate);
  // 30 November following the END of that year: FY 2026-27 ends 31 Mar 2027,
  // so the outside date is 30 Nov 2027.
  const statutory = `${financialYear + 1}-11-30`;

  /*
    The earlier of the two, and only when the filing date is actually known.

    A filing date *after* the statutory date does not extend anything — the
    statute is an outside limit, not a race — so `min` is right in both
    directions.
  */
  const filed = input.gstr9FiledOn ?? null;
  const deadline = filed && filed < statutory ? filed : statutory;

  const daysLeft = daysBetween(input.today, deadline);

  return {
    deadline,
    financialYear,
    assumed: filed === null,
    daysLeft,
    // The deadline is the last day it may be issued, so it closes after it.
    closed: daysLeft < 0,
  };
}

/** Amber at ninety days: a negotiation that has already run months needs room. */
export const WINDOW_WARNING_DAYS = 90;
