import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, count, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.ts";
import {
  contacts,
  customers,
  invoices,
  jobs,
  leadActivities,
  leads,
  payments,
  sites,
  users,
} from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { e164 } from "../lib/phone.ts";
import { formatNumber, nextInSeries } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";

/**
 * Leads — FR-101 to FR-107.
 *
 * Two rules from the PRD are enforced here rather than left to the interface,
 * because the interface is a courtesy and this is the record:
 *
 * - **FR-103.** `taken_by` is who earns the incentive and is **immutable**.
 *   `owner` is who works it and may change. Conflating them is how a
 *   commission argument starts, so the update route refuses `takenByUserId`.
 * - **FR-104.** A lead with no next date gets forgotten, so the date is
 *   required and must be in the future. A past date is not a follow-up.
 */
export const leadRoutes = apiRouter();

/** FR-105 — a closed list. Free text here becomes an unanalysable funnel. */
const SOURCES = [
  "Phone", "WhatsApp", "Walk-in", "Referral", "Website", "Repeat customer",
  "Field/Marketing", "AMC renewal",
] as const;

/** §6.6.3's closed outcome list — free text alone is useless for reporting. */
const OUTCOMES = [
  "Spoke", "No answer", "Busy", "Asked to call later", "Sent quote", "Won", "Lost",
] as const;

/**
 * Which bucket a lead falls in — §6.6.1.
 *
 * `unassigned` outranks `overdue` deliberately: a lead nobody owns is a worse
 * failure than a lead whose owner is late, because nobody is even responsible
 * for it. The grouping is computed here rather than in the browser so the
 * counts and the rows cannot disagree.
 */
function groupOf(
  ownerUserId: string | null,
  next: Date | null,
  now: Date,
): { group: string; dueWord: string; daysOverdue: number } {
  if (!ownerUserId) return { group: "unassigned", dueWord: "No owner", daysOverdue: 0 };
  if (!next) return { group: "later", dueWord: "No date", daysOverdue: 0 };

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((next.getTime() - startOfToday.getTime()) / 86_400_000);

  if (days < 0) {
    const late = Math.abs(days);
    return {
      group: "overdue",
      dueWord: late === 1 ? "1 day late" : `${late} days late`,
      daysOverdue: late,
    };
  }
  if (days === 0) return { group: "today", dueWord: "Due today", daysOverdue: 0 };
  if (days === 1) return { group: "tomorrow", dueWord: "Due tomorrow", daysOverdue: 0 };
  if (days <= 7) return { group: "this_week", dueWord: `Due in ${days} days`, daysOverdue: 0 };
  return {
    group: "later",
    dueWord: next.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    daysOverdue: 0,
  };
}

leadRoutes.get("/", requirePermission("lead:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const now = new Date();

  const owner = alias(users, "owner_user");
  const taker = alias(users, "taken_by_user");

  const rows = await db
    .select({
      lead: leads,
      ownerName: owner.name,
      takenByName: taker.name,
    })
    .from(leads)
    .leftJoin(owner, eq(leads.ownerUserId, owner.id))
    .leftJoin(taker, eq(leads.takenByUserId, taker.id))
    .where(and(eq(leads.tenantId, tenantId), notInArray(leads.stage, ["WON", "LOST"])))
    // FR-107: the default view is a dated follow-up queue, oldest first.
    .orderBy(asc(leads.nextFollowUpAt));

  /*
    The last thing said, per lead. One query for the whole page rather than one
    per row — §6.6.2 puts this on every row, so N+1 here is N+1 on every load.
  */
  const activity = rows.length
    ? await db
        .select({
          leadId: leadActivities.leadId,
          outcome: leadActivities.outcome,
          note: leadActivities.note,
          occurredAt: leadActivities.occurredAt,
        })
        .from(leadActivities)
        .where(
          and(
            eq(leadActivities.tenantId, tenantId),
            inArray(
              leadActivities.leadId,
              rows.map((r) => r.lead.id),
            ),
          ),
        )
        .orderBy(desc(leadActivities.occurredAt))
    : [];

  const latest = new Map<string, (typeof activity)[number]>();
  for (const a of activity) if (!latest.has(a.leadId)) latest.set(a.leadId, a);

  const out = rows.map(({ lead, ownerName, takenByName }) => {
    const bucket = groupOf(lead.ownerUserId, lead.nextFollowUpAt, now);
    const last = latest.get(lead.id);
    return {
      id: lead.id,
      reference: lead.reference,
      name: lead.name,
      locality: lead.locality ?? "—",
      phone: lead.phoneE164 ?? "",
      stage: lead.stage,
      ...bucket,
      lastActivity: last
        ? {
            date: last.occurredAt.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
            text: last.note ? `${last.outcome} — ${last.note}` : last.outcome,
          }
        : null,
      // §6.6.4: a quote that is not there renders `—`, never ₹0.
      quotedPaise: lead.stage === "QUOTED" ? lead.quotedPaise : null,
      quotedUnavailable: lead.stage === "QUOTED" && lead.quotedPaise === null,
      owner: ownerName,
      source: lead.source,
      // FR-103: immutable, and shown as a real column rather than on hover (D6).
      takenBy: takenByName ?? "—",
    };
  });

  return c.json({
    leads: out,
    tomorrowCount: out.filter((l) => l.group === "tomorrow").length,
  });
});

