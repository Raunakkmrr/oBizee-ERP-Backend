import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, count, desc, eq, inArray, like } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  branches,
  contacts,
  contractSchedules,
  contracts,
  customers,
  jobs,
  leadActivities,
  leads,
  sites,
} from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { formatNumber, nextInSeries } from "../lib/series.ts";
import { VISITS_PER_YEAR, isoDay, visitSchedule, type Recurrence } from "../lib/visits.ts";
import { audit } from "../lib/audit.ts";
import { e164 } from "../lib/phone.ts";

/**
 * Contracts — FR-501, FR-502, FR-505, FR-1406.
 *
 * **How often someone visits and how often the customer is billed are two
 * separate axes.** FR-505 is explicit that monthly visits with one annual
 * invoice must not be forced into per-visit billing — it is the commonest
 * combination in this market, and generic tools conflate the two.
 *
 * FR-1406: a contract may carry several schedules, each with its own scope and
 * cadence. Six cassette ACs monthly and two chillers quarterly is one contract.
 */
export const contractRoutes = apiRouter();

const RECURRENCES = [
  "WEEKLY", "FORTNIGHTLY", "MONTHLY", "ALTERNATE_MONTHLY",
  "QUARTERLY", "HALF_YEARLY", "ANNUAL",
] as const;

/** Whole days between two dates, ignoring the time of day. */
function daysBetween(from: Date, to: Date): number {
  const day = 86_400_000;
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
    - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / day);
}

/**
 * Every contract, in the shape the contracts screen reads.
 *
 * **This endpoint used to return database rows**, and the screen never called
 * it — it answered `NO_API_IMPL:contracts.list` and rendered "not wired to the
 * backend yet" while two active AMCs sat in the table. That is the gap between
 * "the endpoint exists" and "the screen works", and it survived because the
 * contract test covered nine composed reads and this was the tenth.
 *
 * Composed rather than raw for the usual reason: the screen needs the
 * customer's name and the site's label, not two uuids, and it needs the term
 * measured rather than the two dates to measure it from. Doing that here means
 * one query rather than a fan-out from the browser.
 */
