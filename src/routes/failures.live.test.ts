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

import { adminDb as db } from "../db/client.ts";
import { apiIsLive } from "../db/live.ts";

const BASE = process.env.API_URL ?? "http://localhost:8787";

/* Probed once in db/live.ts rather than per file. */
const reachable = apiIsLive;

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
  "/api/people",
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
  "/api/people",
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
    /*
      On a route that takes only a uuid. `/api/job/:id` is deliberately not one
      of them — it accepts a job number too, because that is what the screen's
      URL carries, so `not-a-uuid` there is a number nobody has rather than a
      malformed id.
    */
    for (const path of ["/api/customers/not-a-uuid", "/api/invoices/not-a-uuid"]) {
      const res = await fetch(`${BASE}${path}`, { headers: auth });
      expect(res.status, path).toBe(400);
    }

    const byNumber = await fetch(`${BASE}/api/job/not-a-uuid`, { headers: auth });
    expect(byNumber.status).toBe(404);
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

  it("refuses an advance settled against another customer's invoice", async () => {
    /*
      Nothing enforced this, and the screen offered whichever invoice happened
      to be newest — so one customer's advance could close against another's
      bill. The credit lands on the wrong ledger and GSTR-1 reports it against
      the wrong GSTIN, which nobody notices once it is on a return.
    */
    const get = async (path: string) =>
      (await fetch(`${BASE}${path}`, { headers: auth })).json() as Promise<{
        customers: { id: string; name: string; sites: { id: string }[] }[];
      }>;
    const { customers } = await get("/api/customers");
    const [a, b] = customers.filter((c) => c.sites.length > 0);
    if (!a || !b) return;

    const post = async (path: string, body: unknown) =>
      (await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();

    const line = [{ description: "guard", code: "9987", kind: "service", qty: 1, ratePaise: 100_00, ratePercent: 18 }];
    const advance = (await post("/api/advances", {
      customerId: a.id,
      receiptPaise: 1_180_00,
      ratePercent: 18,
      receivedOn: new Date().toISOString().slice(0, 10),
    })) as { id: string };
    const theirs = (await post("/api/invoices", {
      customerId: b.id,
      siteId: b.sites[0]!.id,
      lines: line,
    })) as { id: string };

    const res = await fetch(`${BASE}/api/advances/${advance.id}/adjust`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ invoiceId: theirs.id }),
    });
    expect(res.status).toBe(409);
  });

  describe("the team", () => {
    /*
      The one screen where a mistake locks people out of the product rather
      than producing a wrong number. Every assertion here is a lockout that
      would need us to reach into the database to undo.
    */
    async function ownerAuth() {
      return auth;
    }

    it("is owner only", async () => {
      const res = await fetch(`${BASE}/auth/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "priya@shakticooling.test", password: "obizee-dev-2026" }),
      });
      const { accessToken } = (await res.json()) as { accessToken: string };
      const asCoordinator = { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

      // A coordinator who could add a user could add themselves an owner.
      expect((await fetch(`${BASE}/api/people`, { headers: asCoordinator })).status).toBe(403);
      expect(
        (
          await fetch(`${BASE}/api/people`, {
            method: "POST",
            headers: asCoordinator,
            body: JSON.stringify({ name: "Sneaky Owner", role: "owner", email: "x@y.test" }),
          })
        ).status,
      ).toBe(403);
    });

    it("refuses a person who could never sign in", async () => {
      const res = await fetch(`${BASE}/api/people`, {
        method: "POST",
        headers: await ownerAuth(),
        body: JSON.stringify({ name: "No Way In", role: "technician" }),
      });
      expect(res.status).toBe(400);
    });

    it("refuses to let an owner deactivate themselves", async () => {
      const headers = await ownerAuth();
      const { people } = (await (await fetch(`${BASE}/api/people`, { headers })).json()) as {
        people: { id: string; email: string | null }[];
      };
      const me = people.find((p) => p.email === "manish@shakticooling.test")!;

      const res = await fetch(`${BASE}/api/people/${me.id}/active`, {
        method: "POST",
        headers,
        body: JSON.stringify({ active: false }),
      });
      expect(res.status).toBe(409);
    });

    it("refuses to demote the last owner", async () => {
      const headers = await ownerAuth();
      const { people } = (await (await fetch(`${BASE}/api/people`, { headers })).json()) as {
        people: { id: string; role: string; active: boolean; email: string | null }[];
      };
      const owners = people.filter((p) => p.role === "owner" && p.active);
      // Only meaningful while the seeded tenant has exactly one.
      if (owners.length !== 1) return;

      const res = await fetch(`${BASE}/api/people/${owners[0]!.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ role: "coordinator" }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("the invoice series", () => {
    const post = (path: string, body: unknown) =>
      fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

    async function draft() {
      const { customers } = (await (
        await fetch(`${BASE}/api/customers`, { headers: auth })
      ).json()) as { customers: { id: string; sites: { id: string }[] }[] };
      const c = customers.find((x) => x.sites.length > 0)!;
      return (await (
        await post("/api/invoices", {
          customerId: c.id,
          siteId: c.sites[0]!.id,
          lines: [
            { description: "series probe", code: "9987", kind: "service", qty: 1, ratePaise: 100_00, ratePercent: 18 },
          ],
        })
      ).json()) as { id: string; number: string | null };
    }

    it("gives a draft no number, and numbers follow the order of issue", async () => {
      /*
        Rule 46(b) wants one consecutive series per financial year. Numbering
        at draft meant an abandoned draft left a permanent hole, and two drafts
        raised in one order and issued in another gave a series whose dates ran
        backwards against its numbers.
      */
      const a = await draft();
      const b = await draft();
      expect(a.number).toBeNull();
      expect(b.number).toBeNull();

      const issuedB = (await (await post(`/api/invoices/${b.id}/issue`, {})).json()) as { number: string };
      const issuedA = (await (await post(`/api/invoices/${a.id}/issue`, {})).json()) as { number: string };

      const seq = (n: string) => Number(/(\d+)\s*$/.exec(n)![1]);
      expect(seq(issuedA.number), "the later issue took the lower number").toBeGreaterThan(seq(issuedB.number));
    });

    it("costs nothing to abandon a draft", async () => {
      const d = await draft();
      const res = await post(`/api/invoices/${d.id}/cancel`, { reason: "raised by mistake" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { discarded: boolean }).discarded).toBe(true);
    });

    it("keeps a cancelled invoice's number spent", async () => {
      /*
        Reusing it would put two documents in the series under one number,
        which is the single thing the series exists to prevent — and
        unarguable once the first is in a filed GSTR-1.
      */
      const d = await draft();
      const issued = (await (await post(`/api/invoices/${d.id}/issue`, {})).json()) as { number: string };

      const cancelled = (await (
        await post(`/api/invoices/${d.id}/cancel`, { reason: "customer withdrew" })
      ).json()) as { number: string; status: string };

      expect(cancelled.number).toBe(issued.number);
      expect(cancelled.status).toBe("CANCELLED");
      expect((await post(`/api/invoices/${d.id}/issue`, {})).status).toBe(409);
    });

    it("refuses to cancel an invoice with payments against it", async () => {
      const d = await draft();
      const issued = (await (await post(`/api/invoices/${d.id}/issue`, {})).json()) as { id: string };
      await post("/api/payments", {
        invoiceId: issued.id,
        amountPaise: 100,
        receivedOn: new Date().toISOString().slice(0, 10),
        method: "UPI",
      });

      // Cancelling would leave money against a document that no longer exists.
      expect((await post(`/api/invoices/${d.id}/cancel`, { reason: "changed mind" })).status).toBe(409);
    });
  });

  describe("access, granted and withdrawn", () => {
    const J = { "content-type": "application/json" };
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${BASE}${path}`, { method: "POST", headers: { ...J, ...headers }, body: JSON.stringify(body) });

    it("lets an owner-created office user sign in, and makes them replace the password", async () => {
      /*
        This route used to store no password and a comment claimed the person
        would set one "via the reset flow" — a flow that did not exist. Every
        office user added through the product was created unable to sign in,
        and nothing said so.
      */
      const stamp = `${process.pid}${Math.floor(performance.now())}`;
      const email = `probe${stamp}@shakticooling.test`;
      const given = "handed-over-2026";

      const probe = (await (
        await post("/api/people", { name: `Probe ${stamp}`, role: "accountant", email, initialPassword: given }, auth)
      ).json()) as { id: string };

      const first = (await (await post("/auth/password", { email, password: given })).json()) as {
        accessToken: string;
      };
      expect(first.accessToken, "a new office user cannot sign in").toBeTruthy();

      const asThem = { Authorization: `Bearer ${first.accessToken}` };

      // Enforced by the API, not by a screen that a client could walk past.
      expect((await fetch(`${BASE}/api/customers`, { headers: asThem })).status).toBe(403);

      /*
        **Put the probe back.**

        This test creates a real office user in the development tenant and left
        it there, so every run added one more — forty-eight of them, three
        quarters of an active Team screen, all named `Probe <pid><ms>`.

        Deactivated rather than deleted, because `audit_entries.actor_user_id`
        references this row and that table refuses DELETE by trigger. That is
        the correct guarantee — who did what does not become erasable because
        the doer was a test — so the cleanup an insert-only trail permits is to
        revoke access, which is also exactly what the product does to a leaver.
      */
      await post(`/api/people/${probe.id}/active`, { active: false }, auth);

      expect((await post("/api/me/password", { currentPassword: given, newPassword: "short" }, asThem)).status).toBe(400);
      expect((await post("/api/me/password", { currentPassword: "not-the-one", newPassword: "a-long-enough-one" }, asThem)).status).toBe(401);

      const changed = (await (
        await post("/api/me/password", { currentPassword: given, newPassword: "chosen-by-me-2026" }, asThem)
      ).json()) as { accessToken: string };

      // Fresh tokens, or they stay locked out having just complied.
      expect((await fetch(`${BASE}/api/customers`, { headers: { Authorization: `Bearer ${changed.accessToken}` } })).status).toBe(200);
      expect((await post("/auth/password", { email, password: given })).status).toBe(401);
    });

    it("revokes the refresh token on sign-out", async () => {
      const session = (await (
        await post("/auth/password", { email: "suresh@shakticooling.test", password: "obizee-dev-2026" })
      ).json()) as { refreshToken: string };

      expect((await post("/auth/sign-out", { refreshToken: session.refreshToken })).status).toBe(200);
      // Signing out used to leave the token valid for thirty days.
      expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
    });

    it("revokes everything when somebody is deactivated", async () => {
      /*
        Deactivation used to flip a boolean only the sign-in path read, so
        anybody already signed in kept working and could refresh forever. The
        button removed access from nobody who was using the product.
      */
      const stamp = `${process.pid}${Math.floor(performance.now())}`;
      const email = `leaver${stamp}@shakticooling.test`;
      const given = "temporary-pass-2026";

      const person = (await (
        await post("/api/people", { name: `Leaver ${stamp}`, role: "accountant", email, initialPassword: given }, auth)
      ).json()) as { id: string };

      const session = (await (await post("/auth/password", { email, password: given })).json()) as {
        refreshToken: string;
      };

      await post(`/api/people/${person.id}/active`, { active: false }, auth);

      expect((await post("/auth/refresh", { refreshToken: session.refreshToken })).status).toBe(401);
      expect((await post("/auth/password", { email, password: given })).status).toBe(401);
    });
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
