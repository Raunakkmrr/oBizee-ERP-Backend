import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { hashPassword, verifyPassword } from "../auth/password.ts";
import { accessSessionActive, consumeActiveRefresh, createPasswordAuthSession,
  revokeSessionByRefresh } from "../auth/z-sessions.ts";
import { activeUser, passwordCandidates, saveRefresh, revokeRefresh,
  type TenantUser } from "./store.ts";

export const PASSWORD_REFUSAL = "That email and password do not match";
const ISSUER = "obizee-erp-tenant";
const AUDIENCE = "service-erp";
function key(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error("Tenant JWT_SECRET is not configured");
  return new TextEncoder().encode(value);
}
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function identity(user: TenantUser) {
  return { id: user.id, tenantId: user.tenantId, name: user.name, role: user.role,
    level: user.level, mustChangePassword: user.mustChangePassword };
}

async function issue(user: TenantUser, sessionId: string) {
  const accessToken = await new SignJWT({ tenantId: user.tenantId, sid: sessionId })
    .setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setIssuer(ISSUER)
    .setAudience(AUDIENCE).setIssuedAt().setExpirationTime("15m").sign(key());
  const refreshToken = randomBytes(32).toString("base64url");
  await saveRefresh(user.tenantId, user.id, sessionId, tokenHash(refreshToken));
  return { accessToken, refreshToken, user: { name: user.name, role: user.role } };
}

export async function passwordSignIn(email: string, password: string) {
  const candidates = await passwordCandidates(email.trim().toLowerCase());
  const matches: TenantUser[] = [];
  if (!candidates.length) await hashPassword(password);
  for (const user of candidates) {
    if (!user.passwordHash || !user.active) { await hashPassword(password); continue; }
    if (await verifyPassword(user.passwordHash, password)) matches.push(user);
  }
  // Email is tenant-scoped in the database. Never choose an arbitrary company.
  if (matches.length !== 1) return null;
  const matched = matches[0]!;
  const current = await activeUser(matched.tenantId, matched.id);
  if (!current || current.passwordHash !== matched.passwordHash || current.email !== matched.email) return null;
  const sessionId = await createPasswordAuthSession(current.tenantId, current.id,
    matched.passwordHash!, matched.email!);
  if (!sessionId) return null;
  return issue(current, sessionId);
}

export async function refreshSession(token: string) {
  const consumed = await consumeActiveRefresh(tokenHash(token));
  if (!consumed) return null;
  const user = await activeUser(consumed.tenantId, consumed.userId);
  if (!user || !await accessSessionActive(consumed.tenantId, consumed.userId, consumed.sessionId)) return null;
  return issue(user, consumed.sessionId);
}

export async function currentIdentity(token: string) {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key(), {
      algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE,
    }));
  } catch { return null; }
  if (typeof payload.sub !== "string" || typeof payload.tenantId !== "string" ||
      typeof payload.sid !== "string") return null;
  if (!await accessSessionActive(payload.tenantId, payload.sub, payload.sid)) return null;
  const user = await activeUser(payload.tenantId, payload.sub);
  return user ? identity(user) : null;
}

export async function signOut(token: string): Promise<void> {
  const hash = tokenHash(token);
  await revokeSessionByRefresh(hash);
  await revokeRefresh(hash);
}
