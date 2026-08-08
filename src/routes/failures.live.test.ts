/**
 * How this API refuses — checked against a running server.
 *
 * Success paths get tested because somebody wanted them to work. Failure
 * paths get tested because nobody did, which is why an ad-hoc sweep found
 * twelve endpoints answering a truncated request body with **500 Something
 * went wrong at our end** — blaming the server for the caller's malformed
 * JSON, and putting a trivially-reachable 500 in the logs where a real fault
 * would have to hide.
 *
 * The rules asserted here:
 *
 * - **No 5xx is reachable by sending bad input.** A 500 must mean *we* broke.
 * - **Every read refuses without a token**, so no handler can be added that
 *   quietly forgets tenant scoping.
 * - **Every refusal has the same shape** — `{ error: "a sentence" }` — because
 *   the web client reads `body.error`, and an endpoint answering with a
 *   serialised ZodError renders as `[object Object]`.
 *
 * Skipped when the server is not running, so `vitest run` stays green offline.
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";

const BASE = process.env.API_URL ?? "http://localhost:8787";

const reachable = await fetch(`${BASE}/health`)
  .then((r) => r.ok)
  .catch(() => false);

/** Every read the app makes. Added to whenever a screen gains one. */
const READS = [
  "/api/customers",
  "/api/board/today",
  "/api/leads",
  "/api/money/overview",
  "/api/home/snapshot",
  "/api/home/owner",
  "/api/reports/weekly",
  "/api/gst/2026-08",
  "/api/jobs",
  "/api/contracts",
  "/api/invoices",
  "/api/vendors",
  "/api/vendors/bills",
  "/api/advances",
  "/api/payments/receivables",
];

/** Every write. The body is deliberately empty — this is about refusing. */
const WRITES = [
  "/api/leads",
  "/api/customers",
  "/api/jobs",
  "/api/invoices",
  "/api/payments",
  "/api/advances",
  "/api/vendors",
  "/api/vendors/bills",
  "/api/contracts",
  "/api/vendors/advise",
];

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!reachable)("how the API refuses", () => {
  let auth: Record<string, string>;

  beforeAll(async () => {
    /*
      This file deliberately signs in wrongly, and wrong sign-ins are now
      counted. Left alone, running the suite three times in fifteen minutes
      locks the seeded owner out and every later assertion fails as 401 —
      which looks like the API broke rather than the limiter working.

      So the test clears the budgets it is about to spend. Only these keys, and
      only for the seeded development account.
    */
    for (const key of [
      "pw:account:manish@shakticooling.test",
      "pw:account:nobody@shakticooling.test",
      "pw:ip:unknown",
      "pw:ip:127.0.0.1",
      "pw:ip:::1",
      "otp:req:phone:919820012345",
      "otp:req:phone:919999888877",
      "otp:req:ip:unknown",
      "otp:req:ip:127.0.0.1",
      "otp:req:ip:::1",
    ]) {
      await db.execute(sql`select clear_rate_limit(${key})`);
    }

    const res = await fetch(`${BASE}/auth/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "manish@shakticooling.test",
        password: "obizee-dev-2026",
      }),
    });
    const { accessToken } = (await res.json()) as { accessToken: string };
    auth = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
  });

  it("refuses every read without a token", async () => {
    const statuses = await Promise.all(
      READS.map(async (path) => [path, (await fetch(`${BASE}${path}`)).status] as const),
    );
    expect(statuses.filter(([, status]) => status !== 401)).toEqual([]);
  });

  it("refuses a token that is not one", async () => {
    for (const token of ["garbage", "a.b.c", ""]) {
      const res = await fetch(`${BASE}/api/customers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status, `token "${token}"`).toBe(401);
    }
  });

  it("answers a malformed body with 400, never 500", async () => {
    // The failure a flaky mobile connection produces most often.
    const results = await Promise.all(
      WRITES.map(async (path) => {
        const res = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: auth,
          body: "{not json",
        });
        return [path, res.status] as const;
      }),
    );
    expect(results.filter(([, status]) => status !== 400)).toEqual([]);
  });

  it("answers an empty body with 400 and names a field", async () => {
    for (const path of WRITES) {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: auth,
        body: "{}",
      });
      expect(res.status, path).toBe(400);

      const body = (await res.json()) as { error: string };
      // A sentence, not a serialised ZodError.
      expect(typeof body.error, `${path} error type`).toBe("string");
      expect(body.error.length, `${path} error empty`).toBeGreaterThan(0);
    }
  });

  it("answers a malformed id with 400, not a database fault", async () => {
    const res = await fetch(`${BASE}/api/job/not-a-uuid`, { headers: auth });
    expect(res.status).toBe(400);
  });

  it("answers a missing row with 404", async () => {
    const cases: [string, RequestInit][] = [
      [`/api/job/${NIL_UUID}`, {}],
      [`/api/invoices/${NIL_UUID}`, {}],
      [`/api/customers/${NIL_UUID}`, {}],
      [
        `/api/leads/${NIL_UUID}`,
        { method: "PATCH", body: JSON.stringify({ outcome: "Spoke" }) },
      ],
      [
        `/api/vendors/bills/${NIL_UUID}/pay`,
        { method: "POST", body: JSON.stringify({ paidOn: "2026-08-08" }) },
      ],
    ];
    for (const [path, init] of cases) {
      const res = await fetch(`${BASE}${path}`, { ...init, headers: auth });
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses a period that is not one", async () => {
    expect((await fetch(`${BASE}/api/gst/nonsense`, { headers: auth })).status).toBe(400);
  });

  it("404s an unknown route rather than falling through", async () => {
    expect((await fetch(`${BASE}/api/does-not-exist`, { headers: auth })).status).toBe(404);
  });

  describe("sign-in", () => {
    const post = (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    it("does not 500 on a malformed body", async () => {
      // auth.ts was the one route file on a bare Hono instance, so it had no
      // error mapping at all and answered this with a stack-trace 500.
      expect((await post("/auth/password", "{oops")).status).toBe(400);
    });

    it("refuses a wrong password and an unknown email identically", async () => {
      const wrong = await post("/auth/password", {
        email: "manish@shakticooling.test",
        password: "wrong",
      });
      const unknown = await post("/auth/password", {
        email: "nobody@shakticooling.test",
        password: "wrong",
      });

      // Same status and same words: an attacker must not learn who works here.
      expect(wrong.status).toBe(unknown.status);
      const asError = async (r: Response) => ((await r.json()) as { error: string }).error;
      expect(await asError(wrong)).toBe(await asError(unknown));
    });

    it("refuses a phone that is not a number, but not one that is merely unknown", async () => {
      for (const phone of ["abc", "12345", ""]) {
        expect((await post("/auth/otp/request", { phone })).status, phone).toBe(400);
      }

      /*
        A registered number and a well-formed unknown one must be
        indistinguishable, or the endpoint becomes a way to ask who works here.
      */
      const registered = await post("/auth/otp/request", { phone: "9820012345" });
      const unknown = await post("/auth/otp/request", { phone: "9999888877" });
      expect(registered.status).toBe(unknown.status);
      expect(await registered.json()).toEqual(await unknown.json());
    });

    it("refuses a refresh token that is not one", async () => {
      const res = await post("/auth/refresh", { refreshToken: "nope" });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });
});
