import type { Context, MiddlewareHandler, Next } from "hono";
import { jwtVerify, SignJWT } from "jose";
import { can, type Permission, type Role } from "./roles.ts";

/**
 * Who is calling, which tenant they belong to, and what they may do.
 *
 * **The rule this file exists to make unavoidable.** Every handler runs with a
 * caller already resolved, and every query is scoped to that caller's tenant.
 * Multi-tenant leaks happen when someone writes one query that forgets the
 * `where`, so the tenant is never a parameter a handler can omit — it comes
 * from the token and is read off the context.
 */

export type Caller = {
  userId: string;
  tenantId: string;
  branchId: string | null;
  role: Role;
  /** FR-1301: a level grants extra permissions within a role. */
  level: string | null;
  name: string;
  /** True while the password in use was chosen by somebody else. */
  mustChangePassword?: boolean;
};

export type AppEnv = { Variables: { caller: Caller } };

const encoder = new TextEncoder();

function secret(): Uint8Array {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    // Refused rather than defaulted. A development fallback secret is how a
    // development secret reaches production.
    throw new Error("JWT_SECRET must be set and at least 32 characters");
  }
  return encoder.encode(value);
}

/** Fifteen minutes. Long enough not to nag, short enough that a leak expires. */
export const ACCESS_TOKEN_TTL = "15m";
/** Thirty days, and rotated on use — a technician should not sign in daily. */
export const REFRESH_TOKEN_TTL = "30d";

export async function issueAccessToken(caller: Caller): Promise<string> {
  return new SignJWT({
    tenantId: caller.tenantId,
    branchId: caller.branchId,
    role: caller.role,
    level: caller.level,
    name: caller.name,
    // Rides in the token so the gate below costs no database read.
    mustChangePassword: caller.mustChangePassword ?? false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(caller.userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(secret());
}

/**
 * Resolve the caller, or refuse.
 *
 * There is no anonymous mode and no "if no token, assume owner" branch. A route
 * that should be public is mounted before this middleware, deliberately, so
 * that being public is a decision somebody made rather than a check somebody
 * forgot.
 */
export const requireCaller: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Sign in to continue" }, 401);
  }

  try {
    const { payload } = await jwtVerify(header.slice(7), secret());
    if (typeof payload.sub !== "string" || typeof payload.tenantId !== "string") {
      return c.json({ error: "That token is not usable" }, 401);
    }
    c.set("caller", {
      userId: payload.sub,
      tenantId: payload.tenantId,
      branchId: (payload.branchId as string | null) ?? null,
      role: payload.role as Role,
      level: (payload.level as string | null) ?? null,
      name: (payload.name as string) ?? "Unknown",
      mustChangePassword: payload.mustChangePassword === true,
    });
  } catch {
    // Expired and forged are the same answer to the caller. Telling them which
    // is a small gift to somebody probing.
    return c.json({ error: "Sign in again" }, 401);
  }

  /*
    A password somebody else chose is a shared secret until it is replaced.

    Enforced here rather than in the interface, because a screen that merely
    redirects is a screen an API client walks straight past — and the whole
    point is that this credential cannot be used to do work. The only thing a
    caller in this state may reach is the change itself.
  */
  /*
    Two exceptions, not one. `/api/me` has to answer or the app cannot find out
    *why* it is being refused — it would read the 403 as "not signed in" and
    send the reader to the sign-in screen they have just come from, in a loop.
  */
  const caller = c.get("caller");
  const allowedWhileLocked = c.req.path === "/api/me/password" || c.req.path === "/api/me";
  if (caller.mustChangePassword && !allowedWhileLocked) {
    return c.json(
      {
        error: "Choose your own password before you carry on.",
        mustChangePassword: true,
      },
      403,
    );
  }

  await next();
};

/**
 * Refuse a request the caller's role does not allow.
 *
 * The message names the permission and the role, because the person reading it
 * is nearly always a real colleague who needs to know who to ask — the same
 * reasoning as the `Requires` component in the web app.
 */
export function requirePermission(
  permission: Permission,
): MiddlewareHandler<AppEnv> {
  return async (c: Context<AppEnv>, next: Next) => {
    const caller = c.get("caller");
    if (!can(caller.role, permission, undefined, caller.level)) {
      return c.json(
        {
          error: `A ${caller.role} cannot do this`,
          needs: permission,
          role: caller.role,
        },
        403,
      );
    }
    await next();
  };
}

/**
 * FR-1302 — strip what a role may not see, rather than hiding it.
 *
 * The web app greys prices out for a technician. That is an interface courtesy:
 * the numbers are still in the payload and the payload is readable with any
 * developer console. This removes the keys before the response is serialised,
 * so there is nothing to reveal.
 *
 * Takes the field names explicitly instead of guessing from a suffix — a
 * `valuePaise` a technician may not see and a `qty` he must are both numbers,
 * and a clever heuristic would eventually strip the wrong one.
 */
export function stripFields<T>(
  rows: T[],
  fields: readonly (keyof T)[],
): Partial<T>[] {
  return rows.map((row) => {
    const copy: Partial<T> = { ...row };
    for (const field of fields) delete copy[field];
    return copy;
  });
}

/** The money fields a technician never receives when the toggle is off. */
export const PRICE_FIELDS = [
  "valuePaise",
  "ratePaise",
  "annualValuePaise",
  "grandTotalPaise",
  "taxablePaise",
] as const;
