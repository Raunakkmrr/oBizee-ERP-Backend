import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, eq, gte, lte, sum } from "drizzle-orm";
import { db } from "../db/client.ts";
import { purchaseBills, vendors } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import {
  adviseTds, billTotals, clockFor, msmedApplies, reverseChargeFor, suggestSection,
} from "../lib/purchases.ts";
import { audit } from "../lib/audit.ts";
import { financialYear } from "../lib/series.ts";

/**
 * Vendors and inward bills — FR-705, FR-807, FR-905, FR-906.
 *
 * Three things this refuses to do quietly, all of which cost real money:
 *
 * - **Reverse charge is flagged and confirmed, never applied silently.** When
 *   it applies the GST is not paid to the vendor — the buyer remits it — so
 *   adding it to what they are owed overpays them by 18% and leaves the
 *   liability on the return regardless.
 * - **An AMC is "work" under §194C, not professional services under §194J.**
 *   This is the industry's commonest deduction error: 10% instead of 2% hands
 *   the firm's working capital to the department for a year.
 * - **TDS is computed on the taxable value, not the GST-inclusive total.**
 */
export const vendorRoutes = apiRouter();

vendorRoutes.get("/", requirePermission("part:purchase"), async (c) => {
  const { tenantId } = c.get("caller");
  const rows = await db
    .select()
    .from(vendors)
    .where(eq(vendors.tenantId, tenantId))
    .orderBy(asc(vendors.name));

  return c.json({
    vendors: rows.map((v) => {
      const msmed = msmedApplies(v);
      return {
        ...v,
        // Stated on the row, because both facts change what happens on a bill.
        reverseCharge: reverseChargeFor(v),
        msmed: msmed.applies
          ? { applies: true as const, limitDays: msmed.limitDays }
          : { applies: false as const, reason: msmed.reason },
      };
    }),
  });
});

vendorRoutes.post(
  "/",
  requirePermission("part:purchase"),
  zBody(
    z.object({
      name: z.string().trim().min(2),
      gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/).nullable().optional(),
      stateCode: z.string().regex(/^[0-9]{2}$/),
      pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).nullable().optional(),
      panType: z.enum(["INDIVIDUAL_HUF", "COMPANY_FIRM_OTHER"]),
      msmeClass: z.enum(["MICRO", "SMALL", "MEDIUM", "NOT_REGISTERED", "UNVERIFIED"]).default("UNVERIFIED"),
      udyamNumber: z.string().nullable().optional(),
      udyamActivity: z.enum(["MANUFACTURING", "SERVICE", "TRADING"]).nullable().optional(),
      hasWrittenAgreement: z.boolean().default(false),
      paymentTermsDays: z.number().int().min(0).max(180).default(30),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");
    const [vendor] = await db
      .insert(vendors)
      .values({
        tenantId: caller.tenantId,
        name: body.name,
        gstin: body.gstin ?? null,
        stateCode: body.stateCode,
        pan: body.pan ?? null,
        panType: body.panType,
        msmeClass: body.msmeClass,
        udyamNumber: body.udyamNumber ?? null,
        udyamActivity: body.udyamActivity ?? null,
        hasWrittenAgreement: body.hasWrittenAgreement,
        paymentTermsDays: body.paymentTermsDays,
      })
      .returning();
    await audit(caller, "ADD_VENDOR", `Added vendor ${body.name}`, {
      table: "vendors",
      id: vendor!.id,
    });
    return c.json(vendor, 201);
  },
);

/**
 * What this bill would attract, before it is recorded.
 *
 * Exists so the interface can show reverse charge and TDS *with their reasons*
 * while the reader is still typing, and the answer it shows is the one the
 * server will apply — not a second implementation in the browser that drifts.
 */
vendorRoutes.post(
  "/advise",
  requirePermission("part:purchase"),
  zBody(
    z.object({
      vendorId: z.string().uuid(),
      description: z.string().default(""),
      taxablePaise: z.number().int().positive(),
      gstPercent: z.union([z.literal(0), z.literal(5), z.literal(18), z.literal(40)]),
      tdsSection: z.enum(["194C", "194J", "NONE"]).optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [vendor] = await db
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, body.vendorId), eq(vendors.tenantId, caller.tenantId)))
      .limit(1);
    if (!vendor) return c.json({ error: "No such vendor" }, 404);

    /*
      The *year's* running total, which is what §194C actually asks about.

      This summed every bill ever raised against the vendor. `adviseTds` then
      compared that lifetime figure against an annual ₹1,00,000 threshold, so a
      vendor billed ₹60,000 last year and ₹50,000 this year was treated as
      having crossed it — and TDS was deducted on a bill that owed none. The
      error runs one way, toward over-deduction: money withheld from a vendor
      who is entitled to it, and over-reported in the TDS return.

      1 April to 31 March, from `financialYear`, so this agrees with every other
      year boundary in the product rather than inventing a second one.
    */
    const fy = financialYear(new Date());
    const yearStart = `${fy}-04-01`;
    const yearEnd = `${fy + 1}-03-31`;
    const [paid] = await db
      .select({ total: sum(purchaseBills.taxablePaise) })
      .from(purchaseBills)
      .where(
        and(
          eq(purchaseBills.tenantId, caller.tenantId),
          eq(purchaseBills.vendorId, vendor.id),
          gte(purchaseBills.billDate, yearStart),
          lte(purchaseBills.billDate, yearEnd),
        ),
      );

    const section = body.tdsSection ?? suggestSection(body.description);
    const tds = adviseTds(section, body.taxablePaise, vendor, Number(paid?.total ?? 0));
    const rc = reverseChargeFor(vendor);
    const tdsPaise = tds.kind === "deduct" ? tds.amountPaise : 0;
    const totals = billTotals({
      taxablePaise: body.taxablePaise,
      gstPercent: body.gstPercent,
      reverseCharge: rc.applies,
      tdsPaise,
    });
    const msmed = msmedApplies(vendor);

    return c.json({
      reverseCharge: rc,
      tds,
      totals,
      suggestedSection: section,
      msmed: msmed.applies
        ? { applies: true, limitDays: msmed.limitDays }
        : { applies: false, reason: msmed.reason },
    });
  },
);

