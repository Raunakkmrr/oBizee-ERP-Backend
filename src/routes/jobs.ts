import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  branches,
  customers,
  jobEvents,
  jobHelpers,
  jobs,
  sites,
  users,
} from "../db/schema.ts";
import {
  PRICE_FIELDS,
  requirePermission,
  stripFields,
  type AppEnv,
} from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { can } from "../auth/roles.ts";
import { formatNumber, nextInSeries } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";

/**
 * Jobs — FR-201 to FR-207.
 *
 * **FR-1302 lives here.** A technician gets the same rows as a coordinator with
 * the money fields *removed from the payload*, not hidden in the response. The
 * web app greys prices out and still ships them; anyone with a developer
 * console can read those. `stripFields` deletes the keys.
 *
 * The site is a foreign key, not a typed locality. That is what makes the place
 * of supply — and therefore the tax head — derivable at all.
 */
export const jobRoutes = apiRouter();

jobRoutes.get("/", async (c) => {
  const caller = c.get("caller");

  /*
    FR-306 — a technician sees only his own jobs.

    Two permissions, not one: `job:read` is the whole board, `job:read_own` is
    his own work. Gating this route on `job:read` alone refused technicians
    outright, which is the wrong answer — they need the list, narrowed.
  */
  const seesEverything = can(caller.role, "job:read", undefined, caller.level);
  const seesOwn = can(caller.role, "job:read_own", undefined, caller.level);
  if (!seesEverything && !seesOwn) {
    return c.json(
      { error: `A ${caller.role} cannot do this`, needs: "job:read", role: caller.role },
      403,
    );
  }

  const scope = seesEverything
    ? eq(jobs.tenantId, caller.tenantId)
    : and(eq(jobs.tenantId, caller.tenantId), eq(jobs.primaryTechnicianId, caller.userId));

  const rows = await db
    .select({
      id: jobs.id,
      jobNumber: jobs.jobNumber,
      status: jobs.status,
      priority: jobs.priority,
      serviceType: jobs.serviceType,
      scheduledDate: jobs.scheduledDate,
      slot: jobs.slot,
      visitAttempt: jobs.visitAttempt,
      valuePaise: jobs.valuePaise,
      customerName: customers.name,
      siteLocality: sites.locality,
      siteStateCode: sites.stateCode,
    })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .where(scope)
    .orderBy(desc(jobs.createdAt))
    .limit(200);

  /*
    FR-1302. Stripped server-side unless the caller may see selling prices.
    The tenant toggle defaults off, which is a stated anti-freelancing control
    rather than paranoia — a technician who can see the margin can quote around
    the firm.
  */
  const maySeePrices = can(caller.role, "price:view_selling", undefined, caller.level);
  return c.json({
    jobs: maySeePrices
      ? rows
      : stripFields(rows, [...PRICE_FIELDS] as (keyof (typeof rows)[number])[]),
    pricesVisible: maySeePrices,
    scope: seesEverything ? "all" : "own",
  });
});

/**
 * A window, or an exact time.
 *
 * `9-1`, `1-5` and `5-8` are the day's three windows and cover most visits.
 * An exact time is the one a customer was actually promised — "the doctor is
 * only free at 11:30" — and the board already sorts it among the windows by
 * its own hour. The validator allowed only the three, which refused a job the
 * column and the board both handle.
 */
const slotSchema = z.union([
  z.enum(["9-1", "1-5", "5-8"]),
  z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "A time like 11:30, or one of the day's windows"),
]);

const newJob = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid(),
  serviceType: z.string().trim().min(2),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** FR-203: a slot, never a false-precision timestamp. */
  slot: slotSchema.optional(),
  priority: z.enum(["normal", "urgent", "breakdown"]).default("normal"),
  primaryTechnicianId: z.string().uuid().nullable().optional(),
});

