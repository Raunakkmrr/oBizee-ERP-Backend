/**
 * A day on the board — dev fixture, anchored to whatever today is.
 *
 * The masters in `seed.ts` are stable and idempotent. A dispatch board is not:
 * it is only interesting relative to *now*, and fixed dates meant the board
 * came back empty and every shape test passed on zero rows. Passing on nothing
 * is the failure mode this file exists to remove.
 *
 * Every row here exercises something the board must render:
 *
 * - one **unassigned breakdown**, already past its promise — the `late` chip
 *   and the most expensive counter on the screen
 * - one **en route** and one **on site**, so technician whereabouts derive from
 *   real job states rather than a status column
 * - one **parts awaited** — the state that silently eats revenue
 * - one **signed off, not billed** — the number that sells the product
 * - one **contract visit** (`visit 3 of 4`) and one ad-hoc job, so `Visit —/—`
 *   and `Visit 3/4` both appear
 * - jobs **tomorrow** and leads **due today**, for the empty-state counts
 *
 * Re-running replaces the day rather than doubling it.
 */
import { and, eq, inArray, like, or } from "drizzle-orm";

import { adminDb as db, withTenant } from "./client.ts";
import { formatNumber, nextInSeries } from "../lib/series.ts";
import { customers, invoices, jobEvents, jobParts, jobs, leads, sites, tenants, users } from "./schema.ts";

const LEGAL_NAME = "Shakti Cooling Systems Pvt Ltd";

function isoInIndia(offsetDays = 0): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Hours from now, as an absolute instant. Negative means already missed. */
function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 3_600_000);
}