/**
 * FR-102 — duplicate and existing-customer detection, on the phone number.
 *
 * Advisory, never blocking: two customers really can share a landline, and a
 * shop's number really can appear twice. The caller is told what exists and
 * decides.
 */
leadRoutes.get("/lookup", requirePermission("lead:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const phone = e164(c.req.query("phone"));
  if (!phone) return c.json({ match: null });

  /*
    One statement, and the reason is the budget.

    §9.1 gives this 250ms at p95 because the panel has to appear while the
    customer is still talking. Written as five sequential queries — lead, then
    customer, then job history, then open jobs, then the ledger — it measured
    477ms, and none of that was the database working: each was a separate round
    trip to Neon, about a hundred milliseconds of Delhi-to-Singapore apiece.
    Composed into one it is a single trip, and the shape of the answer is
    unchanged.

    Two rules the branches encode. An open lead wins — `converted_customer_id
    is null` is what makes it open, and without that clause somebody who became
    a customer last March came back as a lead, so the coordinator was told to
    run a sales cycle at a customer of six months. A matched customer carries
    the three facts §6.7.2 says decide her next sentence: how well they are
    known, whether somebody is already going, and whether they owe us money.
  */
  const found = await db.execute(sql`
    with lead_hit as (
      select l.id, l.reference, l.name, l.stage,
             u.name as owner_name, l.next_follow_up_at
        from leads l
        left join users u on u.id = l.owner_user_id
       where l.tenant_id = ${tenantId}
         and l.phone_e164 = ${phone}
         and l.converted_customer_id is null
       limit 1
    ),
    customer_hit as (
      select c.id, c.name
        from contacts ct
        join sites s on s.id = ct.site_id
        join customers c on c.id = s.customer_id
       where ct.tenant_id = ${tenantId}
         and ct.phone_e164 = ${phone}
         and not exists (select 1 from lead_hit)
       limit 1
    ),
    history as (
      select
        count(*) filter (where j.status in ('WORK_DONE','SIGNED_OFF')) as past_jobs,
        max(j.scheduled_date) filter (where j.status in ('WORK_DONE','SIGNED_OFF')) as last_job_date,
        count(*) filter (where j.status not in ('WORK_DONE','SIGNED_OFF','CANCELLED')) as open_jobs
        from jobs j
       where j.tenant_id = ${tenantId}
         and j.customer_id = (select id from customer_hit)
    ),
    -- Issued only. A draft is not a demand, and telling somebody they owe money
    -- on a document never sent is how a coordinator ends up apologising.
    ledger as (
      select coalesce(sum(i.grand_total_paise), 0) as billed,
             coalesce(sum(paid.amount), 0) as paid
        from invoices i
        left join lateral (
          select sum(p.amount_paise) as amount
            from payments p where p.invoice_id = i.id
        ) paid on true
       where i.tenant_id = ${tenantId}
         and i.customer_id = (select id from customer_hit)
         and i.status = 'ISSUED'
    )
    select
      (select id from lead_hit) as lead_id,
      (select reference from lead_hit) as lead_reference,
      (select name from lead_hit) as lead_name,
      (select stage from lead_hit) as lead_stage,
      (select owner_name from lead_hit) as lead_owner,
      (select next_follow_up_at from lead_hit) as lead_next,
      (select id from customer_hit) as customer_id,
      (select name from customer_hit) as customer_name,
      (select past_jobs from history) as past_jobs,
      (select last_job_date from history) as last_job_date,
      (select open_jobs from history) as open_jobs,
      (select billed from ledger) as billed,
      (select paid from ledger) as paid
  `);

  const [row] = found.rows as {
    lead_id: string | null;
    lead_reference: string | null;
    lead_name: string | null;
    lead_stage: string | null;
    lead_owner: string | null;
    lead_next: string | null;
    customer_id: string | null;
    customer_name: string | null;
    past_jobs: number | null;
    last_job_date: string | null;
    open_jobs: number | null;
    billed: string | null;
    paid: string | null;
  }[];

  if (row?.lead_id) {
    return c.json({
      match: {
        kind: "lead",
        leadId: row.lead_id,
        reference: row.lead_reference,
        name: row.lead_name,
        stage: row.lead_stage,
        // Unassigned is a real state and the screen says so, rather than
        // printing nothing and leaving the coordinator to guess who to ask.
        owner: row.lead_owner ?? "Unassigned",
        nextFollowUp: row.lead_next ?? "",
      },
    });
  }

  if (!row?.customer_id) return c.json({ match: null });

  return c.json({
    match: {
      kind: "customer",
      customerId: row.customer_id,
      name: row.customer_name,
      pastJobs: Number(row.past_jobs ?? 0),
      lastJobDate: row.last_job_date ?? null,
      openJobs: Number(row.open_jobs ?? 0),
      outstandingPaise: Number(row.billed ?? 0) - Number(row.paid ?? 0),
    },
  });
});

