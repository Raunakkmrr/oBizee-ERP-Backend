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
import { timingSafeEqual } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { adminDb, db } from "../db/client.ts";
import { customers, jobs, reminders, tenants } from "../db/schema.ts";
import { audit } from "../lib/audit.ts";
import { drainReminders, enqueueReminders } from "../lib/notify/run.ts";
import { DevSender } from "../lib/notify/sender.ts";
import { MailgunSender } from "../lib/notify/mailgun.ts";
import type { Sender } from "../lib/notify/sender.ts";
import { apiRouter } from "../lib/router.ts";
import { zBody } from "../lib/validate.ts";

export const reminderRoutes = apiRouter();

/**
 * Mounted OUTSIDE `/api`, deliberately.
 *
 * `app.use("/api/*", requireCaller)` demands a signed-in caller, and a
 * scheduler has no token — so a cron endpoint under `/api` would be refused
 * before it ever reached its own secret check, and would have failed silently
 * every night.
 */
export const cronRoutes = apiRouter();

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


/**
 * The nightly run, for every tenant, called by a scheduler.
 *
 * **Why this is separate from `/run` and not just an unauthenticated version of
 * it.** `/run` is a person pressing a button: it carries their token, their
 * tenant and their permission, and it belongs on the screen so a stalled cron
 * can be recovered by hand. This one has no person behind it, so it is guarded
 * by a shared secret and iterates every tenant — and it must never be reachable
 * without that secret, because it writes jobs and sends messages to real
 * customers.
 *
 * **Timing-safe comparison**, because a plain `===` on a secret leaks its
 * length and prefix to anyone patient enough to measure. Cheap to do right.
 *
 * Fires from EventBridge Scheduler, Vercel Cron, GitHub Actions or a crontab
 * with `curl` — the endpoint does not care which, which is the point. What it
 * does care about is being safe to call twice, and it is: visit generation
 * dedupes on `visitKey` and reminders on `reminders_dedupe_uq`.
 */
cronRoutes.post("/daily", async (c) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    /*
      Refused rather than defaulted open. A scheduler endpoint that runs without
      a configured secret is one anybody can use to message a firm's entire
      customer list.
    */
    return c.json({ error: "CRON_SECRET is not configured, so this endpoint is closed" }, 503);
  }

  const offered = c.req.header("x-cron-secret") ?? "";
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  const authorised = a.length === b.length && timingSafeEqual(a, b);
  if (!authorised) return c.json({ error: "Not authorised" }, 401);

  const today = todayInIndia();
  const senders = sendersFrom();

  /*
    `adminDb` only to list the tenants. Everything inside the loop runs through
    the tenant-scoped client — `enqueueReminders` and `drainReminders` establish
    their own scope — so one firm's run can never read or write another's.
  */
  const all = await adminDb.select({ id: tenants.id, name: tenants.legalName }).from(tenants);

  const results = [];
  for (const tenant of all) {
    try {
      const enqueued = await enqueueReminders(tenant.id, today);
      const drained = await drainReminders(tenant.id, senders);
      results.push({ tenant: tenant.name, ...enqueued, ...drained });
    } catch (cause) {
      /*
        One tenant's failure must not stop the rest. A cron that dies on the
        third of forty firms leaves thirty-seven with no reminders and nothing
        to say so — which is the silent failure this whole feature exists to
        avoid, reproduced at the top level.
      */
      results.push({ tenant: tenant.name, error: String(cause) });
    }
  }

  return c.json({ today, tenants: results.length, results });
});
