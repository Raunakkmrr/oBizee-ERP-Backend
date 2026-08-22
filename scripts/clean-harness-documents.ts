/**
 * Take the live suite's documents back out of the demo tenant.
 *
 *   node --experimental-strip-types --env-file=.env scripts/clean-harness-documents.ts        # plan only
 *   node --experimental-strip-types --env-file=.env scripts/clean-harness-documents.ts --yes  # do it
 *
 * **What accumulated, and why this is a different job from `clean-dev-fixtures`.**
 * That script removes junk *customers* and everything hanging off them. This
 * rubbish is attached to **real** customers: the live tests authenticated as the
 * seeded owner and raised series probes, cancellation probes and a
 * hundred-paise payment against Deshmukh Hospital and Annapurna Restaurant. So
 * customer-shaped cleanup cannot see it.
 *
 * The cause is fixed — `src/test/probe-tenant.ts` gives those tests a tenant of
 * their own — and this clears what was left before it existed.
 *
 * **How a harness document is told from a real one.** By the words on its
 * lines. The probes write `series probe` and `guard`; the fixtures and the demo
 * write things like `AC AMC`, `Capacitor 45 MFD` and `Cockroach treatment —
 * J-2610-1044`. An invoice is removed only when **every** line on it is a probe
 * line, so a real invoice that happens to contain one is left alone.
 *
 * **Why deleting numbered invoices is legitimate here and nowhere else.** Under
 * Rule 46(b) an issued number is spent, and cancellation keeps it spent — that
 * is the design, and `POST /invoices/:id/cancel` enforces it. These are not
 * documents: they are test artefacts in a fixture database that has never been
 * filed from. Against a tenant with real filings the operation would be
 * indefensible, which is why the guard below is on the tenant's name.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { adminDb as db } from "../src/db/client.ts";
import { advances, invoiceLines, invoices, payments, seriesCounters, tenants } from "../src/db/schema.ts";

const DEV_TENANT = "Shakti Cooling Systems Pvt Ltd";
/** The exact words the probes write. Not a pattern — a list, so it cannot widen. */
const PROBE_LINES = ["series probe", "guard"];
/** The guard test's fixed receipt. Real advances in this tenant are other amounts. */
const PROBE_ADVANCE_PAISE = 1_180_00;

const commit = process.argv.includes("--yes");

const [tenant] = await db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.legalName, DEV_TENANT))
  .limit(1);
if (!tenant) {
  console.error(`No tenant named "${DEV_TENANT}". Refusing to guess at another.`);
  process.exit(1);
}
const tenantId = tenant.id;

/*
  Every line of the invoice must be a probe line.

  Counting probe lines alone would condemn a real invoice that happened to carry
  one, which is the difference between a cleanup and a data loss.
*/
const grouped = await db
  .select({
    invoiceId: invoiceLines.invoiceId,
    total: sql<number>`count(*)::int`,
    probes: sql<number>`count(*) filter (where ${invoiceLines.description} in ('series probe', 'guard'))::int`,
  })
  .from(invoiceLines)
  .where(eq(invoiceLines.tenantId, tenantId))
  .groupBy(invoiceLines.invoiceId);

const doomed = grouped.filter((g) => g.total > 0 && g.total === g.probes).map((g) => g.invoiceId);

const strayAdvances = await db
  .select({ id: advances.id })
  .from(advances)
  .where(
    and(
      eq(advances.tenantId, tenantId),
      eq(advances.receiptPaise, PROBE_ADVANCE_PAISE),
      // Never an adjusted one: that advance closed against a real invoice, and
      // removing it would leave the invoice claiming a credit that is gone.
      eq(advances.status, "OPEN"),
    ),
  );

const doomedPayments = doomed.length
  ? await db.select({ id: payments.id }).from(payments).where(inArray(payments.invoiceId, doomed))
  : [];

/* The highest number NOT being removed, so the series resumes consecutively. */
const [survivor] = await db
  .select({ highest: sql<string>`max(${invoices.number})` })
  .from(invoices)
  .where(
    doomed.length
      ? and(eq(invoices.tenantId, tenantId), sql`${invoices.id} not in ${doomed}`)
      : eq(invoices.tenantId, tenantId),
  );
const resumeAt = Number(survivor?.highest?.split("/").pop() ?? 0);

console.log(`tenant ${DEV_TENANT}\n`);
console.log(`  invoices to remove  : ${doomed.length}  (every line a probe line)`);
console.log(`  payments to remove  : ${doomedPayments.length}`);
console.log(`  advances to remove  : ${strayAdvances.length}  (₹1,180 and still open)`);
console.log(`  invoice series      : resumes at ${String(resumeAt + 1).padStart(4, "0")}, after ${survivor?.highest ?? "—"}`);
console.log(`  probe line words    : ${PROBE_LINES.join(", ")}\n`);

if (!commit) {
  console.log("Plan only. Re-run with --yes to carry it out.");
  process.exit(0);
}

if (doomedPayments.length > 0) {
  await db.delete(payments).where(inArray(payments.id, doomedPayments.map((p) => p.id)));
}
if (strayAdvances.length > 0) {
  await db.delete(advances).where(inArray(advances.id, strayAdvances.map((a) => a.id)));
}
if (doomed.length > 0) {
  // An advance may point at one of these; null the link before the row goes,
  // or the foreign key refuses and rightly.
  await db
    .update(advances)
    .set({ adjustedByInvoiceId: null, status: "OPEN" })
    .where(and(eq(advances.tenantId, tenantId), inArray(advances.adjustedByInvoiceId, doomed)));
  // Lines cascade.
  await db.delete(invoices).where(inArray(invoices.id, doomed));
}

await db
  .update(seriesCounters)
  .set({ lastIssued: resumeAt })
  .where(and(eq(seriesCounters.tenantId, tenantId), eq(seriesCounters.docType, "invoice")));

console.log("\nDone. The audit trail is untouched, as it must be.");
process.exit(0);
