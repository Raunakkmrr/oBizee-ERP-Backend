/**
 * Take the test rubbish back out of the development tenant.
 *
 *   node --experimental-strip-types --env-file=.env scripts/clean-dev-fixtures.ts        # plan only
 *   node --experimental-strip-types --env-file=.env scripts/clean-dev-fixtures.ts --yes  # do it
 *
 * **What accumulated, and how.** A throwaway load probe wrote into the demo
 * tenant instead of one of its own: three customers, a dozen leads and
 * sixty-one numbered invoices. Separately, every run of the E2E suite presses
 * "Bill this" and leaves the draft behind, so the money screen grows a new row
 * each time anybody runs the tests.
 *
 * `nfr-gates.ts` fixed the first cause — it owns a tenant and cannot reach this
 * one. The E2E setup now clears its own drafts. This clears what was left
 * before either of those existed.
 *
 * **Why deleting numbered invoices is legitimate here and nowhere else.** Under
 * Rule 46(b) an issued number is spent, and cancellation keeps it spent — that
 * is the whole design, and `POST /invoices/:id/cancel` enforces it. These are
 * not documents; they are load-test artefacts in a fixture database that has
 * never been filed from. So this deletes them and winds the counter back to the
 * highest number a real fixture invoice holds, leaving a consecutive series
 * rather than four hundred phantom gaps for the numbering screen to report.
 *
 * Against a tenant with real customers this operation would be indefensible,
 * which is why the guard below is on the tenant's name and not on a flag.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { adminDb as db } from "../src/db/client.ts";
import {
  advances,
  assets,
  contacts,
  contracts,
  customers,
  invoiceLines,
  invoices,
  jobs,
  leadActivities,
  leads,
  payments,
  jobEvents,
  jobHelpers,
  jobParts,
  seriesCounters,
  signOffs,
  sites,
  stockMovements,
  tenants,
} from "../src/db/schema.ts";

/** The seeded development firm, and the only tenant this will touch. */
const DEV_TENANT = "Shakti Cooling Systems Pvt Ltd";

/** Names no real customer or lead would carry. Matched case-insensitively. */
const RUBBISH = "probe|seam|cutover|harness|^test ";

const commit = process.argv.includes("--yes");
/*
  Drafts are behind their own flag because they are the one ambiguous category.
  A draft named after a probe customer is obviously rubbish; a draft on a real
  fixture customer might be one somebody made by hand thirty seconds ago while
  looking at the screen, and nothing in the row distinguishes the two.
*/
const includeDrafts = process.argv.includes("--drafts");

if (process.env.NODE_ENV === "production") {
  throw new Error("This deletes fixture data. It does not run in production.");
}

const [tenant] = await db
  .select({ id: tenants.id })
  .from(tenants)
  .where(eq(tenants.legalName, DEV_TENANT))
  .limit(1);
if (!tenant) throw new Error(`No tenant named ${DEV_TENANT} — nothing to clean`);
const tenantId = tenant.id;

/* ------------------------------------------------------------- the plan */

const junkCustomers = await db
  .select({ id: customers.id, name: customers.name })
  .from(customers)
  .where(and(eq(customers.tenantId, tenantId), sql`${customers.name} ~* ${RUBBISH}`));

const junkLeads = await db
  .select({ id: leads.id, name: leads.name })
  .from(leads)
  .where(and(eq(leads.tenantId, tenantId), sql`${leads.name} ~* ${RUBBISH}`));

/*
  Two reasons a customer stays, whatever it is called, and both are found before
  anything is deleted.

  **A contract.** `Probe Foods 97576` held one of the two seeded AMCs — real
  fixture data wearing a name from a throwaway script. Renaming is the answer
  there, not deletion.

  **A job that moved stock.** `stock_movements` is insert-only under the same
  rule as the audit trail, so a job it references can never be deleted and
  neither can the customer above it. Not a limitation to work around: on-hand
  is summed from that ledger, and a ledger with a delete path is a balance
  anybody can rewrite without trace.

  Found up front because the first version of this script did not. It deleted
  sixty-one invoices, hit a foreign key on contracts, and stopped — leaving the
  tenant in a state neither the plan nor the operator had described. A
  destructive script that can halt mid-way has to know its blockers first.
*/
const contracted = new Set(
  (
    await db
      .select({ customerId: contracts.customerId })
      .from(contracts)
      .where(eq(contracts.tenantId, tenantId))
  ).map((c) => c.customerId),
);

const immovable = new Set(
  (
    await db
      .select({ customerId: jobs.customerId })
      .from(jobs)
      .innerJoin(stockMovements, eq(stockMovements.jobId, jobs.id))
      .where(eq(jobs.tenantId, tenantId))
  ).map((r) => r.customerId),
);

const blocked = junkCustomers.filter((c) => contracted.has(c.id) || immovable.has(c.id));
const customerIds = junkCustomers
  .filter((c) => !contracted.has(c.id) && !immovable.has(c.id))
  .map((c) => c.id);

const doomedInvoices = customerIds.length
  ? await db
      .select({ id: invoices.id, number: invoices.number, status: invoices.status })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), inArray(invoices.customerId, customerIds)))
  : [];

/*
  Every draft, whoever it belongs to. A draft holds no number and settles
  nothing, so it costs the series nothing — but fifty of them on the money
  screen is fifty rows of noise from a test suite, and the screen is meant to
  show what somebody has to act on.
*/
const drafts = includeDrafts
  ? await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "DRAFT")))
  : [];

