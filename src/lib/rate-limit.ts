/**
 * Slowing down guessing at the sign-in doors.
 *
 * Nothing else in this API is rate limited, and that is deliberate: an
 * authenticated caller is already known and already accountable. These four
 * endpoints are the only ones a stranger can reach, and each is expensive in a
 * different currency:
 *
 * - **`/auth/password`** — free guesses at a password.
 * - **`/auth/otp/request`** — a real SMS, which costs real money once MSG91 is
 *   connected, and which arrives on somebody's actual phone. Unlimited requests
 *   is a way to bill us and harass a technician in the same breath.
 * - **`/auth/otp/verify`** — the challenge already stops at five attempts, but
 *   nothing stopped a caller asking for a new challenge and starting again.
 * - **`/auth/refresh`** — guesses at a token.
 *
 * **Two keys per attempt, never one.** Limiting by identifier alone lets anyone
 * lock a named person out of their own account by burning their allowance;
 * limiting by IP alone is beaten by rotating addresses. Both must pass, and the
 * identifier budget is the looser of the two for exactly that reason.
 */
import { sql } from "drizzle-orm";
import type { Context } from "hono";

import { adminDb as db } from "../db/client.ts";

export type Limit = { max: number; windowSeconds: number };

/**
 * The budgets.
 *
 * Chosen against how a real person behaves, not against a round number. Five
 * password failures in fifteen minutes is more than anybody types by accident
 * and far less than a dictionary needs. Three OTPs an hour to one number covers
 * "it did not arrive, send it again" twice over.
 */
export const LIMITS = {
  /** Only failures count, so signing in often costs nothing. */
  passwordPerAccount: { max: 5, windowSeconds: 15 * 60 },
  passwordPerIp: { max: 20, windowSeconds: 15 * 60 },

  /*
    Every request counts: each one is an SMS whether or not anyone wanted it.

    Five rather than three. Three covers "it did not arrive, send it again"
    exactly twice, and a technician standing outside a plant at seven in the
    morning on a patchy network gets there faster than an attacker does — at
    which point the limit is costing the firm a job rather than saving it an
    SMS. Five still makes bombing somebody's phone pointless.
  */
  otpRequestPerPhone: { max: 5, windowSeconds: 60 * 60 },
  otpRequestPerIp: { max: 10, windowSeconds: 60 * 60 },

  otpVerifyPerPhone: { max: 10, windowSeconds: 15 * 60 },
  otpVerifyPerIp: { max: 30, windowSeconds: 15 * 60 },

  refreshPerIp: { max: 30, windowSeconds: 15 * 60 },
} as const satisfies Record<string, Limit>;

/**
 * Who is asking, as well as this can be known.
 *
 * `x-forwarded-for` is a list the client can prepend to, so only the **last**
 * entry is trustworthy — and only when the proxy in front is ours. Taking the
 * first would let a caller pick their own rate-limit bucket by sending a header,
 * which is worse than not limiting by IP at all because it looks like it works.
 */
export function callerIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-real-ip") ??
    // Node adapter. Absent under other runtimes, which is why it is last.
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket
      ?.remoteAddress ??
    "unknown"
  );
}

export type Verdict = { allowed: true } | { allowed: false; retryAfter: number };

/** Count one hit against a key. Atomic — see `0006_rate_limits.sql`. */
export async function consume(key: string, limit: Limit): Promise<Verdict> {
  const result = await db.execute(
    sql`select * from consume_rate_limit(${key}, ${limit.max}, ${limit.windowSeconds})`,
  );
  const row = (
    (result as unknown as { rows?: { allowed: boolean; retry_after: number }[] }).rows ??
    (result as unknown as { allowed: boolean; retry_after: number }[])
  )[0];

  // Fail open on a limiter fault rather than locking every user out of the
  // product. A limiter that cannot read its own table is an outage; refusing
  // all sign-ins would turn it into a worse one.
  if (!row) return { allowed: true };

  return row.allowed ? { allowed: true } : { allowed: false, retryAfter: row.retry_after };
}

/** A successful sign-in forgets the failures that preceded it. */
export async function clear(key: string): Promise<void> {
  await db.execute(sql`select clear_rate_limit(${key})`);
}

/**
 * Check every key, and report the longest wait among those that failed.
 *
 * All of them are consumed even when the first refuses — an attacker must not
 * be able to keep their IP budget intact by always tripping the account budget
 * first.
 */
export async function consumeAll(
  entries: [key: string, limit: Limit][],
): Promise<Verdict> {
  const verdicts = await Promise.all(entries.map(([key, limit]) => consume(key, limit)));
  const refused = verdicts.filter((v): v is { allowed: false; retryAfter: number } => !v.allowed);
  if (refused.length === 0) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(...refused.map((v) => v.retryAfter)) };
}

/**
 * The refusal.
 *
 * Deliberately says nothing about *which* budget ran out or whether the account
 * exists — the whole point of the neutral sign-in messages is undone by a 429
 * that only ever appears for real accounts.
 */
export function tooMany(c: Context, retryAfter: number): Response {
  c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      error: `Too many attempts. Try again in ${waitWord(retryAfter)}.`,
      retryAfter,
    },
    429,
  );
}

/**
 * The wait, in words, matching the header.
 *
 * "Wait a few minutes" was the first wording, and the OTP budget is an hour —
 * so the sentence and the `Retry-After` beside it disagreed. Somebody told to
 * wait a few minutes who is actually locked out for an hour will try again
 * four times and conclude the product is broken.
 */
function waitWord(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}
