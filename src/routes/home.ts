/**
 * The post-login snapshot — PRD §6.2, and the owner's version, §6.3.
 *
 * **The one decision:** *is today going well, and if not, what do I do about
 * it in the next five minutes?* Which is why nothing here is a bare number.
 * Every figure is either something to act on or something that tells the owner
 * he can stop looking.
 *
 * Money is wrapped in a `{ok, value} | {ok:false, reason}` union rather than
 * defaulted to zero. FR-1301: a figure that could not be computed and a figure
 * that is genuinely zero look identical once you default, and only one of them
 * means "nothing is overdue".
 */
import { and, desc, eq, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import {
  contractSchedules,
  contracts,
  customers,
  invoices,
  jobEvents,
  jobs,
  leads,
  payments,
  signOffs,
  sites,
  users,
} from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";

export const homeRoutes = apiRouter();

/** FR-1301's honest money: a computed figure, or the reason there isn't one. */
function ok(value: number) {
  return { ok: true as const, value };
}

function todayInIndia(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function daysBetween(from: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);
}

/**
 * Everything both home screens need, gathered once.
 *
 * The owner's home and the coordinator's home are different screens with
 * different verbs, but they answer their questions off the same facts. Reading
 * them twice is how the two end up disagreeing about how much came in today.
 */
async function snapshot(tenantId: string) {
  const now = new Date();
  const today = todayInIndia(0);
  const tomorrow = todayInIndia(1);

  const [
    todayJobs,
    tomorrowJobRows,
    receipts,
    openInvoices,
    paidRows,
    scheduleRows,
    ratings,
    staleLeads,
  ] = await Promise.all([
    db
      .select({
        id: jobs.id,
        status: jobs.status,
        technicianId: jobs.primaryTechnicianId,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.scheduledDate, today))),
    db
      .select({ id: jobs.id, technicianId: jobs.primaryTechnicianId })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.scheduledDate, tomorrow))),
    db
      .select({ amountPaise: payments.amountPaise })
      .from(payments)
      .where(and(eq(payments.tenantId, tenantId), eq(payments.receivedOn, today))),
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        issueDate: invoices.issueDate,
        grandTotalPaise: invoices.grandTotalPaise,
        customerId: invoices.customerId,
        customer: customers.name,
        creditDays: customers.creditDays,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "ISSUED"))),
    db
      .select({ invoiceId: payments.invoiceId, paid: sql<string>`sum(${payments.amountPaise})` })
      .from(payments)
      .where(eq(payments.tenantId, tenantId))
      .groupBy(payments.invoiceId),
    db
      .select({
        contractId: contracts.id,
        customer: customers.name,
        endDate: contracts.endDate,
        annualValuePaise: contracts.annualValuePaise,
        visitsCommitted: contractSchedules.visitsCommitted,
      })
      .from(contracts)
      .innerJoin(customers, eq(contracts.customerId, customers.id))
      .leftJoin(contractSchedules, eq(contractSchedules.contractId, contracts.id))
      .where(and(eq(contracts.tenantId, tenantId), eq(contracts.status, "ACTIVE"))),
    db
      .select({
        // A sign-off is one per job, so the job id is its identity.
        jobId: signOffs.jobId,
        rating: signOffs.rating,
        signerName: signOffs.signerName,
      })
      .from(signOffs)
      .where(and(eq(signOffs.tenantId, tenantId), lte(signOffs.rating, 2))),
    db
      .select({
        id: leads.id,
        reference: leads.reference,
        name: leads.name,
        phoneE164: leads.phoneE164,
        nextFollowUpAt: leads.nextFollowUpAt,
        ownerUserId: leads.ownerUserId,
      })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, tenantId),
          sql`${leads.stage} not in ('WON', 'LOST')`,
          lt(leads.nextFollowUpAt, sql`now()`),
        ),
      ),
  ]);

  const done = todayJobs.filter((j) => ["WORK_DONE", "SIGNED_OFF"].includes(j.status));
  const inProgress = todayJobs.filter((j) =>
    ["EN_ROUTE", "ON_SITE", "PARTS_AWAITED"].includes(j.status),
  );
  const unassigned = todayJobs.filter((j) => j.technicianId === null);

  // Null, not zero: nothing waiting is a different fact from waiting no time.
  const oldestUnassignedMinutes =
    unassigned.length === 0
      ? null
      : Math.max(
          0,
          Math.round(
            Math.min(...unassigned.map((j) => j.createdAt.getTime())) === Infinity
              ? 0
              : (now.getTime() - Math.min(...unassigned.map((j) => j.createdAt.getTime()))) / 60_000,
          ),
        );

  const paidBy = new Map(paidRows.map((r) => [r.invoiceId, Number(r.paid ?? 0)]));
  const overdueRows = openInvoices
    .map((inv) => ({
      ...inv,
      outstanding: inv.grandTotalPaise - (paidBy.get(inv.id) ?? 0),
      daysLate: daysBetween(inv.issueDate, now) - inv.creditDays,
    }))
    .filter((inv) => inv.outstanding > 0 && inv.daysLate > 0);

  const collectedToday = receipts.reduce((sum, r) => sum + r.amountPaise, 0);

  return {
    now,
    today,
    tomorrow,
    todayJobs,
    tomorrowJobRows,
    done,
    inProgress,
    unassigned,
    oldestUnassignedMinutes,
    collectedToday,
    collectedCount: receipts.length,
    overdueRows,
    scheduleRows,
    ratings,
    staleLeads,
  };
}

