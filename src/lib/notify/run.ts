/**
 * The daily run: put the visits on the board, then decide who to tell.
 *
 * **Safe to run twice, by construction.** Visit generation is already
 * idempotent through `visitKey`; reminder insertion is idempotent through
 * `reminders_dedupe_uq`. So a scheduler that double-fires, a Lambda retry, or
 * somebody re-running it by hand cannot put a second job on the board or send a
 * customer a second message. That property is the reason this is an outbox and
 * not a loop of `send()` calls.
 */
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import { db, currentTenant, withTenant } from "../../db/client.ts";
import {
  contacts,
  customers,
  jobs,
  reminders,
  sites,
  tenants,
  users,
} from "../../db/schema.ts";
import { addDays, planReminders, sendableAt, type PlannableJob } from "../reminders.ts";
import type { Sender } from "./sender.ts";

/** Desks that should see the digest — the people who fix an unassigned visit. */
const OFFICE_ROLES = ["owner", "coordinator"] as const;

/**
 * Everything the planner needs, read once.
 *
 * Only the window that can produce a reminder today — T-7 and T-1 — rather than
 * every job the firm has ever had. At 1,400 contracts that is the difference
 * between fifty rows and fifty thousand.
 */
async function jobsInWindow(tenantId: string, today: string): Promise<PlannableJob[]> {
  const rows = await db
    .select({
      id: jobs.id,
      jobNumber: jobs.jobNumber,
      scheduledDate: jobs.scheduledDate,
      slot: jobs.slot,
      serviceType: jobs.serviceType,
      status: jobs.status,
      customerName: customers.name,
      siteId: sites.id,
      siteLabel: sites.label,
      siteLocality: sites.locality,
      technicianId: users.id,
      technicianName: users.name,
      technicianPhone: users.phoneE164,
    })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        inArray(jobs.scheduledDate, [addDays(today, 1), addDays(today, 7)]),
      ),
    );

  const siteIds = [...new Set(rows.map((r) => r.siteId))];
  /*
    Opted-out contacts are excluded here rather than filtered later.

    Business-initiated WhatsApp needs consent, and an opt-out that some caller
    has to remember is an opt-out that will eventually be forgotten. Dropping
    them at the read means no downstream code can message them by accident.
  */
  const reachable = siteIds.length
    ? await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.tenantId, tenantId),
            inArray(contacts.siteId, siteIds),
            eq(contacts.remindersOptedOut, false),
          ),
        )
    : [];

  return rows.map((r) => {
    const forSite = reachable.filter((c) => c.siteId === r.siteId);
    // The primary is "who do I ring"; anyone is better than nobody.
    const contact = forSite.find((c) => c.isPrimary) ?? forSite[0];
    return {
      id: r.id,
      jobNumber: r.jobNumber,
      scheduledDate: r.scheduledDate,
      slot: r.slot,
      serviceType: r.serviceType,
      status: r.status,
      customerName: r.customerName,
      siteLabel: r.siteLabel ?? "the site",
      siteLocality: r.siteLocality ?? "",
      technician:
        r.technicianId && r.technicianName
          ? { id: r.technicianId, name: r.technicianName, phoneE164: r.technicianPhone }
          : null,
      customerContact: contact
        ? { name: contact.name, phoneE164: contact.phoneE164, email: contact.email }
        : null,
    } satisfies PlannableJob;
  });
}

export type RunSummary = { planned: number; inserted: number };

/** Raise today's reminders. Sends nothing — that is the drain's job. */
export async function enqueueReminders(tenantId: string, today: string): Promise<RunSummary> {
  /*
    Scoped explicitly, because the caller that matters has no request.

    `db` is tenant-scoped through an AsyncLocalStorage that a request populates,
    and these two functions exist to be called by a scheduler — where there is
    no request and every query throws "a tenant-scoped query ran outside a
    request". Establishing the scope here means one implementation serves both
    the operator pressing the button and the cron that normally fires it.
  */
  if (currentTenant() !== tenantId) {
    return withTenant(tenantId, () => enqueueReminders(tenantId, today));
  }
  const [tenant] = await db
    .select({ name: tenants.legalName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const office = await db
    .select({ email: users.email, id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(users.active, true),
        inArray(users.role, [...OFFICE_ROLES]),
      ),
    );

  const planned = planReminders({
    jobs: await jobsInWindow(tenantId, today),
    today,
    firmName: tenant?.name ?? "your service provider",
    officeEmails: office
      .filter((p): p is { email: string; id: string } => Boolean(p.email))
      .map((p) => ({ email: p.email, userId: p.id })),
  });

  if (planned.length === 0) return { planned: 0, inserted: 0 };

  const scheduledFor = sendableAt(new Date());
  const written = await db
    .insert(reminders)
    .values(
      planned.map((p) => ({
        tenantId,
        jobId: p.jobId,
        kind: p.kind,
        channel: p.channel,
        audience: p.audience,
        recipient: p.recipient,
        recipientUserId: p.recipientUserId,
        templateKey: p.templateKey,
        payload: { ...p.payload, body: p.body, ...(p.subject ? { subject: p.subject } : {}) },
        scheduledFor,
        dedupeKey: p.dedupeKey,
      })),
    )
    // The constraint is the idempotency. A second run adds nothing.
    .onConflictDoNothing({ target: [reminders.tenantId, reminders.dedupeKey] })
    .returning({ id: reminders.id });

  return { planned: planned.length, inserted: written.length };
}

export type DrainSummary = { sent: number; failed: number; held: number };

/**
 * Send what is due, and record what happened to each.
 *
 * A failure is written down rather than thrown: one dead number must not stop
 * the other forty-nine, and the row it leaves behind is what puts the problem
 * in front of a human instead of losing it in a log.
 */
export async function drainReminders(
  tenantId: string,
  senders: Partial<Record<"whatsapp" | "email", Sender>>,
  now = new Date(),
): Promise<DrainSummary> {
  // Same reason as `enqueueReminders`: the scheduler has no request context.
  if (currentTenant() !== tenantId) {
    return withTenant(tenantId, () => drainReminders(tenantId, senders, now));
  }
  const due = await db
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.tenantId, tenantId),
        eq(reminders.state, "pending"),
        lte(reminders.scheduledFor, now),
      ),
    )
    .limit(200);

  let sent = 0;
  let failed = 0;
  let held = 0;

  for (const row of due) {
    const sender = senders[row.channel];
    if (!sender) {
      // No provider for this channel yet. Held, not failed — nothing is wrong
      // with the message, and marking it failed would hide a real failure later.
      held += 1;
      continue;
    }

    const payload = (row.payload ?? {}) as Record<string, string>;
    const result = await sender.send({
      to: row.recipient,
      templateKey: row.templateKey,
      variables: payload,
      // Spread rather than assigned: `exactOptionalPropertyTypes` treats an
      // explicit `undefined` as different from an absent key, and it is.
      ...(payload.subject ? { subject: payload.subject } : {}),
      body: payload.body ?? "",
    });

    if (result.ok) {
      await db
        .update(reminders)
        .set({ state: "sent", sentAt: new Date(), attempts: row.attempts + 1 })
        .where(eq(reminders.id, row.id));
      sent += 1;
    } else {
      await db
        .update(reminders)
        .set({
          // Retryable stays pending so the next run picks it up; anything else
          // is final and belongs on somebody's screen.
          state: result.retryable ? "pending" : "failed",
          attempts: row.attempts + 1,
          lastError: result.error,
        })
        .where(eq(reminders.id, row.id));
      failed += 1;
    }
  }

  return { sent, failed, held };
}