const newLead = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(1),
  locality: z.string().trim().optional(),
  source: z.enum(SOURCES),
  quotedPaise: z.number().int().positive().nullable().optional(),
  /** FR-104 — required, and in the future. */
  nextFollowUpAt: z.string().datetime(),
  ownerUserId: z.string().uuid().nullable().optional(),
});

leadRoutes.post(
  "/",
  requirePermission("lead:write"),
  zBody( newLead),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const phone = e164(body.phone);
    if (!phone) {
      return c.json(
        { error: "That is not a number we can dial — ten digits, or with +91" },
        400,
      );
    }
    if (new Date(body.nextFollowUpAt).getTime() <= Date.now()) {
      // A date in the past is not a follow-up; it is a lead already forgotten.
      return c.json({ error: "The follow-up date must be in the future" }, 400);
    }

    const [counted] = await db
      .select({ value: count() })
      .from(leads)
      .where(eq(leads.tenantId, caller.tenantId));

    const sequence = Number(counted?.value ?? 0) + 1;
    const now = new Date();
    const reference = `L-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}-${String(sequence).padStart(4, "0")}`;

    const [lead] = await db
      .insert(leads)
      .values({
        tenantId: caller.tenantId,
        reference,
        name: body.name,
        phoneE164: phone,
        locality: body.locality ?? null,
        source: body.source,
        quotedPaise: body.quotedPaise ?? null,
        nextFollowUpAt: new Date(body.nextFollowUpAt),
        // FR-103: whoever captured it earns the incentive, and it never moves.
        takenByUserId: caller.userId,
        ownerUserId: body.ownerUserId ?? caller.userId,
      })
      .returning();

    await audit(caller, "CREATE_LEAD", `Captured ${body.name} from ${body.source}`, {
      table: "leads",
      id: lead!.id,
    });
    return c.json(lead, 201);
  },
);

