import { zBody, zParam, zQuery } from "../lib/validate.ts";
import { z } from "zod";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.ts";
import { branches, customers, gstr9Filings, invoiceLines, invoices, tenants } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { audit } from "../lib/audit.ts";
import { computeTotals, type InvoiceLine } from "../lib/tax.ts";

/**
 * The GST workspace — FR-814, FR-1001, FR-1002.
 *
 * **The one decision this serves: can I file this period, and what is
 * unresolved?** Not "here are your numbers" — the accountant already has
 * numbers. What he has never had is a machine willing to say *no, and here is
 * exactly why*.
 *
 * So the export is **blocked**, not warned about. A partial GST export produces
 * a return that looks filed and is wrong, and the taxpayer carries that.
 *
 * FR-814's footing line proves the working paper agrees with the invoice
 * register **to the paisa**, and says which side is short when it does not.
 * Recomputing the tables from the lines and then checking them against the
 * stored invoice totals is the whole point: if the two ever disagree, one of
 * them is lying and the reconciliation is what finds out.
 */
export const gstRoutes = apiRouter();

/** GSTR-1's tables, as far as this product fills them. */
type Table = {
  code: string;
  label: string;
  documents: number;
  taxablePaise: number;
  taxPaise: number;
  /**
   * §6.14's partial state. A table that could not be computed shows an inline
   * error and disables the export with the reason named — it is never silently
   * treated as zero, which would file a wrong return that looks complete.
   */
  failed: boolean;
};

/**
 * What is unresolved in this period, by kind — §6.14.
 *
 * Not every unresolved thing blocks a return, and the previous binary
 * ready/blocked shape said otherwise: a place-of-supply override is
 * **legitimate and stored with a reason**, and folding it in with a missing
 * HSN code meant a correctly-documented override refused to export. Some of
 * these need review before filing; only some make the return wrong.
 */
const READINESS_KINDS = [
  "MISSING_CODE",
  "OVERRIDDEN_POS",
  "UNADJUSTED_ADVANCE",
  "CREDIT_NOTE",
  "RCM_INWARD",
  "PENDING_IRN",
  "B2C_SMALL",
] as const;

type ReadinessKind = (typeof READINESS_KINDS)[number];

/** Mirrors the web app's `BLOCKS_EXPORT` — the export gate reads this. */
export const BLOCKS_EXPORT: Record<ReadinessKind, boolean> = {
  MISSING_CODE: true,
  OVERRIDDEN_POS: false,
  UNADJUSTED_ADVANCE: true,
  CREDIT_NOTE: false,
  RCM_INWARD: false,
  PENDING_IRN: true,
  B2C_SMALL: false,
};

const READINESS_HREF: Record<ReadinessKind, string> = {
  MISSING_CODE: "/invoices?filter=missing-code",
  OVERRIDDEN_POS: "/invoices?filter=pos-override",
  UNADJUSTED_ADVANCE: "/money?tab=advances",
  CREDIT_NOTE: "/invoices?filter=credit-notes",
  RCM_INWARD: "/purchases?filter=rcm",
  PENDING_IRN: "/invoices?filter=pending-irn",
  B2C_SMALL: "/gst?table=b2cs",
};