homeRoutes.get("/snapshot", requirePermission("job:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const s = await snapshot(tenantId);

  /*
    §6.2's attention list: a full sentence naming the person and the
    consequence, and one thing to do about it. A count with no verb is a
    dashboard, and a dashboard is what this screen exists not to be.
  */
  const attention: Array<{
    id: string;
    kind: string;
    sentence: string;
    detail: string;
    actionLabel: string;
    href: string;
  }> = [];

  for (const r of s.ratings.slice(0, 3)) {
    attention.push({
      id: `rating_${r.jobId}`,
      kind: "bad_rating",
      sentence: `${r.signerName} rated a visit ${r.rating} out of 5.`,
      detail: "A low rating on a completed job usually means a second visit is coming free.",
      actionLabel: "Open the job",
      href: `/jobs/${r.jobId}`,
    });
  }

  const stalled = s.todayJobs.filter((j) => j.status === "PARTS_AWAITED");
  if (stalled.length > 0) {
    attention.push({
      id: "parts_stalled",
      kind: "parts_awaited_stalled",
      sentence: `${stalled.length} ${stalled.length === 1 ? "job is" : "jobs are"} waiting on parts.`,
      detail: "A job in this state bills nothing and holds a slot that could be sold.",
      actionLabel: "See the jobs",
      href: "/board?filter=parts_awaited",
    });
  }

  for (const lead of s.staleLeads.slice(0, 3)) {
    attention.push({
      id: `lead_${lead.id}`,
      kind: "lead_missed_followups",
      sentence: `${lead.name} was due a call and has not had one.`,
      detail: "A lead past its follow-up date converts at a fraction of one called on time.",
      actionLabel: "Call now",
      href: `/leads/${lead.id}`,
    });
  }

  if (s.unassigned.length > 0 && (s.oldestUnassignedMinutes ?? 0) > 60) {
    attention.push({
      id: "unassigned_stale",
      kind: "sla_breach",
      sentence: `${s.unassigned.length} of today's jobs still have nobody assigned.`,
      detail: `The oldest has been waiting ${Math.round((s.oldestUnassignedMinutes ?? 0) / 60)} hours.`,
      actionLabel: "Assign now",
      href: "/board?filter=unassigned",
    });
  }

  /*
    Ageing, in the buckets a collections conversation actually uses. The
    boundaries are not arbitrary: past 90 days an invoice usually needs a
    different conversation from a reminder.
  */
  const buckets = [
    { label: "0–30 days", min: 1, max: 30 },
    { label: "31–60 days", min: 31, max: 60 },
    { label: "61–90 days", min: 61, max: 90 },
    { label: "90+ days", min: 91, max: Infinity },
  ];
  const ageing = buckets.map((b) => {
    const rows = s.overdueRows.filter((r) => r.daysLate >= b.min && r.daysLate <= b.max);
    return {
      label: b.label,
      amount: ok(rows.reduce((sum, r) => sum + r.outstanding, 0)),
      count: rows.length,
    };
  });

  // Contracts whose year is more than half gone with less than half the visits done.
  const byContract = new Map<string, { customer: string; committed: number }>();
  for (const row of s.scheduleRows) {
    const held = byContract.get(row.contractId);
    byContract.set(row.contractId, {
      customer: row.customer,
      committed: (held?.committed ?? 0) + (row.visitsCommitted ?? 0),
    });
  }
  const contractIds = [...byContract.keys()];
  const doneByContract = contractIds.length
    ? await db
        .select({ contractId: contractSchedules.contractId, n: sql<number>`count(*)::int` })
        .from(jobs)
        .innerJoin(contractSchedules, eq(jobs.contractScheduleId, contractSchedules.id))
        .where(
          and(
            eq(jobs.tenantId, tenantId),
            inArray(contractSchedules.contractId, contractIds),
            inArray(jobs.status, ["WORK_DONE", "SIGNED_OFF"]),
          ),
        )
        .groupBy(contractSchedules.contractId)
    : [];
  const doneMap = new Map(doneByContract.map((r) => [r.contractId, r.n]));

  const contractsUnderDelivering = contractIds
    .map((id) => ({
      id,
      customer: byContract.get(id)!.customer,
      visitsDone: doneMap.get(id) ?? 0,
      visitsCommitted: byContract.get(id)!.committed,
    }))
    .filter((row) => row.visitsCommitted > 0 && row.visitsDone * 2 < row.visitsCommitted);

  const renewals = s.scheduleRows.filter((r) => {
    const daysLeft = -daysBetween(r.endDate, s.now);
    return daysLeft >= 0 && daysLeft <= 60;
  });

  return c.json({
    today: {
      jobsToday: s.todayJobs.length,
      done: s.done.length,
      inProgress: s.inProgress.length,
      notStarted: s.todayJobs.length - s.done.length - s.inProgress.length,
      unassigned: s.unassigned.length,
      oldestUnassignedMinutes: s.oldestUnassignedMinutes,
      collectedToday: ok(s.collectedToday),
      collectedCount: s.collectedCount,
      overdue: ok(s.overdueRows.reduce((sum, r) => sum + r.outstanding, 0)),
      overdueInvoices: s.overdueRows.length,
      overdueOldestDays:
        s.overdueRows.length === 0 ? null : Math.max(...s.overdueRows.map((r) => r.daysLate)),
    },
    attention,
    // Week-on-week needs a second period; until the comparison window is
    // stored this stays empty rather than inventing a baseline to beat.
    comparisons: [],
    comingUp: {
      ageing,
      renewalsDue: new Set(renewals.map((r) => r.contractId)).size,
      renewalsValue: ok(
        [...new Map(renewals.map((r) => [r.contractId, r.annualValuePaise])).values()].reduce(
          (sum, v) => sum + v,
          0,
        ),
      ),
      contractsUnderDelivering,
      tomorrowJobs: s.tomorrowJobRows.length,
      tomorrowUnassigned: s.tomorrowJobRows.filter((j) => j.technicianId === null).length,
    },
  });
});

