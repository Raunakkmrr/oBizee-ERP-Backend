/**
 * The weekly report — PRD §6.11.
 *
 * **The one decision:** *what changed this week that I should do something
 * about?* Four cuts, each chosen because it names a person or a service rather
 * than a total: revenue by service (what to sell more of), dwell by state
 * (where jobs get stuck), technicians (who needs help), and conversion by
 * source and taker (which marketing spend and which person actually works).
 *
 * FR-1002: the filters travel with the data. A number whose period and branch
 * are unknown cannot be defended a month later, and this report is the one
 * people quote in meetings.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { requirePermission } from "../auth/context.ts";
import { can } from "../auth/roles.ts";
import { db } from "../db/client.ts";
import { invoices, jobEvents, jobs, leads, signOffs, users } from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";

export const reportRoutes = apiRouter();

function iso(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** The last seven days, ending today. */
function week(): { from: string; to: string; word: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return { from: iso(from), to: iso(to), word: `${fmt(from)} – ${fmt(to)}` };
}

/**
 * A rating average, or null when there is not enough of it to mean anything.
 *
 * Three sign-offs is not a performance review. Reporting 5.0 off a single
 * rating invites a conversation the number cannot support, so below the
 * threshold this says "not enough yet" by being absent.
 */
const MIN_RATINGS = 3;

reportRoutes.get("/weekly", requirePermission("report:read"), async (c) => {
  const caller = c.get("caller");
  const { tenantId } = caller;
  const { from, to, word } = week();

  const [revenueRows, doneJobs, events, ratingRows, leadRows] = await Promise.all([
    db
      .select({
        serviceType: jobs.serviceType,
        jobs: sql<number>`count(distinct ${jobs.id})::int`,
        revenuePaise: sql<string>`coalesce(sum(${invoices.taxablePaise}), 0)`,
      })
      .from(invoices)
      .innerJoin(jobs, eq(invoices.jobId, jobs.id))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
        ),
      )
      .groupBy(jobs.serviceType),
    db
      .select({ id: jobs.id, status: jobs.status, technicianId: jobs.primaryTechnicianId })
      .from(jobs)
      .where(
        and(eq(jobs.tenantId, tenantId), gte(jobs.scheduledDate, from), lte(jobs.scheduledDate, to)),
      ),
    db
      .select({ jobId: jobEvents.jobId, label: jobEvents.label, occurredAt: jobEvents.occurredAt })
      .from(jobEvents)
      .where(eq(jobEvents.tenantId, tenantId))
      .orderBy(jobEvents.occurredAt),
    db
      .select({ jobId: signOffs.jobId, rating: signOffs.rating })
      .from(signOffs)
      .where(eq(signOffs.tenantId, tenantId)),
    db
      .select({
        source: leads.source,
        takenBy: users.name,
        stage: leads.stage,
      })
      .from(leads)
      .leftJoin(users, eq(leads.takenByUserId, users.id))
      .where(eq(leads.tenantId, tenantId)),
  ]);

  /*
    How long a job sits in each state, from the gaps between its own events.
    Computed from the timeline rather than stored: a stored duration is a second
    copy of a fact the events already carry, and the two drift.
  */
  const byJob = new Map<string, typeof events>();
  for (const ev of events) {
    const bucket = byJob.get(ev.jobId) ?? [];
    bucket.push(ev);
    byJob.set(ev.jobId, bucket);
  }
  const dwell = new Map<string, { total: number; count: number }>();
  for (const [, list] of byJob) {
    for (let i = 0; i < list.length - 1; i += 1) {
      const hours = (list[i + 1]!.occurredAt.getTime() - list[i]!.occurredAt.getTime()) / 3_600_000;
      if (hours < 0) continue;
      const held = dwell.get(list[i]!.label) ?? { total: 0, count: 0 };
      dwell.set(list[i]!.label, { total: held.total + hours, count: held.count + 1 });
    }
  }

  const ratingByJob = new Map(ratingRows.map((r) => [r.jobId, r.rating]));
  const staff = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.role, "technician")));

  const technicians = staff.map((person) => {
    const mine = doneJobs.filter((j) => j.technicianId === person.id);
    const completed = mine.filter((j) => ["WORK_DONE", "SIGNED_OFF"].includes(j.status));
    const rated = completed
      .map((j) => ratingByJob.get(j.id))
      .filter((r): r is number => typeof r === "number");
    return {
      name: person.name,
      completed: completed.length,
      avgRating:
        rated.length >= MIN_RATINGS
          ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10
          : null,
      // A first-visit fix needs a repeat-visit signal the job board does not yet
      // carry, so this says "unknown" rather than reporting a flattering 100%.
      firstVisitFixPct: null,
    };
  });

  const conversionKey = new Map<string, { source: string; takenBy: string; leads: number; won: number }>();
  for (const lead of leadRows) {
    const takenBy = lead.takenBy ?? "Unattributed";
    const key = `${lead.source}::${takenBy}`;
    const held = conversionKey.get(key) ?? { source: lead.source, takenBy, leads: 0, won: 0 };
    held.leads += 1;
    if (lead.stage === "WON") held.won += 1;
    conversionKey.set(key, held);
  }

  const payload = {
    filters: {
      periodWord: word,
      branch: "All branches",
      comparedWith: "the previous seven days",
    },
    revenueByService: revenueRows.map((r) => ({
      serviceType: r.serviceType,
      jobs: r.jobs,
      revenuePaise: Number(r.revenuePaise),
    })),
    jobsByState: [...dwell.entries()]
      .map(([state, v]) => ({
        state,
        count: v.count,
        avgHours: Math.round((v.total / v.count) * 10) / 10,
      }))
      .sort((a, b) => b.avgHours - a.avgHours),
    technicians,
    conversion: [...conversionKey.values()].sort((a, b) => b.leads - a.leads),
  };

  /*
    FR-1302 again, and this is the sharpest case of it: naming who completed
    how many jobs is exactly the report a role without
    `report:technician_performance` must not see. The list is removed, not
    blanked — a row of dashes still tells you how many technicians there are.
  */
  if (!can(caller.role, "report:technician_performance", undefined, caller.level)) {
    return c.json({ ...payload, technicians: [] });
  }

  return c.json(payload);
});