function periodBounds(period: string): { from: string; to: string; label: string } {
  const [year, month] = period.split("-").map(Number);
  const from = new Date(year!, month! - 1, 1);
  const to = new Date(year!, month!, 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return {
    from: iso(from),
    to: iso(to),
    label: from.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
  };
}

/**
 * The period, as data.
 *
 * A plain function rather than an HTTP call the export handler makes to its own
 * route: a sub-app self-request carries no caller, so `readiness` came back
 * undefined and the export blew up on it. Sharing a function is also the only
 * way the summary and the export can be guaranteed to agree.
 */
export async function gstPeriod(tenantId: string, period: string) {
    const { from, to, label } = periodBounds(period);

    const rows = await db
      .select({
        id: invoices.id,
        number: invoices.number,
        head: invoices.head,
        status: invoices.status,
        taxablePaise: invoices.taxablePaise,
        totalTaxPaise: invoices.totalTaxPaise,
        grandTotalPaise: invoices.grandTotalPaise,
        customerName: customers.name,
        customerGstin: customers.gstin,
        placeOfSupplyOverrideReason: invoices.placeOfSupplyOverrideReason,
      })
      .from(invoices)
      .innerJoin(customers, eq(invoices.customerId, customers.id))
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
        ),
      );

    const lines = rows.length
      ? await db.select().from(invoiceLines).where(eq(invoiceLines.tenantId, tenantId))
      : [];
    const linesByInvoice = new Map<string, typeof lines>();
    for (const line of lines) {
      const bucket = linesByInvoice.get(line.invoiceId) ?? [];
      bucket.push(line);
      linesByInvoice.set(line.invoiceId, bucket);
    }

    /*
      B2B is a registered customer, B2C is not — the distinction GSTR-1 draws,
      and the one that decides whether an invoice is reported line by line or
      only in a summary.
    */
    const tables: Record<string, Table> = {
      B2B: { code: "B2B", label: "Registered customers", documents: 0, taxablePaise: 0, taxPaise: 0, failed: false },
      B2CS: { code: "B2CS", label: "Unregistered, summary", documents: 0, taxablePaise: 0, taxPaise: 0, failed: false },
    };

    // Counted by kind, so the checklist can say "4 invoices" and link to them.
    const unresolved: Record<ReadinessKind, number> = {
      MISSING_CODE: 0,
      OVERRIDDEN_POS: 0,
      UNADJUSTED_ADVANCE: 0,
      CREDIT_NOTE: 0,
      RCM_INWARD: 0,
      PENDING_IRN: 0,
      B2C_SMALL: 0,
    };

    const blocking: { invoice: string; reason: string; href: string }[] = [];
    let registerTaxable = 0;
    let registerTax = 0;
    let recomputedTaxable = 0;
    let recomputedTax = 0;

    for (const invoice of rows) {
      /*
        Drafts are not supplies.

        They used to be counted into B2B and B2CS, so the working paper
        reported turnover for bills nobody had issued. The export was blocked
        while any existed, so a wrong return was never filed — but the figures
        on screen were the ones an accountant reads before deciding to file,
        and they were too high. A draft belongs in readiness, below, and
        nowhere else.
      */
      if (invoice.status === "DRAFT") {
        unresolved.PENDING_IRN += 1;
        blocking.push({
          invoice: invoice.number ?? "An unnumbered draft",
          reason: "is still a draft, so it is not part of this return",
          href: `/api/invoices/${invoice.id}`,
        });
        continue;
      }

      registerTaxable += invoice.taxablePaise;
      registerTax += invoice.totalTaxPaise;

      if (invoice.placeOfSupplyOverrideReason) unresolved.OVERRIDDEN_POS += 1;

      const own = linesByInvoice.get(invoice.id) ?? [];
      // A missing HSN/SAC code is the one that actually makes the return wrong.
      if (own.some((l) => !l.code || l.code.trim() === "")) unresolved.MISSING_CODE += 1;

      if (own.length === 0) {
        unresolved.MISSING_CODE += 1;
        tables.B2B!.failed = true;
        tables.B2CS!.failed = true;
        blocking.push({
          invoice: invoice.number ?? "An unnumbered draft",
          reason: "has no lines, so nothing can be reported for it",
          href: `/api/invoices/${invoice.id}`,
        });
        continue;
      }

      // Recomputed from the lines, not read off the invoice. If the two
      // disagree the reconciliation below catches it.
      const totals = computeTotals(
        own.map(
          (l): InvoiceLine => ({
            description: l.description,
            code: l.code,
            kind: l.kind,
            qty: l.qty,
            ratePaise: l.ratePaise,
            ratePercent: l.ratePercent,
          }),
        ),
        invoice.head,
      );
      recomputedTaxable += totals.taxablePaise;
      recomputedTax += totals.totalTaxPaise;

      const bucket = invoice.customerGstin ? tables.B2B! : tables.B2CS!;
      bucket.documents += 1;
      bucket.taxablePaise += totals.taxablePaise;
      bucket.taxPaise += totals.totalTaxPaise;

      if (invoice.customerGstin === null) unresolved.B2C_SMALL += 1;

      if (invoice.customerGstin === null && invoice.grandTotalPaise > 2_50_000_00) {
        // A B2C supply above ₹2.5 lakh is reported as B2CL with the place of
        // supply, which needs the customer's state — not a summary line.
        blocking.push({
          invoice: invoice.number ?? "An unnumbered draft",
          reason: "is over ₹2.5 lakh to an unregistered customer and needs a GSTIN or a B2CL entry",
          href: `/api/invoices/${invoice.id}`,
        });
      }
    }

    /*
      FR-814's footing line. The working paper is built from the lines; the
      register is what the invoices say. They must agree to the paisa, and when
      they do not this names which side is short rather than reporting a
      cheerful total.
    */
    const taxableDeltaPaise = recomputedTaxable - registerTaxable;
    const taxDeltaPaise = recomputedTax - registerTax;
    const foots = taxableDeltaPaise === 0 && taxDeltaPaise === 0;
    if (!foots) {
      // The tables are the side that was recomputed, so they are the side that
      // must declare itself untrustworthy.
      tables.B2B!.failed = true;
      tables.B2CS!.failed = true;
      blocking.push({
        invoice: "—",
        reason: `the working paper and the invoice register disagree by ${(
          (taxableDeltaPaise + taxDeltaPaise) / 100
        ).toFixed(2)} — one of them is wrong`,
        href: "/api/gst",
      });
    }

    const readiness = READINESS_KINDS.filter((kind) => unresolved[kind] > 0).map((kind) => ({
      kind,
      count: unresolved[kind],
      href: READINESS_HREF[kind],
    }));

    return {
      periodLabel: label,
      period,
      from,
      to,
      registerTaxablePaise: registerTaxable,
      registerTaxPaise: registerTax,
      registerDocuments: rows.length,
      tables: Object.values(tables),
      reconciliation: { foots, taxableDeltaPaise, taxDeltaPaise },
      readiness,
      /*
        The export gate, kept separate from the checklist. `readiness` is what
        the accountant reads; this is what the export obeys. A period is
        blocked when something makes the return *wrong* — not merely when
        something needs a look.
      */
      blocked: blocking.length > 0 || readiness.some((r) => BLOCKS_EXPORT[r.kind]),
      blockingReasons: blocking,
    };
}

