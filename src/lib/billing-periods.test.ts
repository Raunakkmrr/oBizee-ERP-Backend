import { describe, expect, it } from "vitest";
import { billablePeriods, periodsOf } from "./billing-periods.ts";

/**
 * The rule that decides when money may be asked for.
 *
 * Tested as a pure function because every interesting case is about a date
 * that has not arrived yet, and none of them should need a clock to reach.
 */

const MONTHLY_AMC = {
  billing: "MONTHLY" as const,
  startDate: "2026-08-11",
  endDate: "2027-08-10",
  annualValuePaise: 14_400_00,
};

const QUARTERLY_AMC = {
  billing: "QUARTERLY" as const,
  startDate: "2026-04-01",
  endDate: "2027-03-31",
  annualValuePaise: 48_000_00,
};

describe("periodsOf", () => {
  it("splits a year of monthly billing into twelve periods on the contract's own day", () => {
    const periods = periodsOf(MONTHLY_AMC);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({ start: "2026-08-11", end: "2026-09-10" });
    expect(periods[11]).toMatchObject({ start: "2027-07-11", end: "2027-08-10" });
  });

  it("divides the annual value, so twelve months of a 14,400 AMC are 1,200 each", () => {
    const periods = periodsOf(MONTHLY_AMC);
    expect(periods.every((p) => p.valuePaise === 1_200_00)).toBe(true);
  });

  it("clips the last period to the contract's end rather than running past it", () => {
    const periods = periodsOf({ ...QUARTERLY_AMC, endDate: "2027-02-14" });
    expect(periods.at(-1)?.end).toBe("2027-02-14");
  });

  it("carries a multi-year contract past twelve periods instead of stopping at a year", () => {
    const periods = periodsOf({ ...MONTHLY_AMC, endDate: "2028-08-10" });
    expect(periods).toHaveLength(24);
  });

  it("gives a per-visit contract no periods at all, because it has none", () => {
    expect(periodsOf({ ...MONTHLY_AMC, billing: "PER_VISIT" })).toEqual([]);
  });
});

describe("billablePeriods", () => {
  const visitOn = (scheduledDate: string, status: string) => ({ scheduledDate, status });

  it("releases the period once every visit inside it is done", () => {
    const due = billablePeriods(
      MONTHLY_AMC,
      [visitOn("2026-08-15", "WORK_DONE")],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-08-16",
    );
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      reason: "visits_complete",
      visits: 1,
      visitsDone: 1,
    });
    expect(due[0]?.period.valuePaise).toBe(1_200_00);
  });

  it("holds the period back while a visit inside it is still outstanding", () => {
    const due = billablePeriods(
      QUARTERLY_AMC,
      [
        visitOn("2026-04-15", "SIGNED_OFF"),
        visitOn("2026-05-15", "SIGNED_OFF"),
        visitOn("2026-06-15", "CREATED"),
      ],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-06-20",
    );
    expect(due).toEqual([]);
  });

  it("ignores a cancelled visit, so one abandoned call cannot hold a quarter open", () => {
    const due = billablePeriods(
      QUARTERLY_AMC,
      [
        visitOn("2026-04-15", "SIGNED_OFF"),
        visitOn("2026-05-15", "SIGNED_OFF"),
        visitOn("2026-06-15", "CANCELLED"),
      ],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-06-20",
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("visits_complete");
  });

  it("releases a closed period even when its visits never happened", () => {
    // The firm sold a period of cover, and cover was available throughout.
    const due = billablePeriods(
      MONTHLY_AMC,
      [visitOn("2026-08-15", "CUSTOMER_UNAVAILABLE")],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-09-20",
    );
    expect(due[0]).toMatchObject({ reason: "period_closed", visitsDone: 0 });
  });

  it("does not bill a period that has no visits until it has closed", () => {
    // Otherwise a schedule nobody generated would silently become revenue.
    const open = billablePeriods(
      MONTHLY_AMC,
      [],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-08-20",
    );
    expect(open).toEqual([]);

    const closed = billablePeriods(
      MONTHLY_AMC,
      [],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-09-20",
    );
    expect(closed[0]).toMatchObject({ reason: "period_closed", visits: 0 });
  });

  it("never offers a period that has not started", () => {
    const due = billablePeriods(
      MONTHLY_AMC,
      [visitOn("2026-08-15", "WORK_DONE")],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-08-16",
    );
    expect(due.every((row) => row.period.start <= "2026-08-16")).toBe(true);
  });

  it("skips a period already billed under a legacy instalment number", () => {
    /*
      Every contract invoice raised before `period_start` existed carries only
      an instalment number. Matching on periods alone declared those unbilled
      and offered to raise them again — which the older unique index then
      refused with a 409, after the button had been pressed.
    */
    const due = billablePeriods(
      MONTHLY_AMC,
      [visitOn("2026-08-15", "WORK_DONE")],
      { periodStarts: new Set(), instalments: new Set([1]) },
      "2026-08-16",
    );
    expect(due).toEqual([]);
  });

  it("skips a period that has already been billed", () => {
    const due = billablePeriods(
      MONTHLY_AMC,
      [visitOn("2026-08-15", "WORK_DONE")],
      { periodStarts: new Set(["2026-08-11"]), instalments: new Set() },
      "2026-08-16",
    );
    expect(due).toEqual([]);
  });

  it("offers every earned period, oldest first, when several have gone unbilled", () => {
    const due = billablePeriods(
      MONTHLY_AMC,
      [
        visitOn("2026-08-15", "SIGNED_OFF"),
        visitOn("2026-09-15", "SIGNED_OFF"),
        visitOn("2026-10-15", "SIGNED_OFF"),
      ],
      { periodStarts: new Set(), instalments: new Set() },
      "2026-10-20",
    );
    expect(due.map((row) => row.period.start)).toEqual([
      "2026-08-11",
      "2026-09-11",
      "2026-10-11",
    ]);
  });
});