contractRoutes.get("/", requirePermission("contract:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const rows = await db
    .select({
      id: contracts.id,
      reference: contracts.reference,
      customer: customers.name,
      siteLabel: sites.label,
      siteLocality: sites.locality,
      annualValuePaise: contracts.annualValuePaise,
      coverage: contracts.coverage,
      billing: contracts.billing,
      reschedulePolicy: contracts.reschedulePolicy,
      startDate: contracts.startDate,
      endDate: contracts.endDate,
      status: contracts.status,
    })
    .from(contracts)
    .innerJoin(customers, eq(contracts.customerId, customers.id))
    .leftJoin(sites, eq(contracts.siteId, sites.id))
    .where(eq(contracts.tenantId, tenantId))
    .orderBy(desc(contracts.startDate));

  const ids = rows.map((r) => r.id);
  const schedules = ids.length
    ? await db
        .select()
        .from(contractSchedules)
        .where(inArray(contractSchedules.contractId, ids))
    : [];

  /*
    Visits done are counted, never stored. A visit *is* a job — FR-502 — so the
    only honest source is how many of those jobs actually finished. A stored
    counter is a number that drifts the first time somebody cancels one.
  */
  const done = ids.length
    ? await db
        .select({ scheduleId: jobs.contractScheduleId, n: count() })
        .from(jobs)
        // Done means done on site. There is no `COMPLETED` status — a visit
        // ends at WORK_DONE and, where the customer signs, SIGNED_OFF.
        .where(and(eq(jobs.tenantId, tenantId), inArray(jobs.status, ["WORK_DONE", "SIGNED_OFF"])))
        .groupBy(jobs.contractScheduleId)
    : [];
  const doneBySchedule = new Map(done.map((r) => [r.scheduleId, Number(r.n)]));

  /*
    Which visits are already jobs — FR-502's idempotency keys.

    The screen used to answer this by reading the *Today board*, which returns
    only jobs scheduled for today. Visits are generated ninety days ahead, so
    the board could almost never see them: every contract read "none on the
    board yet" however many times somebody had pressed the button, and offered
    to generate them again. Harmless — `jobs_tenant_visitkey_uq` refuses the
    duplicate — but the control never acknowledged the work, which is its own
    kind of broken.

    The contract knows its own visits. It answers for them here.
  */
  const generated = ids.length
    ? await db
        .select({ visitKey: jobs.visitKey, scheduleId: jobs.contractScheduleId })
        .from(jobs)
        .innerJoin(contractSchedules, eq(jobs.contractScheduleId, contractSchedules.id))
        .where(and(eq(jobs.tenantId, tenantId), inArray(contractSchedules.contractId, ids)))
    : [];
  const keysByContract = new Map<string, string[]>();
  const scheduleToContract = new Map(schedules.map((s) => [s.id, s.contractId]));
  for (const row of generated) {
    if (!row.visitKey || !row.scheduleId) continue;
    const contractId = scheduleToContract.get(row.scheduleId);
    if (!contractId) continue;
    keysByContract.set(contractId, [...(keysByContract.get(contractId) ?? []), row.visitKey]);
  }

  const today = new Date();

  return c.json({
    contracts: rows.map((contract) => {
      const start = new Date(contract.startDate);
      const end = new Date(contract.endDate);
      return {
        id: contract.id,
        reference: contract.reference,
        customer: contract.customer,
        // A contract without a site is legal — an umbrella AMC across a group.
        // The em dash says so rather than the screen printing "null".
        site: contract.siteLabel
          ? `${contract.siteLabel} · ${contract.siteLocality}`
          : "—",
        annualValuePaise: Number(contract.annualValuePaise),
        coverage: contract.coverage,
        billing: contract.billing,
        startDate: contract.startDate,
        endDate: contract.endDate,
        termDays: Math.max(1, daysBetween(start, end)),
        // Negative once expired, and the screen reads that: a contract three
        // days past its end is a different conversation from one due next week.
        daysRemaining: daysBetween(today, end),
        status: contract.status,
        reschedulePolicy: contract.reschedulePolicy,
        /** The visits already raised as jobs, so the screen need not guess. */
        visitsOnBoard: keysByContract.get(contract.id) ?? [],
        schedules: schedules
          .filter((s) => s.contractId === contract.id)
          .map((s) => ({
            id: s.id,
            scope: s.scope,
            recurrence: s.recurrence,
            anchorDay: s.anchorDay,
            visitsDone: doneBySchedule.get(s.id) ?? 0,
            visitsCommitted: s.visitsCommitted,
          })),
      };
    }),
  });
});

contractRoutes.post(
  "/",
  requirePermission("contract:write"),
  zBody(
    z.object({
      customerId: z.string().uuid(),
      siteId: z.string().uuid(),
      annualValuePaise: z.number().int().positive(),
      coverage: z.enum(["COMPREHENSIVE", "NON_COMPREHENSIVE", "LABOUR_ONLY"]),
      billing: z.enum(["UPFRONT_ANNUAL", "HALF_YEARLY", "QUARTERLY", "MONTHLY", "PER_VISIT"]),
      reschedulePolicy: z.enum(["SHIFT_SUBSEQUENT", "KEEP_SCHEDULE"]).default("SHIFT_SUBSEQUENT"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      termDays: z.number().int().positive().default(365),
      /** FR-1406 — one contract, several cadences. */
      schedules: z
        .array(
          z.object({
            scope: z.string().trim().min(2),
            recurrence: z.enum(RECURRENCES),
            anchorDay: z.number().int().min(1).max(31),
          }),
        )
        .min(1),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.id, body.siteId),
          eq(sites.customerId, body.customerId),
          eq(sites.tenantId, caller.tenantId),
        ),
      )
      .limit(1);
    if (!site) return c.json({ error: "That site is not on that customer" }, 400);

    const start = new Date(`${body.startDate}T00:00:00`);
    const end = new Date(start.getTime() + body.termDays * 86_400_000);

    const existing = await db
      .select({ id: contracts.id })
      .from(contracts)
      .where(eq(contracts.tenantId, caller.tenantId));
    const fyStart = start.getMonth() >= 3 ? start.getFullYear() : start.getFullYear() - 1;
    const reference = `AMC-${String(fyStart).slice(2)}${String(fyStart + 1).slice(2)}-${String(existing.length + 1).padStart(4, "0")}`;

    const [contract] = await db
      .insert(contracts)
      .values({
        tenantId: caller.tenantId,
        branchId: caller.branchId,
        reference,
        customerId: body.customerId,
        siteId: body.siteId,
        annualValuePaise: body.annualValuePaise,
        coverage: body.coverage,
        billing: body.billing,
        reschedulePolicy: body.reschedulePolicy,
        startDate: body.startDate,
        endDate: isoDay(end),
        status: "ACTIVE",
      })
      .returning();

    const schedules = await db
      .insert(contractSchedules)
      .values(
        body.schedules.map((s) => ({
          tenantId: caller.tenantId,
          contractId: contract!.id,
          scope: s.scope,
          recurrence: s.recurrence,
          anchorDay: s.anchorDay,
          // FR-505: derived from the *visit* cadence, never from the billing one.
          visitsCommitted: VISITS_PER_YEAR[s.recurrence as Recurrence],
        })),
      )
      .returning();

    await audit(caller, "CREATE_CONTRACT", `Created AMC ${reference}`, {
      table: "contracts",
      id: contract!.id,
    });
    return c.json({ ...contract, schedules }, 201);
  },
);