gstRoutes.get(
  "/:period",
  requirePermission("gst:read"),
  zParam( z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })),
  async (c) => {
    const { tenantId } = c.get("caller");
    return c.json(await gstPeriod(tenantId, c.req.param("period")));
  },
);

/**
 * FR-1001 — Tally, and FR-1002 — a filtered workbook with its provenance.
 *
 * Both refuse when the period is not ready, for the reason above: an export
 * that looks filed and is wrong is worse than no export.
 *
 * The payload carries **who exported it, when, and on what filters**. A number
 * whose filters are unknown cannot be defended in an assessment, and the
 * accountant is the one who will be asked.
 */
gstRoutes.get(
  "/:period/export",
  requirePermission("export:generate"),
  zParam( z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) })),
  zQuery( z.object({ format: z.enum(["tally", "zoho", "json"]).default("json") })),
  async (c) => {
    const caller = c.get("caller");
    const { from, to, label } = periodBounds(c.req.param("period"));
    const format = c.req.valid("query").format;

    const summary = await gstPeriod(caller.tenantId, c.req.param("period"));

    if (summary.blocked) {
      return c.json(
        {
          error: "This period is not ready to file, so it will not export",
          readiness: summary.readiness.filter((r) => BLOCKS_EXPORT[r.kind]),
          reasons: summary.blockingReasons,
        },
        409,
      );
    }

    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, caller.tenantId),
          gte(invoices.issueDate, from),
          lte(invoices.issueDate, to),
        ),
      );
    const lines = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.tenantId, caller.tenantId));
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, caller.tenantId))
      .limit(1);
    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, caller.branchId ?? ""))
      .limit(1);

    const provenance = {
      source: "GSTR-1 working paper",
      period: label,
      branch: branch?.name ?? "—",
      gstin: branch?.gstin ?? "—",
      exportedBy: caller.name,
      exportedAt: new Date().toISOString(),
      documents: rows.length,
    };

    if (format === "tally") {
      return c.json({
        provenance,
        company: tenant?.legalName ?? "",
        vouchers: rows.map((invoice) => ({
          number: invoice.number,
          date: invoice.issueDate.replace(/-/g, ""),
          // Party debited, income and tax credited — the envelope Tally expects.
          partyAmountPaise: -invoice.grandTotalPaise,
          salesAmountPaise: invoice.taxablePaise,
          taxAmountPaise: invoice.totalTaxPaise,
          head: invoice.head,
          narration: (invoice.billTo as { name?: string })?.name ?? "",
        })),
      });
    }

    if (format === "zoho") {
      /*
        Zoho's own column names, ISO dates and **rupees, not paise**. Each of
        those is a manual fix otherwise, and FR-1001's requirement is that it
        imports *without* manual fixing.
      */
      return c.json({
        provenance,
        columns: [
          "Invoice Number", "Invoice Date", "Customer Name", "Item Name",
          "HSN/SAC", "Quantity", "Item Price", "Item Tax %", "Item Tax Type",
        ],
        rows: rows.flatMap((invoice) =>
          lines
            .filter((l) => l.invoiceId === invoice.id)
            .map((l) => [
              invoice.number,
              invoice.issueDate,
              (invoice.billTo as { name?: string })?.name ?? "",
              l.description,
              l.code,
              l.qty,
              l.ratePaise / 100,
              l.ratePercent,
              invoice.head === "IGST" ? "Inter State" : "Intra State",
            ]),
        ),
      });
    }

    return c.json({ provenance, summary });
  },
);

