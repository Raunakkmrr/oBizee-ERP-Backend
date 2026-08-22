/**
 * Reminders — what has been raised, what went out, and what failed.
 *
 * **The failure list is the reason this has a screen at all.** A reminder
 * system that fails quietly is worse than none: people stop remembering
 * visits themselves precisely because the system now does it, so a message
 * that never arrives is a visit nobody is expecting and an invoice nobody
 * raises. Every send that will not succeed has to land in front of a person
 * who can pick up a phone.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import { customers, jobs, reminders } from "../db/schema.ts";
import { audit } from "../lib/audit.ts";
import { drainReminders, enqueueReminders } from "../lib/notify/run.ts";
import { DevSender } from "../lib/notify/sender.ts";
import { MailgunSender } from "../lib/notify/mailgun.ts";
import type { Sender } from "../lib/notify/sender.ts";
import { apiRouter } from "../lib/router.ts";
import { zBody } from "../lib/validate.ts";

export const reminderRoutes = apiRouter();

/**
 * Which providers are live, decided once from the environment.
 *
 * `DevSender` throws in production, so a deployment that forgot to configure
 * Mailgun stops at the first run rather than reporting a month of reminders as
 * sent while telling nobody.
 */
function sendersFrom(env: NodeJS.ProcessEnv = process.env): Partial<Record<"whatsapp" | "email", Sender>> {
  const out: Partial<Record<"whatsapp" | "email", Sender>> = {};
  out.email = env.MAILGUN_API_KEY ? new MailgunSender(env) : new DevSender("email", env);
  /*
    WhatsApp has no provider yet: the firm has no WhatsApp Business number, and
    Meta's verification and template approval are procurement, not engineering.
    Until then the dev sender records what would have gone, so the mechanism is
    exercised and demonstrable without pretending a message was delivered.
  */
  out.whatsapp = new DevSender("whatsapp", env);
  return out;
}

/** `2026-08-24` in the only timezone this product operates in. */
function todayInIndia(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

reminderRoutes.get("/", requirePermission("job:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const rows = await db
    .select({
      id: reminders.id,
      kind: reminders.kind,
      channel: reminders.channel,
      audience: reminders.audience,
      recipient: reminders.recipient,
      state: reminders.state,
      lastError: reminders.lastError,
      scheduledFor: reminders.scheduledFor,
      sentAt: reminders.sentAt,
      jobNumber: jobs.jobNumber,
      customer: customers.name,
    })
    .from(reminders)
    .leftJoin(jobs, eq(reminders.jobId, jobs.id))
    .leftJoin(customers, eq(jobs.customerId, customers.id))
    .where(eq(reminders.tenantId, tenantId))
    .orderBy(desc(reminders.createdAt))
    .limit(200);

  return c.json({
    reminders: rows,
    /*
      Counted here rather than in the browser, because the number that matters
      — how many customers were NOT told — must be the same on every screen
      that shows it.
    */
    failed: rows.filter((r) => r.state === "failed").length,
  });
});

/**
 * Run today's reminders.
 *
 * Deliberately a POST an operator can press as well as a scheduler can call.
 * A cron that silently stopped is the second-worst failure here, and a human
 * being able to force a run is how it gets noticed and recovered.
 */
reminderRoutes.post(
  "/run",
  requirePermission("job:write"),
  zBody(z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })),
  async (c) => {
    const caller = c.get("caller");
    const today = c.req.valid("json").today ?? todayInIndia();

    const enqueued = await enqueueReminders(caller.tenantId, today);
    const drained = await drainReminders(caller.tenantId, sendersFrom());

    await audit(
      caller,
      "RUN_REMINDERS",
      `Raised ${enqueued.inserted} reminder(s) for ${today}; sent ${drained.sent}, failed ${drained.failed}`,
      { table: "reminders", id: caller.tenantId },
    );

    return c.json({ today, ...enqueued, ...drained });
  },
);
