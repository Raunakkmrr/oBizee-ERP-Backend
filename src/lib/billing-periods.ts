/**
 * A contract's billing periods, and which of them the work has earned.
 *
 * **The rule Raunak asked for.** A visit is booked, given a date, given a
 * technician, and done — and *then* that month's invoice becomes available.
 * Billing on a calendar alone bills for work that has not happened; billing per
 * visit contradicts FR-505, which is explicit that the billing frequency is
 * independent of the visit schedule. So the unit is the **billing period**, and
 * a period is earned when the visits falling inside it are complete.
 *
 * **Why "or the period has closed".** A quarterly-billed contract with monthly
 * visits has three visits in a period; if one is cancelled or the customer was
 * unavailable all quarter, waiting for a visit that will never happen would
 * mean never billing a contract the customer is still under. Once the period
 * has ended it is billable regardless — the firm sold a period of cover, not a
 * set of visits, and cover was available throughout.
 *
 * **Why nothing here writes anything.** FR-805 makes an invoice immutable once
 * issued, and a legally-numbered document raised by a background rule is a
 * mistake nobody can take back. This module answers *what could be billed*. A
 * person decides that it is.
 */

export type BillingFrequency =
  | "UPFRONT_ANNUAL"
  | "HALF_YEARLY"
  | "QUARTERLY"
  | "MONTHLY"
  | "PER_VISIT";

export type Period = {
  /** Which instalment of the contract this is, 1-based — what FR-811 numbers. */
  number: number;
  /** `2026-08-01` — inclusive. */
  start: string;
  /** `2026-08-31` — inclusive, so a date comparison needs no off-by-one care. */
  end: string;
  /** What this slice is worth, in paise. */
  valuePaise: number;
};

/** How many periods a year of this contract has. `null` means "not on a cycle". */
const PERIODS_PER_YEAR: Record<BillingFrequency, number | null> = {
  MONTHLY: 12,
  QUARTERLY: 4,
  HALF_YEARLY: 2,
  UPFRONT_ANNUAL: 1,
  // Billed against the visit itself, so it has no period at all — see below.
  PER_VISIT: null,
};

function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  // Day 1 of the month, shifted — contract periods start on the contract's own
  // day of the month, so the day is carried and clamped by the Date itself.
  const at = new Date(Date.UTC(y, m - 1 + months, d));
  return at.toISOString().slice(0, 10);
}

function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const at = new Date(Date.UTC(y, m - 1, d - 1));
  return at.toISOString().slice(0, 10);
}

/**
 * Every billing period of a contract, from its start to its end.
 *
 * The last period is clipped to the contract's end date rather than running
 * past it, because a contract that ends mid-quarter did not sell that quarter.
 * Its value is *not* pro-rated: a firm that agreed twelve payments takes twelve
 * payments, and quietly shaving the last one is a change to the deal.
 */
export function periodsOf(contract: {
  billing: BillingFrequency;
  startDate: string;
  endDate: string;
  annualValuePaise: number;
}): Period[] {
  const count = PERIODS_PER_YEAR[contract.billing];
  if (count === null) return [];

  const monthsEach = 12 / count;
  const valuePaise = Math.round(contract.annualValuePaise / count);

  const periods: Period[] = [];
  let start = contract.startDate;

  /*
    Bounded by the contract's end, not by the count.

    A two-year contract has twenty-four monthly periods, not twelve, and a
    loop that trusted `count` would stop halfway through and quietly declare
    the second year unbillable.
  */
  while (start <= contract.endDate && periods.length < 240) {
    const nextStart = addMonths(start, monthsEach);
    const end = dayBefore(nextStart);
    periods.push({
      number: periods.length + 1,
      start,
      end: end > contract.endDate ? contract.endDate : end,
      valuePaise,
    });
    start = nextStart;
  }

  return periods;
}

/** Work that has happened. Anything else is still owed. */
const DONE = new Set(["WORK_DONE", "SIGNED_OFF"]);

/** Work that will never happen, so it cannot hold a period open. */
const ABANDONED = new Set(["CANCELLED"]);

export type PeriodState = {
  period: Period;
  /** Visits scheduled inside this period. */
  visits: number;
  visitsDone: number;
  /**
   * Why it is billable, in the words the screen shows.
   *
   * Stated rather than implied because the two reasons mean different things
   * to whoever is about to raise the bill: work delivered is a bill the
   * customer expects, and a closed period with visits missed is a conversation
   * to have before sending one.
   */
  reason: "visits_complete" | "period_closed";
};

/**
 * Which periods have been earned and not yet billed.
 *
 * `today` is passed rather than read so this is a pure function — the whole
 * rule is testable without waiting for a month to pass.
 */
export function billablePeriods(
  contract: {
    billing: BillingFrequency;
    startDate: string;
    endDate: string;
    annualValuePaise: number;
  },
  visits: { scheduledDate: string | null; status: string }[],
  /**
   * What has already been billed, named two ways.
   *
   * **Both, because the register holds both.** `period_start` arrived with this
   * feature; every contract invoice raised before it has only an instalment
   * number. Checking periods alone declares those instalments unbilled and
   * offers to raise them again — which the older unique index then refuses with
   * a 409, after somebody has already pressed the button.
   */
  billed: {
    periodStarts: ReadonlySet<string>;
    instalments: ReadonlySet<number>;
  },
  today: string,
): PeriodState[] {
  const earned: PeriodState[] = [];

  for (const period of periodsOf(contract)) {
    if (billed.periodStarts.has(period.start)) continue;
    if (billed.instalments.has(period.number)) continue;

    // A period that has not started cannot have been earned by anything.
    if (period.start > today) continue;

    const inside = visits.filter(
      (visit) =>
        visit.scheduledDate !== null &&
        visit.scheduledDate >= period.start &&
        visit.scheduledDate <= period.end,
    );

    const live = inside.filter((visit) => !ABANDONED.has(visit.status));
    const done = live.filter((visit) => DONE.has(visit.status));

    /*
      A period with no visits in it is not "complete" — it is a period whose
      visits were never generated. Billing it on those grounds would turn a
      forgotten schedule into revenue, so it waits for the period to close like
      any other.
    */
    const allDone = live.length > 0 && done.length === live.length;
    const closed = period.end < today;

    if (!allDone && !closed) continue;

    earned.push({
      period,
      visits: live.length,
      visitsDone: done.length,
      reason: allDone ? "visits_complete" : "period_closed",
    });
  }

  return earned;
}
