import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq, sum } from "drizzle-orm";
import { db } from "../db/client.ts";
import { purchaseBills, vendors } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import {
  adviseTds, billTotals, clockFor, msmedApplies, reverseChargeFor, suggestSection,
} from "../lib/purchases.ts";
import { audit } from "../lib/audit.ts";

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
  zValidator(
    "json",
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
  zValidator(
    "json",
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

    // The year's running total with this vendor decides whether the §194C
    // thresholds have been crossed at all.
    const [paid] = await db
      .select({ total: sum(purchaseBills.taxablePaise) })
      .from(purchaseBills)
      .where(and(eq(purchaseBills.tenantId, caller.tenantId), eq(purchaseBills.vendorId, vendor.id)));

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
  zValidator(
    "json",
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
