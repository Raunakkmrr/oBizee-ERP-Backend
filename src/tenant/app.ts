import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { zBody } from "../lib/validate.ts";
import { clearRefreshCookie, readRefreshToken, setRefreshCookie,
  wantsTokenInBody } from "../auth/refresh-cookie.ts";
import { clear, consumeAll, LIMITS, refund, tooMany } from "../lib/rate-limit.ts";
import { currentIdentity, passwordSignIn, PASSWORD_REFUSAL,
  refreshSession, signOut, tokenHash } from "./service.ts";
import { cohortAllowed } from "./entitlements.ts";

const REFRESH_PER_TOKEN = { max: 30, windowSeconds: 15 * 60 };

/** Explicit tenant cohort only. No control-plane, OTP, or wholesale A–Z router. */
export function createTenantApp() {
  const app = new Hono<{ Variables: {
    caller: NonNullable<Awaited<ReturnType<typeof currentIdentity>>>;
  } }>();
  const origins = (process.env.WEB_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  app.use("*", cors({ origin: origin => origins.includes(origin) ? origin : null,
    credentials: true, allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Token-Delivery"],
    exposeHeaders: ["Retry-After"], maxAge: 600 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    if (origin && !origins.includes(origin)) return c.json({ error: "Origin is not allowed" }, 403);
    await next();
  });
  app.get("/health", c => c.json({ ok: true, service: "tenant-auth" }));
  app.post("/auth/password", zBody(z.object({ email: z.string().email(),
    password: z.string().min(1).max(200) })), async c => {
    const body = c.req.valid("json");
    const email = body.email.toLowerCase().trim();
    // Gateway sees SSR egress, not the viewer. A persisted IP lockout here
    // would let one stranger exhaust every company's sign-in budget.
    const verdict = await consumeAll([[`pw:account:${email}`, LIMITS.passwordPerAccount]]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);
    const result = await passwordSignIn(email, body.password);
    if (!result) return c.json({ error: PASSWORD_REFUSAL }, 401);
    await clear(`pw:account:${email}`);
    setRefreshCookie(c, result.refreshToken);
    return c.json({ accessToken: result.accessToken, user: result.user,
      ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}) });
  });
  app.post("/auth/refresh", zBody(z.object({ refreshToken: z.string().min(1).optional() })), async c => {
    const token = readRefreshToken(c, c.req.valid("json").refreshToken);
    if (!token) return c.json({ error: "Sign in again" }, 401);
    // Only this unguessable presented credential can spend its own budget.
    // Persist a digest, never the credential itself; no shared anonymous key.
    const budget = `refresh:token:${tokenHash(token)}`;
    const verdict = await consumeAll([[budget, REFRESH_PER_TOKEN]]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);
    const result = await refreshSession(token);
    if (!result) { clearRefreshCookie(c); return c.json({ error: "Sign in again" }, 401); }
    await refund(budget);
    setRefreshCookie(c, result.refreshToken);
    return c.json({ accessToken: result.accessToken,
      ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}) });
  });
  app.post("/auth/sign-out", zBody(z.object({ refreshToken: z.string().min(1).optional() }).optional()), async c => {
    const token = readRefreshToken(c, c.req.valid("json")?.refreshToken);
    if (token) await signOut(token);
    clearRefreshCookie(c);
    return c.json({ signedOut: true });
  });
  app.get("/api/me", async c => {
    const header = c.req.header("authorization");
    const user = header?.startsWith("Bearer ") ? await currentIdentity(header.slice(7)) : null;
    return user ? c.json(user) : c.json({ error: "Sign in again" }, 401);
  });
  // Every data request revalidates SID + active user + lifecycle before policy.
  // No tenant/actor/role supplied by the browser is used as authority.
  app.use("/api/core/*", async (c, next) => {
    const header = c.req.header("authorization");
    const user = header?.startsWith("Bearer ") ? await currentIdentity(header.slice(7)) : null;
    if (!user) return c.json({ error: "Sign in again" }, 401);
    c.set("caller", user);
    await next();
  });
  app.get("/api/core/workspace", async c => {
    const user = c.get("caller");
    if (!cohortAllowed("overview")) return c.json({ error: "Workspace access is unavailable" }, 403);
    const result = await (await import("./workspace.ts")).readWorkspace(user);
    return result ? c.json(result) : c.json({ error: "Company information is unavailable" }, 503);
  });
  app.get("/api/core/customers", async c => {
    const user = c.get("caller");
    if (!cohortAllowed("customers")) return c.json({ error: "Customer access is unavailable" }, 403);
    const page = z.coerce.number().int().min(0).max(10000).safeParse(c.req.query("page") ?? "0");
    if (!page.success) return c.json({ error: "Invalid page" }, 400);
    return c.json(await (await import("./workspace.ts")).readCustomers(user, page.data));
  });
  app.post("/api/core/customers", zBody(z.object({
    id: z.string().uuid(), branchId: z.string().uuid(), name: z.string().trim().min(1).max(200),
    customerType: z.enum(["INDIVIDUAL", "BUSINESS"]),
    billingStateCode: z.string().regex(/^(0[1-9]|[12][0-9]|3[0-8]|97)$/),
    addressLine1: z.string().trim().min(1).max(300), locality: z.string().trim().min(1).max(120),
    city: z.string().trim().min(1).max(120), pincode: z.string().regex(/^[1-9][0-9]{5}$/),
  }).strict()), async c => {
    const user = c.get("caller");
    if (!cohortAllowed("customers")) return c.json({ error: "Customer access is unavailable" }, 403);
    const result = await (await import("./workspace.ts")).createCustomer(user, c.req.valid("json"));
    return result ? c.json(result, result.created ? 201 : 200) :
      c.json({ error: "This request could not be saved. Reload and try again." }, 409);
  });
  // Never echo SQL errors, credentials, tokens, or upstream configuration.
  app.onError(() => new Response(JSON.stringify({ error: "Sign-in service is unavailable" }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" },
  }));
  return app;
}
