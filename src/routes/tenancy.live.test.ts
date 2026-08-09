/**
 * One firm cannot see or touch another's records.
 *
 * **Why this is a test and not a database policy.** Row-level security is the
 * structural answer: the database refuses, and no handler can forget. It needs
 * a session variable set per request, and this API talks to Neon over HTTP —
 * a stateless driver where `SET LOCAL` cannot survive to the next statement,
 * because there is no next statement in the same session. Adopting RLS means
 * changing the driver, which undoes the reason the HTTP one was chosen.
 *
 * So today the boundary is every handler remembering to filter by
 * `caller.tenantId`. The authorization matrix showed they all do. This is what
 * makes that answer keep being true: a real second tenant, and an assertion
 * that its owner cannot reach the first one's data through any endpoint.
 *
 * It is detection, not prevention, and the difference is worth stating.
 */
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword } from "../auth/password.ts";
import { adminDb as db } from "../db/client.ts";
import { branches, customers, sites, tenants, users } from "../db/schema.ts";

const BASE = process.env.API_URL ?? "http://localhost:8787";
const OTHER_FIRM = "Verma Cooling Works Pvt Ltd";

const reachable = await fetch(`${BASE}/health`)
  .then((r) => r.ok)
  .catch(() => false);

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!reachable)("one firm cannot reach another's records", () => {
  let mine: Record<string, string>;
  let theirs: Record<string, string>;
  /** A row that belongs to the seeded firm and to nobody else. */
  let theirCustomerId: string;

  beforeAll(async () => {
    /*
      A second firm, created once and reused. Two tenants in one database is
      the only way to test the boundary — with one, every query looks correctly
      scoped whether or not it filters.
    */
    let [other] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.legalName, OTHER_FIRM))
      .limit(1);

    if (!other) {
      const [created] = await db
        .insert(tenants)
        .values({
          businessName: "Verma Cooling",
          legalName: OTHER_FIRM,
          aatoPaise: 1_00_00_000_00,
          taxScheme: "REGULAR",
          regionalLanguage: "hi",
          toggles: {},
        })
        .returning({ id: tenants.id });
      other = created!;

      const [branch] = await db
        .insert(branches)
        .values({
          tenantId: other.id,
          name: "Andheri",
          gstin: "27AAECV1234K1Z8",
          stateCode: "27",
          jobSeriesPrefix: "J",
          invoiceSeriesPrefix: "VCW",
        })
        .returning({ id: branches.id });

      await db.insert(users).values({
        tenantId: other.id,
        branchId: branch!.id,
        name: "Sunita Verma",
        email: "sunita@vermacooling.test",
        passwordHash: await hashPassword("other-firm-2026"),
        role: "owner",
      });

      const [theirCustomer] = await db
        .insert(customers)
        .values({
          tenantId: other.id,
          name: "Andheri Cold Chain",
          customerType: "BUSINESS",
          billingStateCode: "27",
          creditDays: 30,
        })
        .returning({ id: customers.id });

      await db.insert(sites).values({
        tenantId: other.id,
        customerId: theirCustomer!.id,
        label: "Depot",
        addressLine1: "Unit 4, MIDC",
        locality: "Andheri East",
        city: "Mumbai",
        stateCode: "27",
        pincode: "400093",
      });
    }

    const asOwner = async (email: string, password: string) => {
      const res = await post("/auth/password", { email, password });
      const { accessToken } = (await res.json()) as { accessToken: string };
      return { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
    };

    mine = await asOwner("sunita@vermacooling.test", "other-firm-2026");
    theirs = await asOwner("manish@shakticooling.test", "obizee-dev-2026");

    const [seeded] = await db
      .select({ id: customers.id })
      .from(customers)
      .innerJoin(tenants, eq(customers.tenantId, tenants.id))
      .where(eq(tenants.legalName, "Shakti Cooling Systems Pvt Ltd"))
      .limit(1);
    theirCustomerId = seeded!.id;
  });

  it("lists only its own customers", async () => {
    const ours = (await (await fetch(`${BASE}/api/customers`, { headers: mine })).json()) as {
      customers: { id: string; name: string }[];
    };
    const others = (await (await fetch(`${BASE}/api/customers`, { headers: theirs })).json()) as {
      customers: { id: string; name: string }[];
    };

    expect(ours.customers.length).toBeGreaterThan(0);
    expect(others.customers.length).toBeGreaterThan(0);

    const ourIds = new Set(ours.customers.map((c) => c.id));
    const overlap = others.customers.filter((c) => ourIds.has(c.id));
    expect(overlap, "the two firms share a customer row").toEqual([]);
  });

  it("cannot read another firm's customer by id", async () => {
    // Guessing an id must not be a way in. 404, not 200 and not 403 — the
    // honest answer is that this firm has no such customer.
    const res = await fetch(`${BASE}/api/customers/${theirCustomerId}`, { headers: mine });
    expect(res.status).toBe(404);
  });

  it("cannot bill another firm's customer", async () => {
    /*
      The sharpest case: an invoice raised against somebody else's customer
      would put their name on our GSTR-1 and our number on their ledger.
    */
    const res = await post(
      "/api/invoices",
      {
        customerId: theirCustomerId,
        lines: [
          { description: "probe", code: "9987", kind: "service", qty: 1, ratePaise: 100_00, ratePercent: 18 },
        ],
      },
      mine,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("shows no trace of the other firm across every list", async () => {
    const lists = [
      "/api/customers",
      "/api/leads",
      "/api/jobs",
      "/api/invoices",
      "/api/contracts",
      "/api/vendors",
      "/api/advances",
      "/api/people",
      "/api/parts",
    ];

    for (const path of lists) {
      const res = await fetch(`${BASE}${path}`, { headers: mine });
      expect(res.status, path).toBe(200);

      /*
        The seeded firm's names are distinctive, so their appearance anywhere
        in this firm's payload is a leak regardless of which field carried it.
      */
      const body = JSON.stringify(await res.json());
      for (const theirName of ["Shakti Industries", "Deshmukh Hospital", "Manish Agarwal", "Ramesh Yadav"]) {
        expect(body.includes(theirName), `${path} leaked "${theirName}"`).toBe(false);
      }
    }
  });

  it("counts its own numbering series, not the neighbour's", async () => {
    const ours = (await (
      await fetch(`${BASE}/api/settings/numbering`, { headers: mine })
    ).json()) as { branches: { name: string }[] };

    expect(ours.branches.map((b) => b.name)).toEqual(["Andheri"]);
  });
});