leadRoutes.patch(
  "/:id",
  requirePermission("lead:write"),
  zBody(
    z.object({
      stage: z.enum(["NEW", "CONTACTED", "QUOTED", "WON", "LOST"]).optional(),
      ownerUserId: z.string().uuid().nullable().optional(),
      quotedPaise: z.number().int().positive().nullable().optional(),
      nextFollowUpAt: z.string().datetime().nullable().optional(),
      /*
        FR-104 asks for an outcome *and* a next date. The outcome used to be
        accepted by the interface and dropped here, which left every row on the
        queue rendering "Activity unavailable" — the screen's highest-value
        element, permanently blank. A closed list, per §6.6.3.
      */
      outcome: z.enum(OUTCOMES).optional(),
      note: z.string().max(500).optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.tenantId, caller.tenantId)))
      .limit(1);
    if (!lead) return c.json({ error: "No such lead" }, 404);

    /*
      FR-104's block, with its one exception. Won and Lost end a lead's life in
      the queue, so they are the only stages that may clear the date.
    */
    const terminal = body.stage === "WON" || body.stage === "LOST";
    if (!terminal && body.nextFollowUpAt === null) {
      return c.json({ error: "Only a won or lost lead may have no next date" }, 400);
    }

    const [updated] = await db
      .update(leads)
      .set({
        stage: body.stage ?? lead.stage,
        ownerUserId: body.ownerUserId === undefined ? lead.ownerUserId : body.ownerUserId,
        quotedPaise: body.quotedPaise === undefined ? lead.quotedPaise : body.quotedPaise,
        nextFollowUpAt: terminal
          ? null
          : body.nextFollowUpAt
            ? new Date(body.nextFollowUpAt)
            : lead.nextFollowUpAt,
      })
      .where(eq(leads.id, id))
      .returning();

    if (body.outcome) {
      await db.insert(leadActivities).values({
        tenantId: caller.tenantId,
        leadId: id,
        outcome: body.outcome,
        note: body.note ?? null,
        actorUserId: caller.userId,
      });
    }

    await audit(caller, "UPDATE_LEAD", `${lead.reference} → ${body.stage ?? "updated"}`, {
      table: "leads",
      id,
    });
    return c.json(updated);
  },
);

/**
 * FR-106 — convert, with nothing retyped.
 *
 * A won lead becomes a customer if it is not one already, and then either a
 * one-off job or an AMC. The two are genuinely different products — one bills
 * once, the other generates a year of visits — so the caller chooses; this
 * never guesses.
 */
leadRoutes.post(
  "/:id/convert",
  requirePermission("lead:write"),
  zBody(
    z.object({
      to: z.enum(["job", "customer"]),
      site: z.object({
        label: z.string().default("Main site"),
        addressLine1: z.string().trim().min(1),
        locality: z.string().trim().min(2),
        city: z.string().trim().min(1),
        stateCode: z.string().regex(/^[0-9]{2}$/),
        pincode: z.string().regex(/^[1-8][0-9]{5}$/),
        landmark: z.string().nullable().optional(),
      }),
      serviceType: z.string().trim().min(2).optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.tenantId, caller.tenantId)))
      .limit(1);
    if (!lead) return c.json({ error: "No such lead" }, 404);
    if (lead.convertedCustomerId) {
      return c.json({ error: "That lead is already converted" }, 409);
    }

    const [customer] = await db
      .insert(customers)
      .values({
        tenantId: caller.tenantId,
        name: lead.name,
        customerType: "BUSINESS",
        gstin: null,
        billingStateCode: body.site.stateCode,
        creditDays: 30,
      })
      .returning();

    const [site] = await db
      .insert(sites)
      .values({
        tenantId: caller.tenantId,
        customerId: customer!.id,
        label: body.site.label,
        addressLine1: body.site.addressLine1,
        locality: body.site.locality,
        city: body.site.city,
        stateCode: body.site.stateCode,
        pincode: body.site.pincode,
        landmark: body.site.landmark ?? null,
      })
      .returning();

    // Conversion implies the lead is won, so it is recorded here rather than
    // asked for again on the next screen.
    await db
      .update(leads)
      .set({ stage: "WON", nextFollowUpAt: null, convertedCustomerId: customer!.id })
      .where(eq(leads.id, id));

    let job = null;
    if (body.to === "job") {
      const branchId = caller.branchId;
      if (!branchId) return c.json({ error: "No branch on file" }, 400);
      const now = new Date();
      const sequence = await nextInSeries(caller.tenantId, branchId, "job", now);
      [job] = await db
        .insert(jobs)
        .values({
          tenantId: caller.tenantId,
          branchId,
          jobNumber: formatNumber("job", "J", sequence, now),
          customerId: customer!.id,
          siteId: site!.id,
          fromLeadId: lead.id,
          serviceType: body.serviceType ?? "Service visit",
          status: "CREATED",
        })
        .returning();
    }

    await audit(caller, "CONVERT_LEAD", `${lead.reference} won and converted`, {
      table: "leads",
      id,
    });
    return c.json({ customer, site, job }, 201);
  },
);
