import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  branches, contracts, customers, invoiceLines, invoices, jobs, sites, tenants,
} from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import {
  adviseSupply,
  codeForAato,
  computeTotals,
  derivePlaceOfSupply,
  type InvoiceLine,
} from "../lib/tax.ts";
import { financialYear, formatNumber, nextInSeries } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";

/**
 * Invoices — FR-802, FR-803, FR-812, FR-1101.
 *
 * **The place of supply is derived from the site, never from the caller.** It
 * is not a field the request may set. Charging CGST+SGST where IGST was due is
 * the commonest and most expensive GST error a small service firm makes, and it
 * is invisible until a notice arrives — so the one input that decides it comes
 * from the customer's own site record, and the sentence explaining the
 * derivation is stored on the invoice.
 *
 * **Totals are computed here, not accepted.** A client that sends its own
 * `grandTotalPaise` is a client that can round differently, and the register
 * would stop agreeing with the returns. The database has the footing
 * constraint as a second line of defence.
 */
export const invoiceRoutes = apiRouter();

/** Frozen onto the invoice at issue — a document keeps what was printed on it. */
type BillTo = {
  name: string;
  gstin: string | null;
  billingStateCode: string;
  siteAddress: string;
  siteLocality: string;
  siteStateCode: string;
  sitePincode: string;
};

async function resolveBillTo(
  tenantId: string,
  customerId: string,
  siteId: string | null,
): Promise<{ billTo: BillTo; siteStateCode: string } | null> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)))
    .limit(1);
  if (!customer) return null;

  const rows = await db
    .select()
    .from(sites)
    .where(eq(sites.customerId, customer.id));
  const site = siteId ? rows.find((s) => s.id === siteId) : rows[0];
  if (!site) return null;

  return {
    siteStateCode: site.stateCode,
    billTo: {
      name: customer.name,
      gstin: customer.gstin,
      billingStateCode: customer.billingStateCode,
      siteAddress: site.addressLine1,
      siteLocality: site.locality,
      siteStateCode: site.stateCode,
      sitePincode: site.pincode,
    },
  };
}

const lineInput = z.object({
  description: z.string().trim().min(1),
  code: z.string().trim().min(4),
  kind: z.enum(["service", "goods"]),
  qty: z.number().int().positive(),
  ratePaise: z.number().int().positive(),
  /** FR-804's slabs. Free text here is how a withdrawn slab gets re-used. */
  ratePercent: z.union([z.literal(0), z.literal(5), z.literal(18), z.literal(40)]),
});

invoiceRoutes.get("/", requirePermission("invoice:read"), async (c) => {
  const { tenantId } = c.get("caller");
  /*
    The register, with the customer's name on each row.

    Screens read this to answer "what has already been billed" and to build the
    Tally envelope, and both need the name — joining it here rather than
    shipping the customer list alongside and matching in the browser.
  */
  const rows = await db
    .select({ invoice: invoices, customer: customers.name })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .where(eq(invoices.tenantId, tenantId))
    .orderBy(asc(invoices.issueDate), asc(invoices.number));

  /*
    Lines travel with the register.

    The GST workspace builds the Tally and Zoho envelopes from these, and both
    are per-line documents. Fetching them one invoice at a time would be a
    request per row on the one screen that reads every row.
  */
  const lines = rows.length
    ? await db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.tenantId, tenantId))
        .orderBy(asc(invoiceLines.position))
    : [];
  const linesFor = new Map<string, typeof lines>();
  for (const line of lines) {
    const bucket = linesFor.get(line.invoiceId) ?? [];
    bucket.push(line);
    linesFor.set(line.invoiceId, bucket);
  }

  return c.json({
    invoices: rows.map(({ invoice, customer }) => ({
      ...invoice,
      customer,
      lines: linesFor.get(invoice.id) ?? [],
    })),
  });
});