/**
 * FR-502 — put the contract's due visits on the board.
 *
 * **Idempotent by `visit_key`**, which is unique per tenant in the database.
 * Running this twice cannot double an AMC's visits — the second run inserts
 * nothing, because the constraint refuses and the row was filtered out first.
 * A 90-day horizon: generating a year of jobs on day one fills the board with
 * work nobody can act on.
 */
contractRoutes.post(
  "/:id/generate-visits",
  requirePermission("contract:write"),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");

    const [contract] = await db
      .select()
      .from(contracts)
      .where(and(eq(contracts.id, id), eq(contracts.tenantId, caller.tenantId)))
      .limit(1);
    if (!contract) return c.json({ error: "No such contract" }, 404);
    if (!contract.siteId) return c.json({ error: "That contract has no site" }, 400);

    const schedules = await db
      .select()
      .from(contractSchedules)
      .where(eq(contractSchedules.contractId, id));

    const existing = await db
      .select({ visitKey: jobs.visitKey })
      .from(jobs)
      .where(eq(jobs.tenantId, caller.tenantId));
    const taken = new Set(existing.map((j) => j.visitKey).filter(Boolean));

    const branchId = contract.branchId ?? caller.branchId;
    if (!branchId) return c.json({ error: "No branch on file" }, 400);
    const [branch] = await db
      .select({ prefix: branches.jobSeriesPrefix })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    const now = new Date();
    const start = new Date(`${contract.startDate}T00:00:00`);
    const created = [];

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
        const sequence = await nextInSeries(caller.tenantId, branchId, "job", visit.on);
        const [job] = await db
          .insert(jobs)
          .values({
            tenantId: caller.tenantId,
            branchId,
            jobNumber: formatNumber("job", branch?.prefix ?? "J", sequence, visit.on),
            customerId: contract.customerId,
            siteId: contract.siteId,
            contractScheduleId: schedule.id,
            visitKey: visit.key,
            visitNumber: visit.number,
            visitOf: visit.of,
            serviceType: schedule.scope,
            scheduledDate: isoDay(visit.on),
            // A scheduled visit carries the slot promise, not a timestamp
            // nobody agreed to (FR-203).
            slot: "9-1",
            status: "CREATED",
          })
          .returning();
        created.push(job);
      }
    }

    if (created.length > 0) {
      await audit(
        caller,
        "GENERATE_CONTRACT_VISITS",
        `Put ${created.length} visit(s) from ${contract.reference} on the board`,
        { table: "contracts", id },
      );
    }
    return c.json({ created: created.length, jobs: created });
  },
);

/**
 * Work an expiring AMC as a renewal lead — FR-507.
 *
 * One endpoint rather than "create a lead, then note the contract on it",
 * because the thing that matters here is **idempotency**: two renewal leads
 * for one contract is two people ringing the same customer on the same day,
 * and two browser round trips cannot be made safe against that.
 *
 * The link is the activity note, which opens with the contract's own
 * reference. Matching on the reference and not the customer's name is
 * deliberate — a customer with a lift AMC and a chiller AMC has two contracts
 * renewing on different dates, and name-matching would silently swallow the
 * second one.
 */