jobRoutes.post(
  "/",
  requirePermission("job:write"),
  zBody( newJob),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    // The site must belong to the customer *and* the tenant. Checking the
    // tenant alone would let a caller attach a job to another customer's site.
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

    const branchId = caller.branchId ?? (
      await db.select({ id: branches.id }).from(branches)
        .where(eq(branches.tenantId, caller.tenantId)).limit(1)
    )[0]?.id;
    if (!branchId) return c.json({ error: "No branch on file" }, 400);

    const [branch] = await db
      .select({ prefix: branches.jobSeriesPrefix })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    const now = new Date();
    const sequence = await nextInSeries(caller.tenantId, branchId, "job", now);
    const jobNumber = formatNumber("job", branch?.prefix ?? "J", sequence, now);

    const [job] = await db
      .insert(jobs)
      .values({
        tenantId: caller.tenantId,
        branchId,
        jobNumber,
        customerId: body.customerId,
        siteId: body.siteId,
        serviceType: body.serviceType,
        scheduledDate: body.scheduledDate ?? null,
        slot: body.slot ?? null,
        priority: body.priority,
        primaryTechnicianId: body.primaryTechnicianId ?? null,
        status: body.primaryTechnicianId ? "ASSIGNED" : "CREATED",
      })
      .returning();

    await audit(caller, "CREATE_JOB", `Raised work order ${jobNumber}`, {
      table: "jobs",
      id: job!.id,
    });

    return c.json(job, 201);
  },
);

/* --------------------------------------------------------------- mutations */

const assignBody = z.object({
  primaryTechnicianId: z.string().uuid().nullable(),
  /** FR-205: any number, counted at half weight in workload. */
  helperIds: z.array(z.string().uuid()).max(6).default([]),
});

jobRoutes.post(
  "/:id/assign",
  requirePermission("job:dispatch"),
  zBody( assignBody),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    // Everyone named must be an active technician in this tenant. Without the
    // check a dispatcher could assign a job to another firm's staff.
    const named = [body.primaryTechnicianId, ...body.helperIds].filter(
      (x): x is string => x !== null,
    );
    if (named.length > 0) {
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, caller.tenantId),
            eq(users.role, "technician"),
            eq(users.active, true),
            inArray(users.id, named),
          ),
        );
      if (found.length !== new Set(named).size) {
        return c.json({ error: "Someone named is not an active technician here" }, 400);
      }
    }

    const [updated] = await db
      .update(jobs)
      .set({
        primaryTechnicianId: body.primaryTechnicianId,
        // Assigning does not un-start a job that is already moving.
        status: job.status === "CREATED" && body.primaryTechnicianId ? "ASSIGNED" : job.status,
      })
      .where(eq(jobs.id, id))
      .returning();

    await db.delete(jobHelpers).where(eq(jobHelpers.jobId, id));
    if (body.helperIds.length > 0) {
      await db
        .insert(jobHelpers)
        .values(body.helperIds.map((userId) => ({ jobId: id, userId })));
    }

    await audit(caller, "ASSIGN_JOB", `Assigned ${job.jobNumber}`, {
      table: "jobs",
      id,
    });
    return c.json(updated);
  },
);

/**
 * FR-206 — rescheduling preserves the job and counts the attempt.
 *
 * A new job would lose the history and make "second visit" uncountable. The
 * attempt counter is what tells a coordinator this is a customer already let
 * down once.
 */
