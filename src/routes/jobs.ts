import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { branches, customers, jobs, sites } from "../db/schema.ts";
import {
  PRICE_FIELDS,
  requirePermission,
  stripFields,
  type AppEnv,
} from "../auth/context.ts";
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
export const jobRoutes = new Hono<AppEnv>();

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

const newJob = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid(),
  serviceType: z.string().trim().min(2),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** FR-203: a slot, never a false-precision timestamp. */
  slot: z.enum(["9-1", "1-5", "5-8"]).optional(),
  priority: z.enum(["normal", "urgent", "breakdown"]).default("normal"),
  primaryTechnicianId: z.string().uuid().nullable().optional(),
});

jobRoutes.post(
  "/",
  requirePermission("job:write"),
  zValidator("json", newJob),
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