contractRoutes.post("/:id/renewal-lead", requirePermission("lead:write"), async (c) => {
  const caller = c.get("caller");
  const id = c.req.param("id");

  const [contract] = await db
    .select({
      id: contracts.id,
      reference: contracts.reference,
      endDate: contracts.endDate,
      customerId: contracts.customerId,
      siteId: contracts.siteId,
      customer: customers.name,
    })
    .from(contracts)
    .innerJoin(customers, eq(contracts.customerId, customers.id))
    .where(and(eq(contracts.id, id), eq(contracts.tenantId, caller.tenantId)))
    .limit(1);
  if (!contract) return c.json({ error: "No such contract" }, 404);

  // Already in the pipeline? Say so rather than raising a second one.
  const [existing] = await db
    .select({ id: leads.id, reference: leads.reference })
    .from(leads)
    .innerJoin(leadActivities, eq(leadActivities.leadId, leads.id))
    .where(
      and(
        eq(leads.tenantId, caller.tenantId),
        eq(leads.source, "AMC renewal"),
        like(leadActivities.note, `${contract.reference}%`),
      ),
    )
    .limit(1);
  if (existing) return c.json({ ...existing, alreadyWorking: true });

  // The number to ring: this site's primary contact.
  const [contact] = contract.siteId
    ? await db
        .select({ phone: contacts.phoneE164 })
        .from(contacts)
        .where(and(eq(contacts.tenantId, caller.tenantId), eq(contacts.siteId, contract.siteId)))
        .orderBy(desc(contacts.isPrimary))
        .limit(1)
    : [];

  const [site] = contract.siteId
    ? await db
        .select({ locality: sites.locality })
        .from(sites)
        .where(eq(sites.id, contract.siteId))
        .limit(1)
    : [];

  /*
    Same reference convention as `POST /api/leads`, deliberately — one shape of
    lead reference, not two.

    Worth noting it is a count and not a series: two leads created at the same
    instant read the same count and one is rejected by
    `leads_tenant_reference_uq`. Tolerable while a lead reference is a
    convenience rather than a statutory number, unlike invoices — but it is a
    real race and it lives in `POST /api/leads` too.
  */
  const [counted] = await db
    .select({ value: count() })
    .from(leads)
    .where(eq(leads.tenantId, caller.tenantId));
  const now = new Date();
  const reference = `L-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}-${String(Number(counted?.value ?? 0) + 1).padStart(4, "0")}`;

  const [lead] = await db
    .insert(leads)
    .values({
      tenantId: caller.tenantId,
      reference,
      name: contract.customer,
      // Normalised, like every other write. A renewal lead whose number is
      // stored raw cannot be found by the duplicate check that exists to stop
      // somebody opening a second lead for the same customer.
      phoneE164: e164(contact?.phone),
      locality: site?.locality ?? null,
      source: "AMC renewal",
      stage: "NEW",
      // FR-103: whoever picked it up earns the renewal.
      takenByUserId: caller.userId,
      ownerUserId: caller.userId,
      // Due now: a renewal that expires next month is called this week.
      nextFollowUpAt: now,
    })
    .returning({ id: leads.id, reference: leads.reference });

  await db.insert(leadActivities).values({
    tenantId: caller.tenantId,
    leadId: lead!.id,
    /*
      Not "Spoke" — nobody has. The first activity on a renewal lead records
      how it got into the queue, and claiming a call that never happened is
      the same lie as recording one for a dragged card.
    */
    outcome: "Renewal raised",
    // The reference leads, because that is what the contracts screen matches on.
    note: `${contract.reference} expires ${contract.endDate}`,
    actorUserId: caller.userId,
  });

  await audit(caller, "WORK_RENEWAL_AS_LEAD", `${contract.reference} → ${lead!.reference}`, {
    table: "leads",
    id: lead!.id,
  });

  return c.json({ ...lead, alreadyWorking: false }, 201);
});
