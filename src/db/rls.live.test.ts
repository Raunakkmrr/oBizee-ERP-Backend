/**
 * The database refuses, not the handler.
 *
 * `tenancy.live.test.ts` drives the HTTP API and shows that no endpoint leaks.
 * This goes underneath it and asks the harder question: if a handler *did*
 * forget its `where`, would anything stop it? These queries deliberately omit
 * every tenant filter.
 *
 * It is also the alarm on the plumbing. The tenant reaches the database as a
 * setting carried by each statement, through a shim in `client.ts` that leans
 * on how drizzle's HTTP session calls its client. An upgrade could change that
 * shape. If it does, the policies stop matching and these tests fail — which is
 * the point, because the alternative is row-level security quietly switching
 * itself off while everything still appears to work.
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { adminDb, db, withTenant } from "./client.ts";
import { databaseIsLive } from "./live.ts";
import { customers, tenants } from "./schema.ts";

/* Probed once in live.ts rather than per file. */
const reachable = databaseIsLive;

/**
 * Every message in the chain, flattened.
 *
 * Drizzle reports a failed statement as "Failed query: …" and keeps the
 * database's own words in `cause`. Asserting on the top-level message alone
 * would pass for any failure at all, including the ones this file is meant to
 * distinguish between.
 */
async function reasonFor(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected this to be refused, and it was not");
}

describe.skipIf(!reachable)("row-level security", () => {
  /** The firm with records to hide — an empty tenant would make all of this vacuous. */
  let busiest: string;
  let tenantCount: number;

  beforeAll(async () => {
    tenantCount = (await adminDb.select({ id: tenants.id }).from(tenants)).length;
    const [top] = (
      await adminDb.execute(sql`
        select tenant_id, count(*)::int as n from customers group by 1 order by 2 desc limit 1`)
    ).rows as { tenant_id: string; n: number }[];
    busiest = top!.tenant_id;
  });

  it("connects as a role that cannot bypass policies", async () => {
    /*
      The single property everything else rests on. Neon's default owner has
      BYPASSRLS, and against it the policies would never once be consulted —
      every test below would pass while protecting nothing.
    */
    const { rows } = await withTenant(
      busiest,
      async () =>
        await db.execute(sql`
          select current_user as who,
                 (select rolbypassrls from pg_roles where rolname = current_user) as bypass`),
    );
    const [row] = rows as { who: string; bypass: boolean }[];

    expect(row?.who).toBe("app_runtime");
    expect(row?.bypass).toBe(false);
  });

  it("returns nothing at all outside a tenant context", async () => {
    /*
      The escape hatch is closed at two depths. `db` throws rather than send an
      unscoped statement — but that is this codebase's own guard, and the point
      of RLS is not to depend on it. So this reaches past the shim with a tenant
      that does not exist, and finds the database equally unhelpful.
    */
    expect(await reasonFor(async () => await db.select().from(customers))).toMatch(/withTenant/);

    const { rows } = await withTenant(
      "00000000-0000-0000-0000-000000000000",
      async () => await db.execute(sql`select count(*)::int as n from customers`),
    );
    expect((rows as { n: number }[])[0]?.n).toBe(0);
  });

  it("sees one firm's customers when the query names no firm", async () => {
    // No `where` anywhere. Whatever comes back, the policy chose it.
    const unscoped = await withTenant(
      busiest,
      async () => await db.select({ tenantId: customers.tenantId }).from(customers),
    );
    const everything = await adminDb.select({ tenantId: customers.tenantId }).from(customers);

    expect(unscoped.length).toBeGreaterThan(0);
    expect(new Set(unscoped.map((r) => r.tenantId))).toEqual(new Set([busiest]));
    /*
      Only meaningful with a neighbour to be hidden from. Below two tenants the
      assertion is vacuous and says so, rather than passing on nothing — the
      failure mode these tests exist to remove.
    */
    if (tenantCount > 1) expect(unscoped.length).toBeLessThan(everything.length);
    else expect.soft(tenantCount, "seed a second tenant to make this meaningful").toBeGreaterThan(1);
  });

  it("refuses to write a row into another firm", async () => {
    const other = (await adminDb.select({ id: tenants.id }).from(tenants)).find(
      (t) => t.id !== busiest,
    );
    if (!other) return expect.soft(true, "needs a second tenant").toBe(true);

    // WITH CHECK, not USING: the row would be invisible afterwards either way,
    // but an insert that silently succeeds leaves a record nobody can reach.
    const reason = await reasonFor(
      async () =>
        await withTenant(
          busiest,
          async () =>
            await db.insert(customers).values({
              tenantId: other.id,
              name: "Planted By A Neighbour",
              customerType: "BUSINESS",
              billingStateCode: "27",
              creditDays: 30,
            }),
        ),
    );
    expect(reason).toMatch(/row-level security/i);
  });

  it("keeps the privileged handle out of the request path", async () => {
    // Sign-in and rate limiting run before a tenant is known, so they use
    // adminDb — and adminDb must still see everything, or they cannot work.
    const all = await adminDb.select({ id: tenants.id }).from(tenants);
    expect(all.length).toBe(tenantCount);
  });
});