invoiceRoutes.get("/:id", requirePermission("invoice:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const [row] = await db
    .select({
      invoice: invoices,
      customer: customers.name,
      jobNumber: jobs.jobNumber,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .leftJoin(jobs, eq(invoices.jobId, jobs.id))
    .where(and(eq(invoices.id, c.req.param("id")), eq(invoices.tenantId, tenantId)))
    .limit(1);
  if (!row) return c.json({ error: "No such invoice" }, 404);

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, row.invoice.id))
    .orderBy(asc(invoiceLines.position));

  return c.json({
    ...row.invoice,
    customer: row.customer,
    // The job this settles, by the number a person reads (FR-210).
    jobNumber: row.jobNumber,
    /*
      `12 Jun 2026`. Formatted here rather than on the screen because the same
      document is printed, exported and read aloud, and three places formatting
      one date is three chances to disagree about it.
    */
    dateWord: new Date(`${row.invoice.issueDate}T00:00:00`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
    lines,
  });
});

const createInvoice = z
  .object({
    /** Exactly one origin. An invoice that traces to nothing is one the job
        board cannot explain, so ad-hoc is explicit rather than implied. */
    jobId: z.string().uuid().optional(),
    contractId: z.string().uuid().optional(),
    contractPoint: z.number().int().positive().optional(),
    customerId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    lines: z.array(lineInput).min(1),
  })
  .refine(
    (v) => [v.jobId, v.contractId, v.customerId].filter(Boolean).length === 1,
    { message: "Give exactly one of jobId, contractId or customerId" },
  )
  .refine((v) => !v.contractId || v.contractPoint !== undefined, {
    message: "A contract invoice must say which instalment it settles",
  });

invoiceRoutes.post(
  "/",
  requirePermission("invoice:write"),
  zBody( createInvoice),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    let customerId: string | null = body.customerId ?? null;
    let siteId: string | null = body.siteId ?? null;
    let jobId: string | null = null;
    let contractId: string | null = null;

    if (body.jobId) {
      const [job] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, body.jobId), eq(jobs.tenantId, caller.tenantId)))
        .limit(1);
      if (!job) return c.json({ error: "No such job" }, 404);
      jobId = job.id;
      customerId = job.customerId;
      siteId = job.siteId;
    }

    if (body.contractId) {
      const [contract] = await db
        .select()
        .from(contracts)
        .where(and(eq(contracts.id, body.contractId), eq(contracts.tenantId, caller.tenantId)))
        .limit(1);
      if (!contract) return c.json({ error: "No such contract" }, 404);
      contractId = contract.id;
      customerId = contract.customerId;
      siteId = contract.siteId;
    }

    if (!customerId) return c.json({ error: "No customer to bill" }, 400);

    const resolved = await resolveBillTo(caller.tenantId, customerId, siteId);
    if (!resolved) {
      /*
        Refused rather than guessed. A customer with no site has no place of
        supply, so the invoice cannot state whether it is CGST+SGST or IGST —
        and an invoice that cannot state its own tax head must not be issued.
      */
      return c.json(
        { error: "That customer has no site on file, so the tax head cannot be derived" },
        400,
      );
    }

    const branchId = caller.branchId;
    if (!branchId) return c.json({ error: "No branch on file" }, 400);
    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);
    if (!branch?.stateCode) return c.json({ error: "The branch has no state code" }, 400);

    // FR-802 — from the site's state against the branch's, and explained.
    const derivation = derivePlaceOfSupply(resolved.siteStateCode, branch.stateCode);

    // FR-803 — 4 digits at or below ₹5 crore AATO, 6 above.
    const [tenant] = await db
      .select({ aatoPaise: tenants.aatoPaise })
      .from(tenants)
      .where(eq(tenants.id, caller.tenantId))
      .limit(1);
    const lines: InvoiceLine[] = body.lines.map((l) => ({
      ...l,
      code: codeForAato(l.code, tenant?.aatoPaise ?? 0),
    }));

    // FR-812 — computed here. A client-supplied total can round differently.
    const totals = computeTotals(lines, derivation.head);

    const now = new Date();
    const sequence = await nextInSeries(caller.tenantId, branchId, "invoice", now);
    const number = formatNumber("invoice", branch.invoiceSeriesPrefix, sequence, now);

    const [invoice] = await db
      .insert(invoices)
      .values({
        tenantId: caller.tenantId,
        branchId,
        number,
        financialYear: financialYear(now),
        jobId,
        contractId,
        contractPoint: body.contractPoint ?? null,
        customerId,
        siteId,
        billTo: resolved.billTo,
        issueDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
        head: derivation.head,
        explanation: derivation.explanation,
        taxablePaise: totals.taxablePaise,
        totalTaxPaise: totals.totalTaxPaise,
        roundOffPaise: totals.roundOffPaise,
        grandTotalPaise: totals.grandTotalPaise,
        status: "DRAFT",
      })
      .returning();

    await db.insert(invoiceLines).values(
      lines.map((l, index) => ({
        tenantId: caller.tenantId,
        invoiceId: invoice!.id,
        position: index + 1,
        description: l.description,
        code: l.code,
        kind: l.kind,
        qty: l.qty,
        ratePaise: l.ratePaise,
        ratePercent: l.ratePercent,
      })),
    );

    await audit(caller, "CREATE_INVOICE", `Raised ${number} for ${resolved.billTo.name}`, {
      table: "invoices",
      id: invoice!.id,
    });

    /*
      FR-806 — advisory, never blocking. Goods and services at different rates
      on one invoice may be a composite supply taking the principal rate, or
      two things genuinely sold apart. The tax position belongs to the taxpayer,
      not to the software, so this asks rather than decides.
    */
    return c.json({ ...invoice, lines, supplyAdvice: adviseSupply(lines) }, 201);
  },
);

/**
 * Issue a draft — FR-806.
 *
 * Nothing did this. `invoice:finalise` was granted to roles and used by no
 * route, `POST /` created a `DRAFT`, and no code path ever set `ISSUED`. So an
 * invoice raised through the product stayed a draft for ever: absent from
 * receivables, absent from GSTR-1, and never actually billed to anybody. The
 * GST period reported it as "still a draft" and refused to export, which is
 * the only place the problem surfaced at all.
 *
 * **The number was allocated when the draft was created**, not here. That is
 * recorded as an open question rather than quietly relied on: two drafts
 * raised in one order and issued in another give a series whose dates run
 * backwards against its numbers, which is the §31 question nobody wants at an
 * assessment. Issuing therefore leaves `issueDate` alone — the date the number
 * belongs to — rather than stamping today onto a number drawn last week.
 */
invoiceRoutes.post("/:id/issue", requirePermission("invoice:finalise"), async (c) => {
  const caller = c.get("caller");
  const id = c.req.param("id");

  const [invoice] = await db
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, caller.tenantId)))
    .limit(1);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);

  // Issuing twice is not idempotent housekeeping; it is a second document.
  if (invoice.status === "ISSUED") {
    return c.json({ error: `${invoice.number} has already been issued.` }, 409);
  }

  const [lines] = await db
    .select({ value: count() })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id));
  if (Number(lines?.value ?? 0) === 0) {
    return c.json({ error: "An invoice with no lines bills nothing." }, 409);
  }

  const [updated] = await db
    .update(invoices)
    .set({ status: "ISSUED" })
    .where(and(eq(invoices.id, id), eq(invoices.status, "DRAFT")))
    .returning({ id: invoices.id, number: invoices.number, status: invoices.status });

  await audit(caller, "ISSUE_INVOICE", `Issued ${invoice.number}`, {
    table: "invoices",
    id,
  });

  return c.json(updated);
});