export async function seedDay(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seedDay is a development fixture and will not run in production");
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.legalName, LEGAL_NAME))
    .limit(1);
  if (!tenant) throw new Error("run the master seed first — no tenant found");
  const tenantId = tenant.id;

  /*
    The series counters are drawn through the request-path handle, which is
    scoped by the database and therefore needs a tenant in force. Everything
    else this fixture does runs on the privileged handle, because it is setting
    the tenant up rather than acting inside one.
  */
  const nextJobSerial = (branch: string) =>
    withTenant(tenantId, async () => await nextInSeries(tenantId, branch, "job", new Date()));

  const [branchRow] = await db
    .select({ id: jobs.branchId })
    .from(jobs)
    .where(eq(jobs.tenantId, tenantId))
    .limit(1);

  const { branches } = await import("./schema.ts");
  const branchId =
    branchRow?.id ??
    (
      await db
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.tenantId, tenantId))
        .limit(1)
    )[0]?.id;
  if (!branchId) throw new Error("no branch to hang jobs on");

  const people = await db.select().from(users).where(eq(users.tenantId, tenantId));
  const technicians = people.filter((p) => p.role === "technician");
  if (technicians.length < 2) throw new Error("need at least two technicians seeded");

  const siteRows = await db
    .select({
      siteId: sites.id,
      customerId: sites.customerId,
      locality: sites.locality,
      customer: customers.name,
    })
    .from(sites)
    .innerJoin(customers, eq(sites.customerId, customers.id))
    .where(eq(sites.tenantId, tenantId));

  const at = (name: string) => {
    const found = siteRows.find((s) => s.customer.startsWith(name));
    if (!found) throw new Error(`no seeded site for ${name}`);
    return found;
  };

  const today = isoInIndia(0);
  const tomorrow = isoInIndia(1);

  /*
    Replace the day, and sweep up the old hand-numbered rows.

    Deleting by date is right again now that numbers come from the series and
    cannot collide across runs. The `J-DAY-%` clause clears rows left by the
    earlier version of this fixture, which invented numbers and so made the
    numbering screen report hundreds of missing ones. Events cascade.
  */
  const stale = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        or(
          inArray(jobs.scheduledDate, [today, tomorrow]),
          like(jobs.jobNumber, "J-DAY-%"),
        ),
      ),
    );
  /*
    A job that has been invoiced is not the fixture's to remove.

    The foreign key refuses it, and rightly: an invoice pointing at nothing is
    a bill nobody can trace to the work. So the day is rebuilt around whatever
    has already been billed rather than on top of it — which also means a run
    of the E2E suite does not make the next one fail.
  */
  const billed = new Set(
    (
      await db
        .select({ jobId: invoices.jobId })
        .from(invoices)
        .where(eq(invoices.tenantId, tenantId))
    )
      .map((row) => row.jobId)
      .filter((id): id is string => id !== null),
  );

  const removable = stale.filter((job) => !billed.has(job.id));
  if (removable.length > 0) {
    await db.delete(jobs).where(
      inArray(
        jobs.id,
        removable.map((j) => j.id),
      ),
    );
  }

  const day = [
    {
      site: at("Deshmukh"),
      serviceType: "Chiller breakdown",
      slot: "9-1",
      status: "CREATED" as const,
      priority: "breakdown" as const,
      promisedBy: hoursFromNow(-3), // late, and nobody owns it
      technician: null,
      visit: null,
      valuePaise: null,
    },
    {
      site: at("Shakti"),
      serviceType: "Cold room AMC",
      slot: "9-1",
      status: "EN_ROUTE" as const,
      priority: "normal" as const,
      promisedBy: hoursFromNow(2),
      technician: technicians[0]!,
      visit: { n: 3, of: 4 },
      valuePaise: 1_80_000,
    },
    {
      site: at("Green Park"),
      serviceType: "Air conditioning service",
      slot: "1-5",
      status: "ON_SITE" as const,
      priority: "normal" as const,
      promisedBy: hoursFromNow(6),
      technician: technicians[1]!,
      visit: null,
      valuePaise: 4_50_000,
    },
    {
      site: at("Sethi"),
      serviceType: "Deep freezer repair",
      slot: "1-5",
      status: "PARTS_AWAITED" as const,
      priority: "urgent" as const,
      promisedBy: hoursFromNow(1),
      technician: technicians[0]!,
      visit: null,
      valuePaise: 2_20_000,
    },
    {
      site: at("Sunrise"),
      serviceType: "Water purifier service",
      slot: "5-8",
      status: "SIGNED_OFF" as const,
      priority: "normal" as const,
      promisedBy: hoursFromNow(-8),
      technician: technicians[1]!,
      visit: { n: 1, of: 2 },
      valuePaise: 9_50_000,
    },
    {
      site: at("Mrs. Deshpande"),
      serviceType: "Refrigerator repair",
      slot: "11:30",
      status: "ASSIGNED" as const,
      priority: "normal" as const,
      promisedBy: hoursFromNow(30),
      technician: technicians[0]!,
      visit: null,
      valuePaise: 1_20_000,
    },
  ];

  /*
    Numbers drawn from the real series, not invented.

    `J-DAY-01` parsed as sequence 1, so the numbering screen — which compares
    the counter against every document present — saw a job numbered 1 beside a
    counter at 475 and reported four hundred missing numbers. The fixture was
    manufacturing the very defect that screen exists to find.
  */
  const numbers = await Promise.all(
    day.map(async () =>
      formatNumber(
        "job",
        "J",
        await nextJobSerial(branchId),
        new Date(),
      ),
    ),
  );

  const inserted = await db
    .insert(jobs)
    .values(
      day.map((j, i) => ({
        tenantId,
        branchId,
        jobNumber: numbers[i]!,
        customerId: j.site.customerId,
        siteId: j.site.siteId,
        serviceType: j.serviceType,
        scheduledDate: today,
        slot: j.slot,
        status: j.status,
        priority: j.priority,
        promisedBy: j.promisedBy,
        primaryTechnicianId: j.technician?.id ?? null,
        visitNumber: j.visit?.n ?? null,
        visitOf: j.visit?.of ?? null,
        valuePaise: j.valuePaise,
      })),
    )
    .returning({ id: jobs.id, jobNumber: jobs.jobNumber, status: jobs.status });

  // `On site since 11:42` reads off the last transition, so the busy jobs need one.
  const movements = inserted.filter((j) => j.status === "EN_ROUTE" || j.status === "ON_SITE");
  if (movements.length > 0) {
    await db.insert(jobEvents).values(
      movements.map((j, i) => ({
        tenantId,
        jobId: j.id,
        label: j.status === "EN_ROUTE" ? "Left for site" : "Reached site",
        occurredAt: hoursFromNow(-1 - i * 0.5),
      })),
    );
  }

  await db.insert(jobs).values([
    {
      tenantId,
      branchId,
      jobNumber: formatNumber("job", "J", await nextJobSerial(branchId), new Date()),
      customerId: at("Shakti").customerId,
      siteId: at("Shakti").siteId,
      serviceType: "Chiller AMC",
      scheduledDate: tomorrow,
      slot: "9-1",
      status: "ASSIGNED" as const,
      primaryTechnicianId: technicians[0]!.id,
    },
    {
      tenantId,
      branchId,
      jobNumber: formatNumber("job", "J", await nextJobSerial(branchId), new Date()),
      customerId: at("Green Park").customerId,
      siteId: at("Green Park").siteId,
      serviceType: "AC service",
      scheduledDate: tomorrow,
      slot: "1-5",
      status: "CREATED" as const,
    },
  ]);

  /*
    Two leads due today. Created rather than borrowed: the leads left behind by
    the flow tests are WON and LOST, and a closed lead is correctly excluded
    from "due today" — reusing them made the count read zero and looked like a
    query bug when it was a fixture bug.
  */
  await db
    .delete(leads)
    .where(and(eq(leads.tenantId, tenantId), inArray(leads.reference, ["L-DAY-01", "L-DAY-02"])));
  const open = await db
    .insert(leads)
    .values([
      {
        tenantId,
        reference: "L-DAY-01",
        name: "Kohli Residency",
        phoneE164: "+919810011223",
        locality: "Dwarka",
        source: "Referral",
        stage: "NEW" as const,
        nextFollowUpAt: hoursFromNow(4),
        // FR-103: whoever took it earns the incentive, so it is never blank.
        takenByUserId: people.find((p) => p.role === "marketing")?.id ?? null,
      },
      {
        tenantId,
        reference: "L-DAY-02",
        name: "Bharat Foods cold storage",
        phoneE164: "+919810044556",
        locality: "Narela",
        source: "Website",
        stage: "QUOTED" as const,
        quotedPaise: 2_85_000_00,
        nextFollowUpAt: hoursFromNow(-20),
        takenByUserId: people.find((p) => p.role === "marketing")?.id ?? null,
        ownerUserId: people.find((p) => p.role === "marketing")?.id ?? null,
      },
    ])
    .returning({ id: leads.id });

  /*
    A part fitted on a job that is in no catalogue — §6.14's second exception.

    A technician writes what he used on the job card, nobody adds it to the
    catalogue, and it is bought again next month because no reorder level
    exists for a part the system has never heard of.
  */
  const [alreadyFitted] = await db
    .select({ id: jobParts.id })
    .from(jobParts)
    .where(and(eq(jobParts.tenantId, tenantId), eq(jobParts.name, "Thermostat KSD301")))
    .limit(1);
  if (!alreadyFitted && inserted[4]) {
    await db.insert(jobParts).values({
      tenantId,
      jobId: inserted[4].id,
      name: "Thermostat KSD301",
      code: "90322000",
      qty: 1,
      unit: "no",
      ratePaise: 85_000,
      ratePercent: 18,
    });
  }

  console.log(`seeded ${inserted.length} jobs for ${today}, 2 for ${tomorrow}, ${open.length} leads due`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seedDay();
  process.exit(0);
}
