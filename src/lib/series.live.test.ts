/**
 * The invoice series holds under concurrency — GST §31.
 *
 * §31 requires a consecutive serial number per series: no repeats, and no
 * gaps. A repeat is two documents claiming to be the same invoice. A gap is a
 * question at assessment that somebody has to answer years later, usually
 * without the person who caused it.
 *
 * This is why the number is issued by `next_in_series()` inside the database
 * and not by the browser. `store.ts` still holds a counter of its own, and
 * that counter is the reason the web app's writes go server-first: two
 * coordinators billing at once on two laptops is not an edge case in a firm
 * with a front desk and an owner, it is Tuesday.
 *
 * Run against the real database. Skipped when `DATABASE_URL` is absent so the
 * suite still runs offline — an untested guarantee should be visibly skipped,
 * not silently passed.
 */
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.ts";
import { branches, tenants } from "../db/schema.ts";

const live = Boolean(process.env.DATABASE_URL);

/** A financial year no real document occupies, so the test burns no numbers. */
const TEST_FY = 1900;

describe.skipIf(!live)("next_in_series under concurrency", () => {
  let tenantId: string;
  let branchId: string;

  beforeAll(async () => {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1);
    const [branch] = await db.select({ id: branches.id }).from(branches).limit(1);
    tenantId = tenant!.id;
    branchId = branch!.id;
  });

  it("issues twenty numbers with no repeats and no gaps", async () => {
    /*
      A real doc type in a financial year no document uses. `doc_type` is an
      enum so a test-only value is not available, and the counter is keyed on
      (tenant, branch, doc_type, year) — so FY 1900 is an isolated series that
      burns none of the tenant's real invoice numbers.
    */
    const issued = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.execute(
          sql`select next_in_series(${tenantId}::uuid, ${branchId}::uuid, 'invoice', ${TEST_FY}) as n`,
        ),
      ),
    );

    const numbers = issued
      .map((r) => Number((r.rows?.[0] ?? (r as unknown as { n: number }[])[0])?.n))
      .sort((a, b) => a - b);

    expect(numbers).toHaveLength(20);
    // No repeats: twenty calls, twenty distinct numbers.
    expect(new Set(numbers).size).toBe(20);
    // No gaps: the range they span is exactly the count they occupy.
    expect(numbers[19]! - numbers[0]!).toBe(19);
  });

  it("keeps a job series and an invoice series independent", async () => {
    const read = (r: unknown) =>
      Number(((r as { rows?: { n: number }[] }).rows?.[0] ?? (r as { n: number }[])[0])?.n);

    const jobFirst = read(
      await db.execute(
        sql`select next_in_series(${tenantId}::uuid, ${branchId}::uuid, 'job', ${TEST_FY}) as n`,
      ),
    );
    const invoiceNext = read(
      await db.execute(
        sql`select next_in_series(${tenantId}::uuid, ${branchId}::uuid, 'invoice', ${TEST_FY}) as n`,
      ),
    );
    const jobSecond = read(
      await db.execute(
        sql`select next_in_series(${tenantId}::uuid, ${branchId}::uuid, 'job', ${TEST_FY}) as n`,
      ),
    );

    // A job number and an invoice number share a financial year without
    // colliding, and neither advances the other.
    expect(jobSecond).toBe(jobFirst + 1);
    expect(invoiceNext).toBeGreaterThan(0);
  });
});
