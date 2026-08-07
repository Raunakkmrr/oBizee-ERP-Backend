/**
 * The Today dispatch board — PRD §6.4.
 *
 * A composed read, not a resource. The screen answers one question ("which job
 * do I act on in the next two minutes, and who do I give it to?") and that
 * answer spans jobs, people, contracts and leads. Serving it as one payload is
 * deliberate: the alternative is shipping four resource lists to the browser
 * and deriving the SLA and counters there, which duplicates the rules in two
 * languages and lets the counters disagree with the rows they filter.
 *
 * The counters are computed from the same rows that are sent, so a count can
 * never describe jobs the board did not receive.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { PRICE_FIELDS, stripFields } from "../auth/context.ts";
import { can } from "../auth/roles.ts";
import { db } from "../db/client.ts";
import { customers, jobEvents, jobs, leads, sites, users } from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";

export const boardRoutes = apiRouter();

/** Statuses that count as the technician still being out on that job. */
const EN_ROUTE = "EN_ROUTE";
const ON_SITE = ["ON_SITE"];

/**
 * `Due 2h` / `Late 1d` — a word, never a bare colour (§6.4.2, P3).
 *
 * Null when nothing was promised. A job with no promise has no SLA to miss,
 * and inventing an "ok" chip for it would put a reassuring green on a job
 * nobody has committed to.
 */