const [draftCount] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(invoices)
  .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "DRAFT")));

const invoiceIds = [...new Set([...doomedInvoices.map((i) => i.id), ...drafts.map((d) => d.id)])];

/** The highest number that survives — where the series should resume. */
const [survivor] = await db
  .select({ highest: sql<string | null>`max(${invoices.number})` })
  .from(invoices)
  .where(
    and(
      eq(invoices.tenantId, tenantId),
      sql`${invoices.number} is not null`,
      invoiceIds.length ? notInArray(invoices.id, invoiceIds) : sql`true`,
    ),
  );
const resumeAt = Number(survivor?.highest?.split("/").pop() ?? 0);

console.log(`tenant ${DEV_TENANT} (${tenantId})\n`);
console.log(
  `  customers to remove : ${customerIds.length}  ` +
    junkCustomers.filter((c) => !contracted.has(c.id)).map((c) => c.name).join(", "),
);
for (const c of blocked) {
  const why = contracted.has(c.id) ? "carries a contract" : "has a job that moved stock";
  console.log(`  kept                : "${c.name}" ${why} — rename it rather than delete it`);
}
console.log(`  leads to remove     : ${junkLeads.length}`);
console.log(
  `  invoices to remove  : ${invoiceIds.length}` +
    ` (${doomedInvoices.filter((i) => i.number).length} numbered, ${drafts.length} drafts)`,
);
console.log(`  invoice series      : resumes at ${String(resumeAt + 1).padStart(4, "0")}, after ${survivor?.highest ?? "nothing"}`);
if (!includeDrafts && (draftCount?.n ?? 0) > 0) {
  console.log(
    `\n  ${draftCount!.n} drafts left alone. Most are the E2E suite pressing "Bill this";` +
      ` some may be yours. Add --drafts to clear them too.`,
  );
}

/*
  Reported, never deleted. `Shakti Cooling Pvt Ltd` is a near-duplicate of the
  seeded firm from an earlier build, holding counters under financial year 1900,
  and an empty tenant is not obviously safe to remove — it may carry the audit
  trail of whatever created it, which nothing may delete.
*/
const strays = await db
  .select({ id: tenants.id, name: tenants.legalName })
  .from(tenants)
  .where(sql`${tenants.legalName} <> ${DEV_TENANT}`);
for (const stray of strays) {
  const [n] = await db
    .select({ customers: sql<number>`count(*)::int` })
    .from(customers)
    .where(eq(customers.tenantId, stray.id));
  if ((n?.customers ?? 0) === 0) {
    console.log(`\n  note: tenant "${stray.name}" has no customers. Left alone — see the comment in this file.`);
  }
}

if (!commit) {
  console.log("\nPlan only. Re-run with --yes to carry it out.");
  process.exit(0);
}

/* ------------------------------------------------------------- carry out */

if (invoiceIds.length) {
  await db.delete(payments).where(inArray(payments.invoiceId, invoiceIds));
  await db.delete(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds));
  await db.delete(invoices).where(inArray(invoices.id, invoiceIds));
}

if (junkLeads.length) {
  const leadIds = junkLeads.map((l) => l.id);
  await db.delete(leadActivities).where(inArray(leadActivities.leadId, leadIds));
  // Jobs raised from a lead hold it by foreign key, so they let go first.
  await db.update(jobs).set({ fromLeadId: null }).where(inArray(jobs.fromLeadId, leadIds));
  await db.delete(leads).where(inArray(leads.id, leadIds));
}

if (customerIds.length) {
  /*
    Children before parents, in the order `pg_constraint` says they depend.
    Enumerated rather than guessed — the first two attempts each discovered one
    more foreign key by hitting it.
  */
  const jobRows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(inArray(jobs.customerId, customerIds));
  const jobIds = jobRows.map((j) => j.id);

  if (jobIds.length) {
    await db.delete(signOffs).where(inArray(signOffs.jobId, jobIds));
    await db.delete(jobEvents).where(inArray(jobEvents.jobId, jobIds));
    await db.delete(jobParts).where(inArray(jobParts.jobId, jobIds));
    await db.delete(jobHelpers).where(inArray(jobHelpers.jobId, jobIds));
  }

  await db.delete(advances).where(inArray(advances.customerId, customerIds));
  await db.delete(jobs).where(inArray(jobs.customerId, customerIds));

  const siteIds = (
    await db.select({ id: sites.id }).from(sites).where(inArray(sites.customerId, customerIds))
  ).map((s) => s.id);
  if (siteIds.length) {
    await db.delete(contacts).where(inArray(contacts.siteId, siteIds));
    await db.delete(assets).where(inArray(assets.siteId, siteIds));
    await db.delete(sites).where(inArray(sites.id, siteIds));
  }

  // A converted lead points at the customer it became.
  await db
    .update(leads)
    .set({ convertedCustomerId: null })
    .where(inArray(leads.convertedCustomerId, customerIds));

  await db.delete(customers).where(inArray(customers.id, customerIds));
}

/*
  Wound back so the next invoice continues the series rather than starting four
  hundred numbers along. Legitimate only because nothing above it survives —
  see the note at the top of this file.
*/
await db
  .update(seriesCounters)
  .set({ lastIssued: resumeAt })
  .where(and(eq(seriesCounters.tenantId, tenantId), eq(seriesCounters.docType, "invoice")));

console.log("\nDone. The audit trail is untouched, as it must be.");
process.exit(0);