vendorRoutes.post(
  "/bills",
  requirePermission("part:purchase"),
  zBody(
    z.object({
      vendorId: z.string().uuid(),
      vendorBillNumber: z.string().trim().min(1),
      billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      description: z.string().trim().min(2),
      taxablePaise: z.number().int().positive(),
      gstPercent: z.union([z.literal(0), z.literal(5), z.literal(18), z.literal(40)]),
      /** Confirmed by a person — the advice route says what it would be. */
      reverseCharge: z.boolean(),
      tdsSection: z.enum(["194C", "194J", "NONE"]),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [vendor] = await db
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, body.vendorId), eq(vendors.tenantId, caller.tenantId)))
      .limit(1);
    if (!vendor) return c.json({ error: "No such vendor" }, 404);

    const [paid] = await db
      .select({ total: sum(purchaseBills.taxablePaise) })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.tenantId, caller.tenantId), eq(purchaseBills.vendorId, vendor.id)));

    // Recomputed here rather than trusted from the request: the advice route is
    // a convenience, and a client that sends its own TDS can send the wrong one.
    const tds = adviseTds(body.tdsSection, body.taxablePaise, vendor, Number(paid?.total ?? 0));
    const tdsPaise = tds.kind === "deduct" ? tds.amountPaise : 0;
    const totals = billTotals({
      taxablePaise: body.taxablePaise,
      gstPercent: body.gstPercent,
      reverseCharge: body.reverseCharge,
      tdsPaise,
    });

    const [bill] = await db
      .insert(purchaseBills)
      .values({
        tenantId: caller.tenantId,
        vendorId: vendor.id,
        // Snapshot — renaming a vendor must not rewrite a recorded bill.
        vendorName: vendor.name,
        vendorBillNumber: body.vendorBillNumber,
        billDate: body.billDate,
        description: body.description,
        taxablePaise: body.taxablePaise,
        gstPercent: body.gstPercent,
        gstPaise: totals.gstPaise,
        reverseCharge: body.reverseCharge,
        tdsSection: body.tdsSection,
        tdsPaise,
        payablePaise: totals.payablePaise,
        status: "UNPAID",
      })
      .returning();

    await audit(caller, "RECORD_PURCHASE", `Recorded ${vendor.name} bill ${body.vendorBillNumber}`, {
      table: "purchase_bills",
      id: bill!.id,
    });
    return c.json({ ...bill, tds }, 201);
  },
);

/** FR-905 — what is still savable, and what is already lost. Two totals. */
vendorRoutes.get("/bills", requirePermission("payment:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const now = new Date();

  const rows = await db
    .select()
    .from(purchaseBills)
    .where(eq(purchaseBills.tenantId, tenantId));
  const vendorRows = await db.select().from(vendors).where(eq(vendors.tenantId, tenantId));

  let atRiskPaise = 0;
  let lostPaise = 0;
  const bills = rows.map((bill) => {
    const vendor = vendorRows.find((v) => v.id === bill.vendorId);
    const clock = vendor ? clockFor({ ...bill, billDate: bill.billDate }, vendor, now) : null;
    if (clock?.kind === "counting") atRiskPaise += bill.taxablePaise;
    if (clock?.kind === "lapsed") lostPaise += bill.taxablePaise;
    return { ...bill, clock };
  });

  /*
    Two figures, never summed. Money on day 38 of 45 is saved by paying today;
    money on day 60 is not, and no payment brings the deduction back. Adding
    them understates the loss and overstates what can still be rescued — on the
    one screen where that distinction is the entire point.
  */
  return c.json({ bills, atRiskPaise, lostPaise });
});

/**
 * Settle a purchase bill — the §43B(h) clock stops here.
 *
 * There was no route for this at all: the money screen removed a paid bill
 * from a browser array and nothing reached the ledger, so the deduction clock
 * kept running server-side on a bill that had been paid.
 *
 * `paidOn` is a real date and not `now()`, because a bill paid on the 14th and
 * recorded on the 16th was paid on the 14th — and with a 15-day MSMED limit
 * those two days are the whole question.
 */
vendorRoutes.post(
  "/bills/:id/pay",
  requirePermission("payment:write"),
  zBody(
    z.object({
      paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reference: z.string().trim().max(120).optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const { paidOn, reference } = c.req.valid("json");

    const [bill] = await db
      .select()
      .from(purchaseBills)
      .where(and(eq(purchaseBills.id, id), eq(purchaseBills.tenantId, caller.tenantId)))
      .limit(1);
    if (!bill) return c.json({ error: "No such bill" }, 404);

    // Paying twice is not idempotent, it is a second payment nobody made.
    if (bill.status === "PAID") {
      return c.json({ error: `That bill was already settled on ${bill.paidOn}` }, 409);
    }
    if (paidOn < bill.billDate) {
      return c.json({ error: "A bill cannot be paid before it was raised" }, 400);
    }

    const [updated] = await db
      .update(purchaseBills)
      .set({ status: "PAID", paidOn })
      .where(eq(purchaseBills.id, id))
      .returning();

    await audit(
      caller,
      "PAY_PURCHASE_BILL",
      `${bill.vendorName} ${bill.vendorBillNumber} settled on ${paidOn}${reference ? ` (${reference})` : ""}`,
      { table: "purchase_bills", id },
    );

    return c.json(updated);
  },
);
