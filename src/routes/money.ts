/**
 * Money — collections and the §43B(h) payables clock. PRD §6.12.
 *
 * Two lists that look alike and are not. Receivables are a **chase list**: the
 * rows exist so somebody makes a phone call, which is why each carries a number
 * and the last thing that was said. Payables are a **deadline list**: the rows
 * exist because §43B(h) removes the deduction for the whole financial year if
 * an MSME supplier is paid late, and no payment afterwards brings it back.
 *
 * Both are served composed rather than as raw invoice and bill rows. The
 * outstanding figure is invoices minus payments, the overdue count is against
 * the customer's own credit days, and the MSMED clock depends on the vendor's
 * Udyam activity — deriving any of that in the browser means three chances for
 * the number on the screen to disagree with the number in the ledger.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import {
  collectionContacts,
  contacts,
  customers,
  invoices,
  payments,
  purchaseBills,
  sites,
  vendors,
} from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";
import { creditedAgainst } from "./credit-notes.ts";
import { outstandingOf, taxOnUncollected } from "../lib/receivables.ts";

export const moneyRoutes = apiRouter();

/** `12 Jun 2026` — the form an owner reads on a bank statement. */
function dateWord(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** `24 Jul` — inside a sentence the year is noise. */
function shortWord(at: Date | string): string {
  const d = typeof at === "string" ? new Date(`${at}T00:00:00`) : at;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function daysBetween(from: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000);
}

moneyRoutes.get("/overview", requirePermission("payment:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const now = new Date();

  const [issued, paidRows, billRows] = await Promise.all([
    db
      .select({
        id: invoices.id,
        number: invoices.number,
        issueDate: invoices.issueDate,
        grandTotalPaise: invoices.grandTotalPaise,
        // For the exposure figure: the tax was paid in full at issue.
        totalTaxPaise: invoices.totalTaxPaise,
        customerId: invoices.customerId,
        siteId: invoices.siteId,
        customer: customers.name,
        creditDays: customers.creditDays,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "ISSUED"))),
    db
      .select({ invoiceId: payments.invoiceId, paid: sql<string>`sum(${payments.amountPaise})` })
      .from(payments)
      .where(eq(payments.tenantId, tenantId))
      .groupBy(payments.invoiceId),
    db
      .select({
        id: purchaseBills.id,
        vendor: vendors.name,
        msmeClass: vendors.msmeClass,
        udyamNumber: vendors.udyamNumber,
        udyamActivity: vendors.udyamActivity,
        udyamVerifiedOn: vendors.udyamVerifiedOn,
        hasWrittenAgreement: vendors.hasWrittenAgreement,
        billDate: purchaseBills.billDate,
        payablePaise: purchaseBills.payablePaise,
      })
      .from(purchaseBills)
      .innerJoin(vendors, eq(purchaseBills.vendorId, vendors.id))
      .where(and(eq(purchaseBills.tenantId, tenantId), eq(purchaseBills.status, "UNPAID"))),
  ]);

  const paidBy = new Map(paidRows.map((r) => [r.invoiceId, Number(r.paid ?? 0)]));
  /*
    Credit notes come off the receivable too.

    Without this the collections list chases a customer for money a credit note
    has already given back — the most expensive kind of wrong number here,
    because somebody acts on it by picking up the phone.
  */
  const creditedBy = await creditedAgainst(tenantId, issued.map((i) => i.id));
  const unpaid = issued
    .map((inv) => ({
      ...inv,
      creditedPaise: creditedBy.get(inv.id) ?? 0,
      outstanding: outstandingOf({
        grandTotalPaise: inv.grandTotalPaise,
        paidPaise: paidBy.get(inv.id) ?? 0,
        creditedPaise: creditedBy.get(inv.id) ?? 0,
      }),
    }))
    .filter((inv) => inv.outstanding > 0);

  /*
    The chase notes, one query for the page. A row with no note is not a
    failure — it means nobody has called yet, which is itself the thing the
    coordinator needs to see.
  */
  const notes = unpaid.length
    ? await db
        .select()
        .from(collectionContacts)
        .where(
          and(
            eq(collectionContacts.tenantId, tenantId),
            inArray(
              collectionContacts.invoiceId,
              unpaid.map((i) => i.id),
            ),
          ),
        )
        .orderBy(desc(collectionContacts.occurredAt))
    : [];
  const lastNote = new Map<string, (typeof notes)[number]>();
  for (const n of notes) if (!lastNote.has(n.invoiceId)) lastNote.set(n.invoiceId, n);

  // A chase list whose rows carry no phone number cannot do the one thing it is for.
  const phoneRows = unpaid.length
    ? await db
        .select({
          siteId: contacts.siteId,
          customerId: sites.customerId,
          phone: contacts.phoneE164,
          isPrimary: contacts.isPrimary,
        })
        .from(contacts)
        .innerJoin(sites, eq(contacts.siteId, sites.id))
        .where(eq(contacts.tenantId, tenantId))
    : [];
  /*
    Prefer the contact at the site that was actually serviced. A customer with
    plants in Delhi and Nagpur has a primary contact at each, and ringing the
    wrong one about a Delhi invoice wastes the call. Falls back to any primary
    the customer has, because a number is better than a blank row.
  */
  const phoneBySite = new Map<string, string>();
  const phoneByCustomer = new Map<string, string>();
  for (const p of phoneRows) {
    if (!p.phone) continue;
    if (p.isPrimary || !phoneBySite.has(p.siteId)) phoneBySite.set(p.siteId, p.phone);
    if (p.isPrimary || !phoneByCustomer.has(p.customerId)) phoneByCustomer.set(p.customerId, p.phone);
  }

  const receivables = unpaid.map((inv) => {
    const note = lastNote.get(inv.id);
    // Overdue is measured from the customer's own credit days, not from issue.
    const daysOverdue = Math.max(0, daysBetween(inv.issueDate, now) - inv.creditDays);
    return {
      id: inv.id,
      customer: inv.customer,
      invoiceNumber: inv.number,
      invoiceDate: dateWord(inv.issueDate),
      daysOverdue,
      amountPaise: inv.outstanding,
      /*
        Billed and received, not just what is left.

        A ₹3,080 balance on a ₹7,080 invoice and a ₹3,080 invoice nobody has
        touched are the same number and completely different conversations: one
        customer has paid and is slow on the rest, the other has paid nothing.
        Recording a payment became possible before finding the part-paid ones
        did, so the list could not tell them apart.
      */
      billedPaise: inv.grandTotalPaise,
      paidPaise: paidBy.get(inv.id) ?? 0,
      /*
        The tax already handed over against this uncollected money.

        §13(2) made the whole liability fall due when the invoice was issued,
        whatever had been collected — so this is the share of it sitting against
        money that has not arrived.
      */
      taxOnUncollectedPaise: taxOnUncollected({
        grandTotalPaise: inv.grandTotalPaise,
        totalTaxPaise: inv.totalTaxPaise,
        outstandingPaise: inv.outstanding,
      }),
      lastContact: note ? `${shortWord(note.occurredAt)} — ${note.note}` : null,
      phone:
        (inv.siteId ? phoneBySite.get(inv.siteId) : undefined) ??
        phoneByCustomer.get(inv.customerId) ??
        null,
      promise: note?.promisedFor
        ? {
            dateWord: shortWord(note.promisedFor),
            // Derived against today: a promise whose date has passed is no protection.
            broken: daysBetween(note.promisedFor, now) > 0,
          }
        : null,
    };
  });

  const payables = billRows.map((b) => ({
    id: b.id,
    vendor: b.vendor,
    msmeClass: b.msmeClass,
    udyamNumber: b.udyamNumber,
    udyamActivity: b.udyamActivity,
    hasWrittenAgreement: b.hasWrittenAgreement,
    billDate: dateWord(b.billDate),
    amountPaise: b.payablePaise,
    daysElapsed: Math.max(0, daysBetween(b.billDate, now)),
  }));

  /*
    §6.12.3's empty state needs the upcoming figure rather than a zero: "nothing
    overdue" and "nothing due for a month" are different situations, and only
    one of them means the owner can stop looking.
  */
  const dueNext15Paise = payables
    .filter((p) => {
      const limit = p.hasWrittenAgreement ? 45 : 15;
      const left = limit - p.daysElapsed;
      return left >= 0 && left <= 15;
    })
    .reduce((sum, p) => sum + p.amountPaise, 0);

  // The oldest verification is the one that limits what the screen may claim.
  const verified = billRows
    .map((b) => b.udyamVerifiedOn)
    .filter((d): d is string => d !== null)
    .sort();

  /*
    The number the firm asked about first, and nothing could answer: how much
    GST has been paid on money that never showed up.

    Totalled here rather than in the browser so every screen that shows it shows
    the same figure — and because it is the one number that makes the whole
    problem visible in a single line.
  */
  const taxOnUncollectedPaise = receivables.reduce(
    (sum, r) => sum + r.taxOnUncollectedPaise,
    0,
  );

  return c.json({
    receivables,
    taxOnUncollectedPaise,
    payables,
    dueNext15Paise,
    udyamVerifiedAsOf: verified.length > 0 ? dateWord(verified[0]!) : null,
  });
});

/**
 * FR-904 — log what was said, and any date that was promised.
 *
 * `Remind` and `Log call` existed as buttons with nothing behind them. This is
 * what they now write to; the reminder exclusion reads the same row back.
 */
moneyRoutes.post("/collections/:invoiceId/contact", requirePermission("collection:write"), async (c) => {
  const caller = c.get("caller");
  const invoiceId = c.req.param("invoiceId");
  const body = await c.req.json<{ note?: string; promisedFor?: string | null }>();

  if (!body.note || body.note.trim() === "") {
    return c.json({ error: "A chase with no note tells the next caller nothing" }, 400);
  }

  const [invoice] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, caller.tenantId)))
    .limit(1);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);

  const [row] = await db
    .insert(collectionContacts)
    .values({
      tenantId: caller.tenantId,
      invoiceId,
      note: body.note.trim(),
      promisedFor: body.promisedFor ?? null,
      actorUserId: caller.userId,
    })
    .returning();

  return c.json(row, 201);
});
