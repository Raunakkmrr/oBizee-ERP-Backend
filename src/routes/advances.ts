import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { advances, branches, customers, invoices, sites } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { advanceTax, unadjustedTaxPaise } from "../lib/advances.ts";
import { derivePlaceOfSupply } from "../lib/tax.ts";
import { financialYear, formatNumber, nextInSeries } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";

/**
 * Advances received — FR-810.
 *
 * Money taken before the work is a taxable event in its own right: tax falls
 * due on receipt, and §31(3)(d) requires a **Receipt Voucher** — its own
 * series, never the invoice series — at the moment it arrives.
 *
 * **The tax is back-calculated, not grossed up.** A customer paying "₹3,60,000
 * for the year" pays a gross figure; they have not separately handed over 18%.
 * Grossing up collects tax the customer never sent and leaves the ledger short.
 */
export const advanceRoutes = apiRouter();

advanceRoutes.get("/", requirePermission("payment:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const rows = await db
    .select()
    .from(advances)
    .where(eq(advances.tenantId, tenantId))
    .orderBy(asc(advances.receivedOn));

  const withTax = rows.map((row) => ({
    ...row,
    // The split, because "₹4,24,800 received" is not the figure the return
    // needs — the taxable value and the tax inside it are.
    tax: advanceTax(row.receiptPaise, row.ratePercent, row.head),
  }));

  return c.json({
    advances: withTax,
    /*
      Tax already paid on work not yet done. Real money out of the bank against
      a service still owed — nobody looking at "who owes us" would otherwise see
      it, which is what makes the cash position flattering rather than true.
    */
    unadjustedTaxPaise: unadjustedTaxPaise(rows),
  });
});

advanceRoutes.post(
  "/",
  requirePermission("payment:write"),
  zValidator(
    "json",
    z.object({
      customerId: z.string().uuid(),
      contractId: z.string().uuid().nullable().optional(),
      /** What the customer actually paid, tax included. */
      receiptPaise: z.number().int().positive(),
      ratePercent: z.union([z.literal(0), z.literal(5), z.literal(18), z.literal(40)]).default(18),
      receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, body.customerId), eq(customers.tenantId, caller.tenantId)))
      .limit(1);
    if (!customer) return c.json({ error: "No such customer" }, 404);

    const branchId = caller.branchId;
    if (!branchId) return c.json({ error: "No branch on file" }, 400);
    const [branch] = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1);
    if (!branch?.stateCode) return c.json({ error: "The branch has no state code" }, 400);

    // The head follows the site, exactly as an invoice's does — an advance for
    // interstate work is IGST from the moment it is received.
    const [site] = await db
      .select({ stateCode: sites.stateCode })
      .from(sites)
      .where(eq(sites.customerId, customer.id))
      .limit(1);
    if (!site) {
      return c.json(
        { error: "That customer has no site on file, so the tax head cannot be derived" },
        400,
      );
    }
    const derivation = derivePlaceOfSupply(site.stateCode, branch.stateCode);

    const on = new Date(`${body.receivedOn}T00:00:00`);
    const sequence = await nextInSeries(caller.tenantId, branchId, "receipt_voucher", on);
    const voucherNumber = formatNumber("receipt_voucher", "RV", sequence, on);

    const [advance] = await db
      .insert(advances)
      .values({
        tenantId: caller.tenantId,
        branchId,
        voucherNumber,
        financialYear: financialYear(on),
        customerId: customer.id,
        contractId: body.contractId ?? null,
        receivedOn: body.receivedOn,
        receiptPaise: body.receiptPaise,
        ratePercent: body.ratePercent,
        head: derivation.head,
        status: "OPEN",
      })
      .returning();

    await audit(caller, "RECORD_ADVANCE", `Issued ${voucherNumber} for ${customer.name}`, {
      table: "advances",
      id: advance!.id,
    });

    return c.json(
      { ...advance, tax: advanceTax(body.receiptPaise, body.ratePercent, derivation.head) },
      201,
    );
  },
);

/**
 * Adjust an open advance against an invoice.
 *
 * Once only — the unique index on `adjusted_by_invoice_id` and the `OPEN`
 * filter both say so. Closing a voucher twice would double-count the credit,
 * and silently: the return would show less liability than exists.
 */
advanceRoutes.post(
  "/:id/adjust",
  requirePermission("payment:write"),
  zValidator("json", z.object({ invoiceId: z.string().uuid() })),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const { invoiceId } = c.req.valid("json");

    const [invoice] = await db
      .select({ id: invoices.id, number: invoices.number })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, caller.tenantId)))
      .limit(1);
    if (!invoice) return c.json({ error: "No such invoice" }, 404);

    const [updated] = await db
      .update(advances)
      .set({ status: "ADJUSTED", adjustedByInvoiceId: invoice.id, adjustedAt: new Date() })
      .where(
        and(
          eq(advances.id, id),
          eq(advances.tenantId, caller.tenantId),
          // Only an OPEN advance may be adjusted; the filter is the guard.
          eq(advances.status, "OPEN"),
          isNull(advances.adjustedByInvoiceId),
        ),
      )
      .returning();

    if (!updated) {
      return c.json({ error: "That advance is not open, or does not exist" }, 409);
    }

    await audit(
      caller,
      "ADJUST_ADVANCE",
      `Adjusted ${updated.voucherNumber} into ${invoice.number}`,
      { table: "advances", id },
    );
    return c.json(updated);
  },
);
