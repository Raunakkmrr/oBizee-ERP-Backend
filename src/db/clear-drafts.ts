/**
 * Throw away draft invoices, so a test run does not leave a trail on the money
 * screen.
 *
 * `billing.spec.ts` presses "Bill this", which is the point of it — and the
 * draft stays behind. Forty-nine had piled up before anybody looked, each one a
 * row a coordinator would have to read past on a screen that exists to show
 * what needs acting on.
 *
 * Safe to run because a draft holds no number and settles nothing: numbering
 * happens at issue, so an abandoned draft costs the series nothing. That is the
 * same property that makes abandoning one free for a real user, and it is why
 * this can be a `rm` rather than a cancellation.
 *
 * Refuses in production regardless. Somebody's half-finished invoice is not
 * rubbish just because it is unfinished.
 */
import { eq, isNotNull, notInArray, sql } from "drizzle-orm";

import { adminDb as db } from "./client.ts";
import { advances, invoiceLines, invoices } from "./schema.ts";

if (process.env.NODE_ENV === "production") {
  throw new Error("clear-drafts is a development fixture and will not run in production");
}

/*
  A draft an advance has been settled against is not disposable.

  Drafting the invoice and applying the advance before issuing it is a real
  sequence — the customer paid up front and the document is being prepared.
  Deleting the draft would leave the advance pointing at nothing, which is
  money the ledger says was applied and now cannot say where.
*/
const settled = (
  await db
    .select({ id: advances.adjustedByInvoiceId })
    .from(advances)
    .where(isNotNull(advances.adjustedByInvoiceId))
).map((a) => a.id!);

const drafts = await db
  .select({ id: invoices.id })
  .from(invoices)
  .where(
    settled.length
      ? sql`${invoices.status} = 'DRAFT' and ${notInArray(invoices.id, settled)}`
      : eq(invoices.status, "DRAFT"),
  );

for (const draft of drafts) {
  await db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, draft.id));
  await db.delete(invoices).where(eq(invoices.id, draft.id));
}

console.log(
  `cleared ${drafts.length} draft invoices` +
    (settled.length ? `, kept ${settled.length} an advance is settled against` : ""),
);
process.exit(0);
