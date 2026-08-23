/**
 * Credit notes — §34(1), the only lawful way to reduce output tax declared.
 *
 * **The problem this exists for.** When a corporate customer part-pays and asks
 * for "a new invoice" for the balance, issuing one declares a second supply:
 * the same work taxed twice, and roughly 50% more GST than was ever owed. The
 * balance is a receivable, not a supply. This is the instrument that reduces
 * what was declared, and the only one.
 *
 * **Three refusals matter more than anything else here.**
 *
 * 1. **Only against an issued invoice.** A draft has declared nothing, so there
 *    is nothing to credit — and crediting a cancelled one claims back tax that
 *    was never paid.
 * 2. **Never more than the invoice.** Credit notes together cannot exceed the
 *    document's own value, or the register claims back more than it declared.
 * 3. **The number is drawn at issue**, in its own series. §34 documents are
 *    numbered separately from invoices; sharing a run would put two document
 *    types under one consecutive series.
 *
 * ⚠️ Not tax advice, and deliberately not automated. A credit note is a
 * commercial concession and a statutory document; the CA signs off on the
 * §34(2) deadline and the IMS interaction before any of this is filed against.
 */
import { and, eq, inArray, sum } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import {
  branches,
  creditNoteLines,
  creditNotes,
  customers,
  invoices,
  sites,
  tenants,
} from "../db/schema.ts";
import { audit } from "../lib/audit.ts";
import { creditableRemaining } from "../lib/receivables.ts";
import { apiRouter } from "../lib/router.ts";
import { financialYear, formatNumber, nextInSeries } from "../lib/series.ts";
import { codeForAato, computeTotals, derivePlaceOfSupply, type InvoiceLine } from "../lib/tax.ts";
import { zBody } from "../lib/validate.ts";

export const creditNoteRoutes = apiRouter();

/** Everything already credited against an invoice, issued notes only. */
async function creditedAgainst(tenantId: string, invoiceIds: string[]): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await db
    .select({ invoiceId: creditNotes.invoiceId, total: sum(creditNotes.grandTotalPaise) })
    .from(creditNotes)
    .where(
      and(
        eq(creditNotes.tenantId, tenantId),
        eq(creditNotes.status, "ISSUED"),
        inArray(creditNotes.invoiceId, invoiceIds),
      ),
    )
    .groupBy(creditNotes.invoiceId);
  return new Map(rows.map((r) => [r.invoiceId, Number(r.total ?? 0)]));
}

export { creditedAgainst };

creditNoteRoutes.get("/", requirePermission("invoice:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const rows = await db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      issueDate: creditNotes.issueDate,
      reason: creditNotes.reason,
      grandTotalPaise: creditNotes.grandTotalPaise,
      status: creditNotes.status,
      imsState: creditNotes.imsState,
      invoiceId: creditNotes.invoiceId,
      invoiceNumber: invoices.number,
      customer: customers.name,
    })
    .from(creditNotes)
    .innerJoin(invoices, eq(creditNotes.invoiceId, invoices.id))
    .innerJoin(customers, eq(creditNotes.customerId, customers.id))
    .where(eq(creditNotes.tenantId, tenantId));

  return c.json({
    creditNotes: rows,
    /*
      Counted here so every screen reads the same number: how many are issued
      but not yet accepted, and therefore have NOT reduced the tax despite
      looking like they have.
    */
    awaitingAcceptance: rows.filter((r) => r.status === "ISSUED" && r.imsState === "PENDING").length,
  });
});

