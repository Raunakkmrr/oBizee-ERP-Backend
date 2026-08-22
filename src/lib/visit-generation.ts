/**
 * Putting a contract's due visits on the board.
 *
 * **Why this is a function and not a route handler.** The logic lived inside
 * `POST /contracts/:id/generate-visits`, so the only thing that could ever call
 * it was a person pressing "Put 1 on the board". The contracts screen showed
 * that button on three of four contracts — the system knew the visits were due
 * and waited to be told — and in a business where an unperformed visit is an
 * uninvoiced one, that button is the manual remembering the product exists to
 * remove.
 *
 * Extracted unchanged so the button and the nightly run are the same code. Two
 * implementations of "which visits are due" would eventually disagree, and the
 * one nobody watches would be the wrong one.
 *
 * **Idempotent through `visitKey`**, which is why it is safe to run every night
 * against every contract: a visit already on the board is skipped, not doubled.
 */
import { and, eq, lte, gte, or, isNull } from "drizzle-orm";

import { db } from "../db/client.ts";
import { branches, contractSchedules, contracts, jobs } from "../db/schema.ts";
import { formatNumber, nextInSeries } from "./series.ts";
import { VISITS_PER_YEAR, isoDay, visitSchedule, type Recurrence } from "./visits.ts";

export type GeneratedVisit = { id: string; jobNumber: string; scheduledDate: string | null };

/**
 * Generate for one contract.
 *
 * `fallbackBranchId` is the caller's own branch, used when the contract does
 * not name one — a route has the signed-in user's, the nightly run does not and
 * passes null, in which case a contract without a branch is skipped rather than
 * guessed at.
 */
export async function generateVisitsFor(
  tenantId: string,
  contractId: string,
  fallbackBranchId: string | null,
  now = new Date(),
): Promise<GeneratedVisit[]> {
  const [contract] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.tenantId, tenantId)))
    .limit(1);
  if (!contract?.siteId) return [];

  const branchId = contract.branchId ?? fallbackBranchId;
  if (!branchId) return [];

  const schedules = await db
    .select()
    .from(contractSchedules)
    .where(eq(contractSchedules.contractId, contractId));
  if (schedules.length === 0) return [];

  const existing = await db
    .select({ visitKey: jobs.visitKey })
    .from(jobs)
    .where(eq(jobs.tenantId, tenantId));
  const taken = new Set(existing.map((j) => j.visitKey).filter(Boolean));

  const [branch] = await db
    .select({ prefix: branches.jobSeriesPrefix })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);

  /*
    What one visit is worth — but only when the visit is the thing being billed.

    Under `PER_VISIT` the invoice is raised against the job itself, so a job
    with no value of its own leaves the biller with nothing to bill. Under every
    other frequency the money lives on the billing period, and pricing the visit
    too would offer the same rupees twice.
  */
  const annualVisits = schedules.reduce(
    (sum, s) => sum + VISITS_PER_YEAR[s.recurrence as Recurrence],
    0,
  );
  const perVisitPaise =
    contract.billing === "PER_VISIT" && annualVisits > 0
      ? Math.round(contract.annualValuePaise / annualVisits)
      : null;

  const start = new Date(`${contract.startDate}T00:00:00`);
  const created: GeneratedVisit[] = [];

  for (const schedule of schedules) {
    const planned = visitSchedule(
      schedule.id,
      schedule.recurrence as Recurrence,
      schedule.anchorDay,
      schedule.visitsCommitted,
      start,
      now,
    );
    for (const visit of planned) {
      if (taken.has(visit.key)) continue;
      const sequence = await nextInSeries(tenantId, branchId, "job", visit.on);
      const [job] = await db
        .insert(jobs)
        .values({
          tenantId,
          branchId,
          jobNumber: formatNumber("job", branch?.prefix ?? "J", sequence, visit.on),
          customerId: contract.customerId,
          siteId: contract.siteId,
          contractScheduleId: schedule.id,
          visitKey: visit.key,
          visitNumber: visit.number,
          visitOf: visit.of,
          serviceType: schedule.scope,
          valuePaise: perVisitPaise,
          scheduledDate: isoDay(visit.on),
          // A scheduled visit carries the slot promise, not a timestamp nobody
          // agreed to (FR-203).
          slot: "9-1",
          status: "CREATED",
        })
        .returning({
          id: jobs.id,
          jobNumber: jobs.jobNumber,
          scheduledDate: jobs.scheduledDate,
        });
      if (job) created.push(job);
    }
  }

  return created;
}

/**
 * Roll every live contract forward. The nightly run's first act.
 *
 * "Live" is start ≤ today ≤ end. A contract that has not begun has no visits to
 * place, and one that has ended must not quietly grow new ones — the renewal is
 * a conversation somebody has, not a job the scheduler invents.
 */
export async function generateDueVisits(
  tenantId: string,
  today: string,
  now = new Date(),
): Promise<{ contracts: number; created: number }> {
  const live = await db
    .select({ id: contracts.id, branchId: contracts.branchId })
    .from(contracts)
    .where(
      and(
        eq(contracts.tenantId, tenantId),
        lte(contracts.startDate, today),
        or(isNull(contracts.endDate), gte(contracts.endDate, today)),
      ),
    );

  let created = 0;
  for (const contract of live) {
    created += (await generateVisitsFor(tenantId, contract.id, contract.branchId, now)).length;
  }
  return { contracts: live.length, created };
}