/**
 * §6.3 — the owner's version. Same facts, three verbs.
 *
 * An owner does not dispatch. He wants to know what came in, what is owed, and
 * who he personally has to ring — capped at three, because a list of nine is a
 * list he will not work through.
 */
homeRoutes.get("/owner", requirePermission("report:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const s = await snapshot(tenantId);

  const [everIssued] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId));
  const [everCustomer] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(eq(customers.tenantId, tenantId));
  const [everStaff] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), ne(users.role, "owner")));

  // Worst first: the biggest amount, longest overdue, is the call that pays.
  const worst = [...s.overdueRows]
    .sort((a, b) => b.outstanding * b.daysLate - a.outstanding * a.daysLate)
    .slice(0, 3);

  const phoneRows = worst.length
    ? await db
        .select({ customerId: sites.customerId, phone: sql<string>`min(c.phone_e164)` })
        .from(sites)
        .innerJoin(sql`contacts c`, sql`c.site_id = ${sites.id}`)
        .where(eq(sites.tenantId, tenantId))
        .groupBy(sites.customerId)
    : [];
  const phoneBy = new Map(phoneRows.map((r) => [r.customerId, r.phone]));

  return c.json({
    // A tenant with no invoices gets the setup checklist, not empty charts.
    isNewTenant: (everIssued?.n ?? 0) === 0,
    collectedToday: ok(s.collectedToday),
    collectedCount: s.collectedCount,
    overdue: ok(s.overdueRows.reduce((sum, r) => sum + r.outstanding, 0)),
    overdueCount: s.overdueRows.length,
    counters: [
      { count: s.unassigned.length, label: "Unassigned today", href: "/board?filter=unassigned" },
      {
        count: s.todayJobs.filter((j) => j.status === "PARTS_AWAITED").length,
        label: "Waiting on parts",
        href: "/board?filter=parts_awaited",
      },
      {
        count: s.todayJobs.filter((j) => ["WORK_DONE", "SIGNED_OFF"].includes(j.status)).length,
        label: "Done, not billed",
        href: "/board?filter=done_not_billed",
      },
    ],
    jobsDone: s.done.length,
    jobsTotal: s.todayJobs.length,
    needsYourCall: worst.map((inv) => ({
      id: inv.id,
      badge: `${inv.daysLate}d`,
      who: inv.customer,
      what: `₹${Math.round(inv.outstanding / 100).toLocaleString("en-IN")} on ${inv.number}`,
      meta: `${inv.daysLate} days past terms`,
      phone: phoneBy.get(inv.customerId) ?? "",
      href: `/money?invoice=${inv.id}`,
    })),
    setupSteps: [
      { label: "Add your first customer", done: (everCustomer?.n ?? 0) > 0 },
      { label: "Add your team", done: (everStaff?.n ?? 0) > 0 },
      { label: "Raise your first invoice", done: (everIssued?.n ?? 0) > 0 },
    ],
  });
});
