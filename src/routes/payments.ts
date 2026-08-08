import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, eq, sum } from "drizzle-orm";
import { db } from "../db/client.ts";
import { customers, invoices, payments } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { audit } from "../lib/audit.ts";

/**
 * Payments and ageing — FR-901, FR-903.
 *
 * **Partial payment is normal, not an exception.** A customer paying ₹40,000
 * against a ₹51,000 invoice is Tuesday in this business, so an invoice carries
 * many payments and its outstanding balance is derived — never a status field
 * somebody has to remember to flip.
 *
 * **The 45-day boundary is not decoration.** §43B(h) means a customer who is an
 * MSME loses the deduction on what they owe us past 45 days, which makes it a
 * lever in a collection call rather than a bucket on a chart.
 */
export const paymentRoutes = apiRouter();

/** §6.12.1's six buckets, in order. Each is a filter, not a label. */
export const AGEING_BUCKETS = ["0–15", "16–30", "31–45", "46–60", "61–90", "90+"] as const;

function bucketFor(daysOverdue: number): (typeof AGEING_BUCKETS)[number] {
  if (daysOverdue <= 15) return "0–15";
  if (daysOverdue <= 30) return "16–30";
  if (daysOverdue <= 45) return "31–45";
  if (daysOverdue <= 60) return "46–60";
  if (daysOverdue <= 90) return "61–90";
  return "90+";
}

paymentRoutes.post(
  "/",
  requirePermission("payment:write"),
  zBody(
    z.object({
      invoiceId: z.string().uuid(),
      amountPaise: z.number().int().positive(),
      receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      method: z.enum(["UPI", "BANK_TRANSFER", "CHEQUE", "CASH"]),
      reference: z.string().nullable().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, body.invoiceId), eq(invoices.tenantId, caller.tenantId)))
      .limit(1);
    if (!invoice) return c.json({ error: "No such invoice" }, 404);

    const [already] = await db
      .select({ total: sum(payments.amountPaise) })
      .from(payments)
      .where(eq(payments.invoiceId, invoice.id));
    const paid = Number(already?.total ?? 0);

    if (paid + body.amountPaise > invoice.grandTotalPaise) {
      /*
        Refused rather than accepted and reconciled later. An overpaid invoice
        is a credit note nobody has raised, and it turns up at year end as a
        balance nobody can explain.
      */
      return c.json(
        {
          error: "That is more than the invoice is for",
          invoiceTotalPaise: invoice.grandTotalPaise,
          alreadyPaidPaise: paid,
          outstandingPaise: invoice.grandTotalPaise - paid,
        },
        400,
      );
    }

    const [payment] = await db
      .insert(payments)
      .values({
        tenantId: caller.tenantId,
        invoiceId: invoice.id,
        receivedOn: body.receivedOn,
        amountPaise: body.amountPaise,
        method: body.method,
        reference: body.reference ?? null,
        recordedByUserId: caller.userId,
      })
      .returning();

    const outstanding = invoice.grandTotalPaise - (paid + body.amountPaise);
    await audit(
      caller,
      "RECORD_PAYMENT",
      `Received ₹${(body.amountPaise / 100).toLocaleString("en-IN")} against ${invoice.number}`,
      { table: "payments", id: payment!.id },
    );

    return c.json({ ...payment, outstandingPaise: outstanding, settled: outstanding === 0 }, 201);
  },
);

/** FR-903 — what is owed, by age, with the §43B(h) boundary called out. */
paymentRoutes.get("/receivables", requirePermission("payment:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const today = new Date();

  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      issueDate: invoices.issueDate,
      grandTotalPaise: invoices.grandTotalPaise,
      customerName: customers.name,
      creditDays: customers.creditDays,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(eq(invoices.tenantId, tenantId));

  const paidRows = await db
    .select({ invoiceId: payments.invoiceId, total: sum(payments.amountPaise) })
    .from(payments)
    .where(eq(payments.tenantId, tenantId))
    .groupBy(payments.invoiceId);
  const paidBy = new Map(paidRows.map((p) => [p.invoiceId, Number(p.total ?? 0)]));

  const buckets: Record<string, { amountPaise: number; count: number }> = {};
  for (const label of AGEING_BUCKETS) buckets[label] = { amountPaise: 0, count: 0 };

  const outstanding = [];
  for (const invoice of rows) {
    const due = invoice.grandTotalPaise - (paidBy.get(invoice.id) ?? 0);
    if (due <= 0) continue;

    const issued = new Date(`${invoice.issueDate}T00:00:00`);
    const dueDate = new Date(issued.getTime() + invoice.creditDays * 86_400_000);
    const daysOverdue = Math.max(
      0,
      Math.floor((today.getTime() - dueDate.getTime()) / 86_400_000),
    );
    const bucket = bucketFor(daysOverdue);
    buckets[bucket]!.amountPaise += due;
    buckets[bucket]!.count += 1;

    outstanding.push({
      ...invoice,
      outstandingPaise: due,
      daysOverdue,
      bucket,
      /*
        Stated per row, because it is the sentence that gets a bill paid: past
        45 days an MSME customer loses the deduction on what they owe us. It is
        a reason for them to pay, not a reproach from us.
      */
      pastMsmedBoundary: daysOverdue > 45,
    });
  }

  return c.json({
    outstanding: outstanding.sort((a, b) => b.daysOverdue - a.daysOverdue),
    ageing: AGEING_BUCKETS.map((label) => ({ label, ...buckets[label]! })),
    totalOutstandingPaise: outstanding.reduce((s, o) => s + o.outstandingPaise, 0),
  });
});
