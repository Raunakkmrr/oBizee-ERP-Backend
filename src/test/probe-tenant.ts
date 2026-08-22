/**
 * A tenant the live tests own, so they stop writing into the demo firm.
 *
 * **What was happening.** The invoice and payment tests authenticate as the
 * seeded owner and raise real documents — series probes, cancellations, a
 * hundred-paise payment — into `Shakti Cooling Systems Pvt Ltd`, which is the
 * tenant the product demos from. Invoices cannot be deleted (a spent number
 * stays spent, by design), so every run left permanent rubbish: dozens of ₹118
 * invoices and ₹1 payments against a real customer. They surfaced on the
 * Customers screen as money owed and on Money as fifty-four "part paid" rows,
 * in front of whoever the product was being shown to.
 *
 * **The fix is ownership, not cleanup.** `nfr-gates.ts` already made this
 * argument for the load probe and it holds here: a harness that can reach the
 * demo tenant will eventually write to it, and no amount of tidying afterwards
 * changes that. So the money-writing tests get a tenant of their own, with its
 * own branch, owner, customer and site, and never see the demo firm again.
 *
 * **It persists between runs rather than being torn down.** Invoices, payments
 * and audit entries are insert-only or number-bearing; deleting them is exactly
 * the operation the register refuses everywhere else, and building a demolition
 * path for a test harness would be the most dangerous code in the repository.
 * One extra tenant in a development database is the cheaper price.
 */
import { eq } from "drizzle-orm";

import { hashPassword } from "../auth/password.ts";
import { adminDb as db } from "../db/client.ts";
import { branches, customers, sites, tenants, users } from "../db/schema.ts";

export const PROBE_TENANT = "Live Test Harness — not a customer";
export const PROBE_EMAIL = "harness@probe.test";
export const PROBE_PASSWORD = "probe-harness-2026";

/**
 * Provision if absent, return the credentials either way.
 *
 * Idempotent, because every live test file calls it and they share a database.
 */
export async function ensureProbeTenant(): Promise<{
  tenantId: string;
  email: string;
  password: string;
}> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.legalName, PROBE_TENANT))
    .limit(1);

  if (existing) {
    /*
      Converge, do not just return.

      An early return was correct on the day it was written and wrong the moment
      the fixture needed a second customer: the tenant already existed, so the
      new row was never added, and the advance-adjustment guard — which needs
      two customers to have anything to compare — silently returned and passed
      having tested nothing. A green tick over an untested guard is worse than a
      red one.
    */
    await ensureCustomers(existing.id);
    return { tenantId: existing.id, email: PROBE_EMAIL, password: PROBE_PASSWORD };
  }

  const [tenant] = await db
    .insert(tenants)
    .values({
      businessName: "Live Test Harness",
      legalName: PROBE_TENANT,
      // Below ₹5 crore, matching the demo firm, so HSN stays at 4 digits and
      // the tests exercise the same branch of `codeForAato`.
      aatoPaise: 4_20_00_000_00,
      taxScheme: "REGULAR",
      regionalLanguage: "hi",
      toggles: { technicianSeesPrices: false, coordinatorCanBill: true },
    })
    .returning();
  const tenantId = tenant!.id;

  const [branch] = await db
    .insert(branches)
    .values({
      tenantId,
      name: "Harness branch",
      // A distinct GSTIN and series prefix, so a probe document can never be
      // mistaken for one of the firm's in a screenshot or an export.
      gstin: "07AABCH9999H1ZH",
      stateCode: "07",
      jobSeriesPrefix: "PJ",
      invoiceSeriesPrefix: "PRB",
    })
    .returning();

  await db.insert(users).values({
    tenantId,
    branchId: branch!.id,
    name: "Harness Owner",
    email: PROBE_EMAIL,
    passwordHash: await hashPassword(PROBE_PASSWORD),
    role: "owner",
  });

  await ensureCustomers(tenantId);

  return { tenantId, email: PROBE_EMAIL, password: PROBE_PASSWORD };
}

/**
 * The customers and sites the fixture needs, topped up if some are missing.
 *
 * Named for what it guarantees rather than what it inserts, because the caller
 * cares that they exist and not whether this run is the one that made them.
 */
async function ensureCustomers(tenantId: string): Promise<void> {
  const present = await db
    .select({ name: customers.name })
    .from(customers)
    .where(eq(customers.tenantId, tenantId));
  const have = new Set(present.map((c) => c.name));

  /*
    Two customers, not one.

    The advance-adjustment guard asserts that customer A's advance cannot close
    against customer B's invoice — the defect where a credit lands on the wrong
    ledger and GSTR-1 reports it against the wrong GSTIN. With a single customer
    that test finds nothing to compare and silently returns, which is a passing
    test that checks nothing.
  */
  const wanted = ["Probe Customer A", "Probe Customer B"].filter((n) => !have.has(n));
  if (wanted.length === 0) return;

  const created = await db
    .insert(customers)
    .values(
      wanted.map((name) => ({
        tenantId,
        name,
        customerType: "BUSINESS" as const,
        gstin: null,
        billingStateCode: "07",
        creditDays: 30,
      })),
    )
    .returning({ id: customers.id, name: customers.name });

  // Sites in the branch's own state, so place-of-supply resolves to CGST+SGST
  // without the tests having to care.
  await db.insert(sites).values(
    created.map((customer, n) => ({
      tenantId,
      customerId: customer.id,
      label: `Probe site ${n + 1}`,
      addressLine1: `${n + 1}, Harness Lane`,
      locality: "Nowhere",
      city: "New Delhi",
      stateCode: "07",
      pincode: "110001",
      landmark: null,
      accessNotes: null,
    })),
  );
}
