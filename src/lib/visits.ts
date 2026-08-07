/**
 * When a contract's visits fall — FR-501, FR-502.
 *
 * Ported from `obez-erp-web/src/lib/data/contracts.ts`, which is where this
 * arithmetic was worked out and tested. Two properties matter and both are
 * easy to get subtly wrong:
 *
 * - **The anchor day is the promise.** A contract sold as "the 15th" means the
 *   15th. Day 31 in a 30-day month lands on the last day of *that* month and
 *   does not spill into the next — spilling puts a visit, and its invoice, in
 *   the wrong GST return period.
 * - **Alternate monthly is six visits, not twelve.** The pattern generic tools
 *   miss, and the one this market actually buys.
 */

export type Recurrence =
  | "WEEKLY" | "FORTNIGHTLY" | "MONTHLY" | "ALTERNATE_MONTHLY"
  | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";

const MONTHS: Partial<Record<Recurrence, number>> = {
  MONTHLY: 1, ALTERNATE_MONTHLY: 2, QUARTERLY: 3, HALF_YEARLY: 6, ANNUAL: 12,
};
const DAYS: Partial<Record<Recurrence, number>> = { WEEKLY: 7, FORTNIGHTLY: 14 };

export const VISITS_PER_YEAR: Record<Recurrence, number> = {
  WEEKLY: 52, FORTNIGHTLY: 26, MONTHLY: 12, ALTERNATE_MONTHLY: 6,
  QUARTERLY: 4, HALF_YEARLY: 2, ANNUAL: 1,
};

function addMonths(from: Date, months: number, anchorDay: number): Date {
  const target = new Date(from);
  target.setDate(1);
  target.setMonth(target.getMonth() + months);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(anchorDay, lastDay));
  return target;
}

export type PlannedVisit = {
  /** `schedule:n` — the idempotency key. Unique per tenant in the database. */
  key: string;
  number: number;
  of: number;
  on: Date;
};

export function visitSchedule(
  scheduleId: string,
  recurrence: Recurrence,
  anchorDay: number,
  visitsCommitted: number,
  startDate: Date,
  from: Date,
  horizonDays = 90,
): PlannedVisit[] {
  const until = new Date(from.getTime() + horizonDays * 86_400_000);
  const months = MONTHS[recurrence];
  const days = DAYS[recurrence];
  const planned: PlannedVisit[] = [];

  for (let n = 1; n <= visitsCommitted; n += 1) {
    const step = n - 1;
    const on = months
      ? addMonths(startDate, months * step, anchorDay)
      : days
        ? new Date(startDate.getTime() + days * step * 86_400_000)
        : null;
    if (!on) continue;
    if (on < from || on > until) continue;
    planned.push({ key: `${scheduleId}:${n}`, number: n, of: visitsCommitted, on });
  }

  return planned.sort((a, b) => a.on.getTime() - b.on.getTime());
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