jobRoutes.post(
  "/:id/reschedule",
  requirePermission("job:write"),
  zBody(
    z.object({
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slot: slotSchema.optional(),
      reason: z.string().trim().min(3),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    const [updated] = await db
      .update(jobs)
      .set({
        scheduledDate: body.scheduledDate,
        slot: body.slot ?? job.slot,
        visitAttempt: job.visitAttempt + 1,
      })
      .where(eq(jobs.id, id))
      .returning();

    /*
      Also on the job's own timeline, not only in the audit log.

      The audit log answers "who changed what" months later; the timeline
      answers "what has happened to this visit" to the next person who opens
      it. A visit that moved — and why — is exactly what the technician
      arriving tomorrow needs, and FR-203's reason was reaching only the log
      nobody reads while working.
    */
    await db.insert(jobEvents).values({
      tenantId: caller.tenantId,
      jobId: id,
      label: `Moved to ${body.scheduledDate}${body.slot ? ` ${body.slot}` : ""} — ${body.reason}`,
      actorUserId: caller.userId,
      occurredAt: new Date(),
    });

    await audit(
      caller,
      "RESCHEDULE_JOB",
      `Moved ${job.jobNumber} to ${body.scheduledDate} — ${body.reason}`,
      { table: "jobs", id },
    );
    return c.json(updated);
  },
);

/**
 * State transitions — FR-205, FR-208.
 *
 * **Only the primary technician may transition from the field.** A helper
 * cannot, and a coordinator moving a job on a technician's behalf is a
 * different act with a different audit line. The transition table is explicit
 * rather than "any status to any status": a job cannot jump from CREATED to
 * SIGNED_OFF, and the reason a state exists is that something happened.
 */
const NEXT: Record<string, readonly string[]> = {
  CREATED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["EN_ROUTE", "CUSTOMER_UNAVAILABLE", "CANCELLED"],
  EN_ROUTE: ["ON_SITE", "CUSTOMER_UNAVAILABLE"],
  ON_SITE: ["WORK_DONE", "PARTS_AWAITED", "CUSTOMER_UNAVAILABLE"],
  PARTS_AWAITED: ["ASSIGNED", "ON_SITE", "CANCELLED"],
  CUSTOMER_UNAVAILABLE: ["ASSIGNED", "CANCELLED"],
  WORK_DONE: ["SIGNED_OFF"],
  SIGNED_OFF: [],
  CANCELLED: [],
};

jobRoutes.post(
  "/:id/transition",
  zBody(
    z.object({
      to: z.enum([
        "ASSIGNED", "EN_ROUTE", "ON_SITE", "PARTS_AWAITED",
        "CUSTOMER_UNAVAILABLE", "WORK_DONE", "SIGNED_OFF", "CANCELLED",
      ]),
      /** When it happened on the ground — not when it reached us. */
      occurredAt: z.string().datetime().optional(),
      note: z.string().optional(),
      /** FR-303: the technician app's replay key. */
      clientUuid: z.string().uuid().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    const fromField = caller.role === "technician";
    if (fromField && job.primaryTechnicianId !== caller.userId) {
      // A helper is on the job sheet and counts at half weight; he does not
      // record what happened. One person owns the account of a visit.
      return c.json({ error: "Only the primary technician can record this" }, 403);
    }
    if (!fromField && !can(caller.role, "job:write", undefined, caller.level)) {
      return c.json({ error: `A ${caller.role} cannot do this`, needs: "job:write" }, 403);
    }

    /*
      FR-303 — the replay check comes first, before the transition table.

      An offline technician's queue is replayed on reconnect, and the second
      attempt to record "reached site" arrives when the job is already ON_SITE.
      Validating the transition first answered that with a 409: the app would
      treat a successful sync as a failure and keep retrying forever. A write
      the server has already accepted is not an illegal transition, it is the
      same write.
    */
    if (body.clientUuid) {
      const [seen] = await db
        .select({ id: jobEvents.id })
        .from(jobEvents)
        .where(
          and(
            eq(jobEvents.tenantId, caller.tenantId),
            eq(jobEvents.clientUuid, body.clientUuid),
          ),
        )
        .limit(1);
      if (seen) return c.json({ ...job, replayed: true });
    }

    const allowed = NEXT[job.status] ?? [];
    if (!allowed.includes(body.to)) {
      return c.json(
        {
          error: `A job cannot go from ${job.status} to ${body.to}`,
          allowed,
        },
        409,
      );
    }

    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();

    try {
      await db.insert(jobEvents).values({
        tenantId: caller.tenantId,
        jobId: id,
        label: body.note ? `${body.to} — ${body.note}` : body.to,
        actorUserId: caller.userId,
        occurredAt,
        offline: occurredAt.getTime() < Date.now() - 60_000,
        clientUuid: body.clientUuid ?? null,
      });
    } catch {
      // Belt and braces: two replays racing each other both pass the check
      // above, and the unique constraint catches the loser.
      const [current] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return c.json({ ...current, replayed: true });
    }

    const [updated] = await db
      .update(jobs)
      .set({ status: body.to })
      .where(eq(jobs.id, id))
      .returning();

    await audit(caller, "TRANSITION_JOB", `${job.jobNumber} → ${body.to}`, {
      table: "jobs",
      id,
    });
    return c.json(updated);
  },
);
