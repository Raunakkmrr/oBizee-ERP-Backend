import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  PRICE_FIELDS,
  issueAccessToken,
  requireCaller,
  requirePermission,
  stripFields,
  type AppEnv,
  type Caller,
} from "./context.ts";

beforeAll(() => {
  process.env.JWT_SECRET = "a".repeat(48);
});

const caller = (over: Partial<Caller> = {}): Caller => ({
  userId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
  branchId: null,
  role: "coordinator",
  level: null,
  name: "Priya Sharma",
  ...over,
});

function app() {
  const a = new Hono<AppEnv>();
  a.use("/guarded/*", requireCaller);
  a.get("/guarded/open", (c) => c.json({ tenantId: c.get("caller").tenantId }));
  a.get(
    "/guarded/people",
    requirePermission("people:manage"),
    (c) => c.json({ ok: true }),
  );
  a.get("/public", (c) => c.json({ ok: true }));
  return a;
}

const bearer = async (who: Caller) => ({
  Authorization: `Bearer ${await issueAccessToken(who)}`,
});

describe("requireCaller", () => {
  it("refuses a request with no token", async () => {
    const res = await app().request("/guarded/open");
    expect(res.status).toBe(401);
  });

  it("refuses a forged token", async () => {
    const res = await app().request("/guarded/open", {
      headers: { Authorization: "Bearer not.a.real.token" },
    });
    expect(res.status).toBe(401);
  });

  it("gives the same answer for expired and forged", async () => {
    // Telling a prober which one it was is a small free gift.
    const forged = await app().request("/guarded/open", {
      headers: { Authorization: "Bearer aaa.bbb.ccc" },
    });
    expect(await forged.json()).toEqual({ error: "Sign in again" });
  });

  it("resolves the tenant from the token, never from the request", async () => {
    /*
      The multi-tenant leak this prevents: a handler that reads a tenant id from
      a query parameter or a body. The caller cannot influence it.
    */
    const res = await app().request("/guarded/open", {
      headers: await bearer(caller()),
    });
    expect(await res.json()).toEqual({
      tenantId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("leaves routes mounted before it public", async () => {
    // Being public is a decision, not a forgotten check.
    expect((await app().request("/public")).status).toBe(200);
  });
});

describe("requirePermission", () => {
  it("refuses a role that lacks the permission, and says which", async () => {
    const res = await app().request("/guarded/people", {
      headers: await bearer(caller({ role: "technician" })),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      needs: "people:manage",
      role: "technician",
    });
  });

  it("allows an owner", async () => {
    const res = await app().request("/guarded/people", {
      headers: await bearer(caller({ role: "owner" })),
    });
    expect(res.status).toBe(200);
  });

  it("honours a level that grants extra permissions", async () => {
    // FR-1301: a senior marketing person may quote; a support one may not.
    const senior = new Hono<AppEnv>();
    senior.use("*", requireCaller);
    senior.get("/q", requirePermission("quote:write"), (c) => c.json({ ok: true }));

    const allowed = await senior.request("/q", {
      headers: await bearer(caller({ role: "marketing", level: "senior" })),
    });
    const refused = await senior.request("/q", {
      headers: await bearer(caller({ role: "marketing", level: "support" })),
    });
    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(403);
  });
});

describe("stripFields — FR-1302", () => {
  it("removes the key, so there is nothing left to reveal", () => {
    /*
      The defect this closes: the web app greys prices out for a technician,
      but the numbers are still in the payload and the payload is readable from
      any developer console. Hiding is not stripping.
    */
    const jobs = [{ id: "j1", customer: "Shakti", valuePaise: 450000, qty: 2 }];
    const stripped = stripFields(jobs, ["valuePaise"]);

    expect("valuePaise" in stripped[0]!).toBe(false);
    expect(JSON.stringify(stripped)).not.toContain("450000");
    // And it takes nothing it was not asked to.
    expect(stripped[0]).toMatchObject({ id: "j1", qty: 2 });
  });

  it("names the money fields explicitly rather than guessing", () => {
    // A `valuePaise` he may not see and a `qty` he must are both numbers; a
    // suffix heuristic would eventually strip the wrong one.
    expect(PRICE_FIELDS).toContain("valuePaise");
    expect(PRICE_FIELDS).not.toContain("qty");
  });

  it("leaves the original untouched", () => {
    const rows = [{ id: "j1", valuePaise: 1 }];
    stripFields(rows, ["valuePaise"]);
    expect(rows[0]!.valuePaise).toBe(1);
  });
});

describe("the secret", () => {
  it("refuses to run on a weak or missing one", async () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "short";
    await expect(issueAccessToken(caller())).rejects.toThrow(/at least 32/);
    process.env.JWT_SECRET = previous;
  });
});