const raise = z.object({
  invoiceId: z.string().uuid(),
  reason: z.string().trim().min(4),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1),
        code: z.string().trim().min(4),
        kind: z.enum(["service", "goods"]).default("service"),
        qty: z.number().positive(),
        ratePaise: z.number().int().positive(),
        ratePercent: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

creditNoteRoutes.post("/", requirePermission("invoice:write"), zBody(raise), async (c) => {
  const caller = c.get("caller");
  const body = c.req.valid("json");

  const [invoice] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, body.invoiceId), eq(invoices.tenantId, caller.tenantId)))
    .limit(1);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);

  /*
    Only an issued invoice can be credited.

    A draft has declared nothing — discarding it is the way back, and it costs
    no number. A cancelled one already charges nobody, so crediting it would
    claim back tax that was never paid.
  */
  if (invoice.status !== "ISSUED") {
    return c.json(
      {
        error:
          invoice.status === "DRAFT"
            ? "That invoice has not been issued, so there is nothing to credit. Discard the draft instead."
            : "That invoice is cancelled, so it charges nobody. There is nothing to credit.",
      },
      409,
    );
  }

  const credited = (await creditedAgainst(caller.tenantId, [invoice.id])).get(invoice.id) ?? 0;
  const remaining = creditableRemaining({
    grandTotalPaise: invoice.grandTotalPaise,
    creditedPaise: credited,
  });

  const [tenant] = await db
    .select({ aatoPaise: tenants.aatoPaise })
    .from(tenants)
    .where(eq(tenants.id, caller.tenantId))
    .limit(1);

  const lines: InvoiceLine[] = body.lines.map((l) => ({
    ...l,
    code: codeForAato(l.code, tenant?.aatoPaise ?? 0),
  }));

  /*
    The tax head is the invoice's, not re-derived.

    A credit note follows the supply it corrects: if the original was CGST+SGST
    then so is this, whatever the site's address says today. Re-deriving would
    let a customer who moved states have a note that credits a different tax
    head from the one that was charged — which reconciles against nothing.
  */
  const totals = computeTotals(lines, invoice.head);

  if (totals.grandTotalPaise > remaining) {
    return c.json(
      {
        error: `That is more than is left to credit on ${invoice.number}.`,
        invoiceTotalPaise: invoice.grandTotalPaise,
        alreadyCreditedPaise: credited,
        remainingPaise: remaining,
      },
      400,
    );
  }

  const branchId = invoice.branchId ?? caller.branchId;
  if (!branchId) return c.json({ error: "No branch on file" }, 400);

  const now = new Date();
  const [note] = await db
    .insert(creditNotes)
    .values({
      tenantId: caller.tenantId,
      branchId,
      // No number yet: drawn at issue, exactly as an invoice's is.
      number: null,
      financialYear: financialYear(now),
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      siteId: invoice.siteId,
      billTo: invoice.billTo,
      issueDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      reason: body.reason.trim(),
      head: invoice.head,
      explanation: invoice.explanation,
      taxablePaise: totals.taxablePaise,
      totalTaxPaise: totals.totalTaxPaise,
      roundOffPaise: totals.roundOffPaise,
      grandTotalPaise: totals.grandTotalPaise,
      status: "DRAFT",
    })
    .returning();

  await db.insert(creditNoteLines).values(
    lines.map((l, position) => ({
      tenantId: caller.tenantId,
      creditNoteId: note!.id,
      position,
      description: l.description,
      code: l.code,
      kind: l.kind,
      qty: String(l.qty),
      ratePaise: l.ratePaise,
      ratePercent: l.ratePercent,
      taxablePaise: Math.round(l.qty * l.ratePaise),
      taxPaise: Math.round((l.qty * l.ratePaise * l.ratePercent) / 100),
    })),
  );

  return c.json({ ...note, lines }, 201);
});

creditNoteRoutes.post("/:id/issue", requirePermission("invoice:finalise"), async (c) => {
  const caller = c.get("caller");
  const id = c.req.param("id");

  const [note] = await db
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.id, id), eq(creditNotes.tenantId, caller.tenantId)))
    .limit(1);
  if (!note) return c.json({ error: "No such credit note" }, 404);
  if (note.status !== "DRAFT") {
    return c.json({ error: `${note.number ?? "That note"} has already been issued.` }, 409);
  }

  const [branch] = await db
    .select({ prefix: branches.invoiceSeriesPrefix })
    .from(branches)
    .where(eq(branches.id, note.branchId))
    .limit(1);

  const on = new Date(`${note.issueDate}T00:00:00`);
  const sequence = await nextInSeries(caller.tenantId, note.branchId, "credit_note", on);
  // Its own prefix: `CRN/26-27/0001`, never mistakable for an invoice.
  const number = formatNumber("invoice", `${branch?.prefix ?? "SVC"}-CRN`, sequence, on);

  const [issued] = await db
    .update(creditNotes)
    .set({ number, status: "ISSUED" })
    .where(eq(creditNotes.id, id))
    .returning();

  await audit(caller, "ISSUE_CREDIT_NOTE", `Issued ${number} — ${note.reason}`, {
    table: "credit_notes",
    id,
  });

  return c.json(issued);
});

/**
 * Record what the customer did with it on the portal.
 *
 * Not a guess and not a poll: nobody here can see the customer's IMS dashboard,
 * so this is somebody reporting what they found. Recorded rather than assumed,
 * because the difference between accepted and pending is the difference between
 * the tax being reduced and the liability coming back next month.
 */
creditNoteRoutes.patch(
  "/:id/ims",
  requirePermission("gst:write"),
  zBody(z.object({ state: z.enum(["PENDING", "ACCEPTED", "REJECTED"]) })),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const { state } = c.req.valid("json");

    const [updated] = await db
      .update(creditNotes)
      .set({ imsState: state, imsCheckedAt: new Date() })
      .where(and(eq(creditNotes.id, id), eq(creditNotes.tenantId, caller.tenantId)))
      .returning();
    if (!updated) return c.json({ error: "No such credit note" }, 404);

    await audit(
      caller,
      "RECORD_CREDIT_NOTE_IMS",
      `${updated.number ?? "A credit note"} marked ${state.toLowerCase()} on the portal`,
      { table: "credit_notes", id },
    );

    return c.json(updated);
  },
);
