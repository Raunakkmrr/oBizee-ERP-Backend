import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { otpChallenges, refreshTokens, users } from "../db/schema.ts";
import { issueAccessToken, type Caller } from "./context.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import type { OtpSender } from "./otp-sender.ts";

/**
 * Signing in — FR-1301.
 *
 * One identity, two ways to prove it: field staff by phone and a one-time code,
 * office staff by email and a password. Both land in the same `users` row and
 * produce the same tokens, so nothing downstream needs to know which was used.
 *
 * Three rules the routes above this rely on:
 *
 * 1. **Requesting a code never reveals whether the number exists.** The reply
 *    and the timing are identical either way. Otherwise the endpoint is a
 *    directory of who works here.
 * 2. **A code works once.** `consumed_at` is set the moment it verifies, so a
 *    code read over someone's shoulder is spent by the time it is reused.
 * 3. **Five attempts.** Six digits is a hundred thousand guesses, which is
 *    nothing; the counter lives on the challenge because the thing being
 *    protected is this phone number, not an IP address.
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Codes are hashed like passwords. A leaked table must not be a list of codes. */
function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type SignInResult =
  | { kind: "ok"; accessToken: string; refreshToken: string; caller: Caller }
  | { kind: "refused"; reason: string };

/**
 * Request a code.
 *
 * Always resolves. The caller cannot tell a real number from an unknown one,
 * and no code is stored for a number nobody has.
 */
export async function requestOtp(
  phoneE164: string,
  sender: OtpSender,
): Promise<void> {
  const [user] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.phoneE164, phoneE164))
    .limit(1);

  // A deactivated technician keeps his history and loses his way in.
  if (!user || !user.active) return;

  const code = await sender.send(phoneE164);
  await db.insert(otpChallenges).values({
    phoneE164,
    userId: user.id,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
}

export async function verifyOtp(
  phoneE164: string,
  code: string,
): Promise<SignInResult> {
  const [challenge] = await db
    .select()
    .from(otpChallenges)
    .where(and(eq(otpChallenges.phoneE164, phoneE164), isNull(otpChallenges.consumedAt)))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);

  if (!challenge) return { kind: "refused", reason: "Ask for a new code" };
  if (challenge.expiresAt.getTime() < Date.now()) {
    return { kind: "refused", reason: "That code has expired — ask for a new one" };
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { kind: "refused", reason: "Too many tries — ask for a new code" };
  }

  if (!constantTimeEquals(hashCode(code), challenge.codeHash)) {
    await db
      .update(otpChallenges)
      .set({ attempts: challenge.attempts + 1 })
      .where(eq(otpChallenges.id, challenge.id));
    return { kind: "refused", reason: "That code is not right" };
  }

  // Spent before the tokens are issued, so a replay in flight finds it gone.
  await db
    .update(otpChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(otpChallenges.id, challenge.id));

  return challenge.userId ? issueFor(challenge.userId) : { kind: "refused", reason: "Ask for a new code" };
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Same answer whether the address is unknown, the password is wrong, or the
  // account is switched off — three different facts, one reply.
  const refused: SignInResult = {
    kind: "refused",
    reason: "That email and password do not match",
  };
  if (!user?.passwordHash || !user.active) {
    // Still spend the time, so timing does not become the oracle.
    await hashPassword(password);
    return refused;
  }
  if (!(await verifyPassword(user.passwordHash, password))) return refused;

  return issueFor(user.id);
}

async function issueFor(userId: string): Promise<SignInResult> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { kind: "refused", reason: "That account is gone" };

  const caller: Caller = {
    userId: user.id,
    tenantId: user.tenantId,
    branchId: user.branchId,
    role: user.role,
    level: user.level,
    name: user.name,
  };

  const refresh = randomBytes(32).toString("base64url");
  await db.insert(refreshTokens).values({
    tenantId: user.tenantId,
    userId: user.id,
    tokenHash: hashCode(refresh),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });

  return {
    kind: "ok",
    accessToken: await issueAccessToken(caller),
    refreshToken: refresh,
    caller,
  };
}

/**
 * Exchange a refresh token, rotating it.
 *
 * The old token is revoked and the new one records what it replaced. A stolen
 * token used after the real one has rotated shows up as a revoked token being
 * presented — the only reliable signal that a session was lifted.
 */
export async function rotateRefresh(token: string): Promise<SignInResult> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashCode(token)))
    .limit(1);

  if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    return { kind: "refused", reason: "Sign in again" };
  }

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.id, row.id));

  const issued = await issueFor(row.userId);
  if (issued.kind === "ok") {
    await db
      .update(refreshTokens)
      .set({ rotatedFrom: row.id })
      .where(eq(refreshTokens.tokenHash, hashCode(issued.refreshToken)));
  }
  return issued;
}

export { hashPassword } from "./password.ts";