function sla(promisedBy: Date | null, now: Date): { word: string; kind: "due_soon" | "late" | "ok" } | null {
  if (!promisedBy) return null;
  const ms = promisedBy.getTime() - now.getTime();
  const hours = Math.abs(ms) / 3_600_000;
  const word = hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.max(1, Math.round(hours))}h`;
  if (ms < 0) return { word: `Late ${word}`, kind: "late" };
  if (hours <= 4) return { word: `Due ${word}`, kind: "due_soon" };
  return { word: `Due ${word}`, kind: "ok" };
}

/** `11:42` in IST — the duration is what tells a coordinator he is nearly free. */
function clockWord(at: Date): string {
  return at.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function todayInIndia(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

boardRoutes.get("/today", async (c) => {
  const caller = c.get("caller");
  const { tenantId } = caller;

  // FR-306, same rule as the jobs list: the board is a dispatch tool, so a
  // technician who can only see his own work gets his own work, not a refusal.
  const seesAll = can(caller.role, "job:read", undefined, caller.level);
  if (!seesAll && !can(caller.role, "job:read_own", undefined, caller.level)) {
    return c.json({ error: `A ${caller.role} cannot do this`, needs: "job:read", role: caller.role }, 403);
  }

  const now = new Date();
  const today = todayInIndia();
  const tomorrow = addDays(today, 1);

  const scope = seesAll
    ? eq(jobs.tenantId, tenantId)
    : and(eq(jobs.tenantId, tenantId), eq(jobs.primaryTechnicianId, caller.userId));

  const [rows, staff, tomorrowRows, leadRows] = await Promise.all([
    db
      .select({
        id: jobs.id,
        jobNumber: jobs.jobNumber,
        slot: jobs.slot,
        customer: customers.name,
        locality: sites.locality,
        serviceType: jobs.serviceType,
        visitNumber: jobs.visitNumber,
        visitOf: jobs.visitOf,
        status: jobs.status,
        priority: jobs.priority,
        promisedBy: jobs.promisedBy,
        visitAttempt: jobs.visitAttempt,
        valuePaise: jobs.valuePaise,
        visitKey: jobs.visitKey,
        technicianId: jobs.primaryTechnicianId,
        technicianName: users.name,
      })
      .from(jobs)
      .innerJoin(customers, eq(jobs.customerId, customers.id))
      .innerJoin(sites, eq(jobs.siteId, sites.id))
      .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
      .where(and(scope, eq(jobs.scheduledDate, today))),
    db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.role, "technician"), eq(users.active, true))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(scope, eq(jobs.scheduledDate, tomorrow))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, tenantId),
          sql`${leads.nextFollowUpAt} < (${tomorrow}::date at time zone 'Asia/Kolkata')`,
          sql`${leads.stage} not in ('WON', 'LOST')`,
        ),
      ),
  ]);

  const jobRows = rows.map((r) => ({
    id: r.id,
    jobNumber: r.jobNumber,
    // A job scheduled for today without a slot still has to render somewhere;
    // "Unslotted" sorts to the end rather than crashing the group header.
    slot: r.slot ?? "Unslotted",
    customer: r.customer,
    locality: r.locality ?? "—",
    serviceType: r.serviceType,
    visit: r.visitNumber === null && r.visitOf === null ? null : { n: r.visitNumber, of: r.visitOf },
    status: r.status,
    technician: r.technicianId ? { id: r.technicianId, name: r.technicianName ?? "—" } : null,
    priority: r.priority,
    sla: sla(r.promisedBy, now),
    visitAttempt: r.visitAttempt,
    valuePaise: r.valuePaise,
    visitKey: r.visitKey,
  }));

  /*
    Whereabouts come from the jobs, not from a status column somebody has to
    remember to clear. A technician is "on site" because a job of his is on
    site — the two cannot drift apart.
  */
  const live = new Map<string, { kind: "free" | "en_route" | "on_site" | "leave"; since: string | null }>();
  const busyJobIds: string[] = [];
  for (const r of rows) {
    if (!r.technicianId) continue;
    if (r.status === EN_ROUTE || ON_SITE.includes(r.status)) {
      live.set(r.technicianId, {
        kind: r.status === EN_ROUTE ? "en_route" : "on_site",
        since: null,
      });
      busyJobIds.push(r.id);
    }
  }

  // `On site since 11:42` — the last transition into the state he is in now.
  if (busyJobIds.length > 0) {
    const events = await db
      .select({ jobId: jobEvents.jobId, occurredAt: jobEvents.occurredAt, label: jobEvents.label })
      .from(jobEvents)
      .where(and(eq(jobEvents.tenantId, tenantId), inArray(jobEvents.jobId, busyJobIds)));
    const latest = new Map<string, Date>();
    for (const ev of events) {
      const held = latest.get(ev.jobId);
      if (!held || ev.occurredAt > held) latest.set(ev.jobId, ev.occurredAt);
    }
    for (const r of rows) {
      const at = latest.get(r.id);
      const state = r.technicianId ? live.get(r.technicianId) : undefined;
      if (at && state) state.since = clockWord(at);
    }
  }

  const jobsByTech = new Map<string, typeof jobRows>();
  for (const j of jobRows) {
    if (!j.technician) continue;
    const bucket = jobsByTech.get(j.technician.id);
    if (bucket) bucket.push(j);
    else jobsByTech.set(j.technician.id, [j]);
  }

  const technicians = staff.map((person) => {
    const mine = jobsByTech.get(person.id) ?? [];
    return {
      id: person.id,
      name: person.name,
      jobsToday: mine.length,
      status: live.get(person.id) ?? { kind: "free" as const, since: null },
      localities: [...new Set(mine.map((j) => j.locality))],
      skills: (person.skills ?? []) as string[],
    };
  });

  const counters = {
    unassigned: jobRows.filter((j) => j.technician === null).length,
    en_route: jobRows.filter((j) => j.status === EN_ROUTE).length,
    on_site: jobRows.filter((j) => ON_SITE.includes(j.status)).length,
    parts_awaited: jobRows.filter((j) => j.status === "PARTS_AWAITED").length,
    done_not_billed: jobRows.filter((j) => j.status === "WORK_DONE" || j.status === "SIGNED_OFF").length,
  };

  // FR-1302: the field cannot be hidden, it has to be absent.
  const visible = can(caller.role, "price:view_selling", undefined, caller.level)
    ? jobRows
    : stripFields(jobRows, PRICE_FIELDS as readonly (keyof (typeof jobRows)[number])[]);

  return c.json({
    counters,
    jobs: visible,
    technicians,
    tomorrowJobs: tomorrowRows[0]?.n ?? 0,
    leadsDueToday: leadRows[0]?.n ?? 0,
  });
});