/**
 * When the annual return for a year was filed.
 *
 * **Why the product has to ask.** §34(2) shuts the credit-note window on 30
 * November following the financial year *or* the day GSTR-9 was filed,
 * whichever is earlier. Nothing here can observe that date — it happens on the
 * portal, usually by the CA — so until somebody records it every deadline the
 * product shows is the statute's outside date, which is the generous one.
 *
 * For a firm above ₹2 crore, where GSTR-9 is mandatory, that gap is the
 * difference between believing there is until November and finding the window
 * shut in September.
 */
gstRoutes.post(
  "/annual-return",
  requirePermission("gst:write"),
  zBody(
    z.object({
      /** 2026 means the 2026-27 year. */
      financialYear: z.number().int().min(2017).max(2100),
      filedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [row] = await db
      .insert(gstr9Filings)
      .values({
        tenantId: caller.tenantId,
        financialYear: body.financialYear,
        filedOn: body.filedOn,
        recordedByUserId: caller.userId,
      })
      /* Correcting a date somebody mistyped must be possible: it moves every
         credit-note deadline for that year. */
      .onConflictDoUpdate({
        target: [gstr9Filings.tenantId, gstr9Filings.financialYear],
        set: { filedOn: body.filedOn, recordedByUserId: caller.userId },
      })
      .returning();

    await audit(
      caller,
      "RECORD_GSTR9_FILING",
      `GSTR-9 for ${body.financialYear}-${String(body.financialYear + 1).slice(2)} filed on ${body.filedOn}`,
      { table: "gstr9_filings", id: row!.id },
    );

    return c.json(row, 201);
  },
);

/** Every year recorded, so a screen can show which are known. */
gstRoutes.get("/annual-returns", requirePermission("gst:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const rows = await db
    .select({ financialYear: gstr9Filings.financialYear, filedOn: gstr9Filings.filedOn })
    .from(gstr9Filings)
    .where(eq(gstr9Filings.tenantId, tenantId));
  return c.json({ filings: rows });
});
