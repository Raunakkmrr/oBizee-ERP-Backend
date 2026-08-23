import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, count, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  branches, contracts, contractSchedules, creditNotes, customers, invoiceLines, invoices, jobs, payments, signOffs, sites, tenants, users,
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
import { billablePeriods, type BillingFrequency } from "../lib/billing-periods.ts";
import { creditedAgainst } from "./credit-notes.ts";
import { outstandingOf } from "../lib/receivables.ts";
import { inArray, ne } from "drizzle-orm";

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

/**
 * What the work has earned and nobody has billed yet.
 *
 * **The flow Raunak described**: a visit is booked, dated, assigned, done — and
 * then that period's invoice becomes available. This is the "available" half.
 * It creates nothing: FR-805 makes an invoice immutable the moment it is
 * issued, so a legally-numbered document raised automatically by a rule is a
 * mistake that cannot be withdrawn, only cancelled — leaving a hole in the
 * series somebody has to explain. A person still presses the button; this route
 * only makes sure they know there is one to press.
 *
 * Read-permissioned rather than write-permissioned, because seeing what is
 * owed is not the same act as billing it.
 */
invoiceRoutes.get("/due", requirePermission("invoice:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const live = await db
    .select({
      id: contracts.id,
      reference: contracts.reference,
      customerId: contracts.customerId,
      customer: customers.name,
      billing: contracts.billing,
      startDate: contracts.startDate,
      endDate: contracts.endDate,
      annualValuePaise: contracts.annualValuePaise,
    })
    .from(contracts)
    .innerJoin(customers, eq(contracts.customerId, customers.id))
    .where(and(eq(contracts.tenantId, tenantId), eq(contracts.status, "ACTIVE")));

  if (live.length === 0) return c.json({ due: [], totalPaise: 0 });

  const contractIds = live.map((row) => row.id);

  /*
    Two reads, both across every contract at once.

    A request per contract would be a round trip per row on a screen that
    exists to show the whole book, and the Neon HTTP driver charges a round
    trip for each one.
  */
  const [visits, billed] = await Promise.all([
    /*
      A job names its *schedule*, not its contract.

      FR-1406's multi-schedule contracts are the reason: one contract can carry
      several cadences, so the job hangs off the cadence that produced it and
      the contract is one join further out.
    */
    db
      .select({
        contractId: contractSchedules.contractId,
        scheduledDate: jobs.scheduledDate,
        status: jobs.status,
      })
      .from(jobs)
      .innerJoin(contractSchedules, eq(jobs.contractScheduleId, contractSchedules.id))
      .where(
        and(
          eq(jobs.tenantId, tenantId),
          inArray(contractSchedules.contractId, contractIds),
        ),
      ),
    db
      .select({
        contractId: invoices.contractId,
        periodStart: invoices.periodStart,
        contractPoint: invoices.contractPoint,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          inArray(invoices.contractId, contractIds),
          // A cancelled bill leaves its period billable again, or one mistake
          // would lock a month out for ever.
          ne(invoices.status, "CANCELLED"),
        ),
      ),
  ]);

  const visitsBy = new Map<string, { scheduledDate: string | null; status: string }[]>();
  for (const visit of visits) {
    if (!visit.contractId) continue;
    const bucket = visitsBy.get(visit.contractId) ?? [];
    bucket.push({ scheduledDate: visit.scheduledDate, status: visit.status });
    visitsBy.set(visit.contractId, bucket);
  }

  const billedBy = new Map<string, { periodStarts: Set<string>; instalments: Set<number> }>();
  for (const row of billed) {
    if (!row.contractId) continue;
    const bucket =
      billedBy.get(row.contractId) ??
      { periodStarts: new Set<string>(), instalments: new Set<number>() };
    if (row.periodStart) bucket.periodStarts.add(row.periodStart);
    if (row.contractPoint !== null) bucket.instalments.add(row.contractPoint);
    billedBy.set(row.contractId, bucket);
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  const due = live.flatMap((contract) =>
    billablePeriods(
      {
        billing: contract.billing as BillingFrequency,
        startDate: contract.startDate,
        endDate: contract.endDate,
        annualValuePaise: contract.annualValuePaise,
      },
      visitsBy.get(contract.id) ?? [],
      billedBy.get(contract.id) ?? { periodStarts: new Set(), instalments: new Set() },
      today,
    ).map((earned) => ({
      contractId: contract.id,
      reference: contract.reference,
      customerId: contract.customerId,
      customer: contract.customer,
      billing: contract.billing,
      instalment: earned.period.number,
      periodStart: earned.period.start,
      periodEnd: earned.period.end,
      valuePaise: earned.period.valuePaise,
      visits: earned.visits,
      visitsDone: earned.visitsDone,
      reason: earned.reason,
    })),
  );

  // Oldest first: the money that has been owed longest is the money to chase.
  due.sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  return c.json({
    due,
    totalPaise: due.reduce((sum, row) => sum + row.valuePaise, 0),
  });
});

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
      jobId: jobs.id,
      jobDate: jobs.scheduledDate,
      jobService: jobs.serviceType,
      technician: users.name,
    })
    .from(invoices)
    .innerJoin(customers, eq(invoices.customerId, customers.id))
    .leftJoin(jobs, eq(invoices.jobId, jobs.id))
    .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
    .where(and(eq(invoices.id, c.req.param("id")), eq(invoices.tenantId, tenantId)))
    .limit(1);
  if (!row) return c.json({ error: "No such invoice" }, 404);

  const lines = await db
    .select()
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, row.invoice.id))
    .orderBy(asc(invoiceLines.position));

  /*
    The evidence behind the bill — §6.11.1's reason this screen exists at all,
    so the accountant can bill without opening the job.

    It was not on the payload, and the screen rendered a hardcoded visit
    instead: every invoice in the product claimed it was for a gas top-up on
    30 July by Ramesh Yadav, signed by Anil Joshi at four stars, whatever the
    job actually said. An invoice review screen showing another job's signature
    is worse than showing none — it is evidence for a different bill.
  */
  /*
    What has been received against it, and what is still owed.

    Neither was on the payload, so no screen could say whether an issued
    invoice had been paid — and the one mutation that records a payment was
    called by nothing. A firm could raise a bill and had no way to mark it
    settled, which makes the receivables figure a number that only ever grows.

    Derived, never stored: FR-901 treats partial payment as normal, so an
    invoice carries many payments and its balance is the arithmetic. A status
    field somebody has to remember to flip is the version that goes wrong.
  */
  const received = await db
    .select({
      id: payments.id,
      receivedOn: payments.receivedOn,
      amountPaise: payments.amountPaise,
      method: payments.method,
      reference: payments.reference,
      recordedBy: users.name,
    })
    .from(payments)
    .leftJoin(users, eq(payments.recordedByUserId, users.id))
    .where(and(eq(payments.tenantId, tenantId), eq(payments.invoiceId, row.invoice.id)))
    .orderBy(asc(payments.receivedOn));

  const paidPaise = received.reduce((sum, p) => sum + p.amountPaise, 0);
  /* Credit notes reduce what is owed as surely as a payment does. */
  const creditedPaise = (await creditedAgainst(tenantId, [row.invoice.id])).get(row.invoice.id) ?? 0;

  /*
    The notes themselves, not just the total.

    A screen showing only "credited ₹1,180" cannot say the thing that matters
    since Rule 67B: whether the customer has accepted it. An issued note the
    customer has ignored has not reduced the tax, and looks identical to one
    that has.
  */
  const notes = await db
    .select({
      id: creditNotes.id,
      number: creditNotes.number,
      grandTotalPaise: creditNotes.grandTotalPaise,
      reason: creditNotes.reason,
      status: creditNotes.status,
      imsState: creditNotes.imsState,
      issueDate: creditNotes.issueDate,
    })
    .from(creditNotes)
    .where(and(eq(creditNotes.tenantId, tenantId), eq(creditNotes.invoiceId, row.invoice.id)))
    .orderBy(asc(creditNotes.createdAt));

  const [signOff] = row.jobId
    ? await db
        .select({
          signerName: signOffs.signerName,
          rating: signOffs.rating,
          comment: signOffs.comment,
        })
        .from(signOffs)
        .where(and(eq(signOffs.tenantId, tenantId), eq(signOffs.jobId, row.jobId)))
        .limit(1)
    : [];

  return c.json({
    ...row.invoice,
    customer: row.customer,
    // The job this settles, by the number a person reads (FR-210).
    jobNumber: row.jobNumber,
    /* Null when the invoice is not against a job — an ad-hoc bill has no
       visit, and the panel says so rather than inventing one. */
    fromJob: row.jobNumber
      ? {
          dateWord: row.jobDate
            ? new Date(`${row.jobDate}T00:00:00`).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })
            : null,
          technician: row.technician,
          serviceType: row.jobService,
          signerName: signOff?.signerName ?? null,
          rating: signOff?.rating ?? null,
          comment: signOff?.comment ?? null,
        }
      : null,
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
    paidPaise,
    creditedPaise,
    creditNotes: notes,
    /* One definition, shared with every other screen that answers this — see
       `lib/receivables.ts` for why it is not six expressions. */
    outstandingPaise: outstandingOf({
      grandTotalPaise: row.invoice.grandTotalPaise,
      paidPaise,
      creditedPaise,
    }),
    payments: received.map((p) => ({
      id: p.id,
      amountPaise: p.amountPaise,
      method: p.method,
      reference: p.reference,
      recordedBy: p.recordedBy,
      dateWord: new Date(`${p.receivedOn}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    })),
  });
});

const createInvoice = z
  .object({
    /** Exactly one origin. An invoice that traces to nothing is one the job
        board cannot explain, so ad-hoc is explicit rather than implied. */
    jobId: z.string().uuid().optional(),
    contractId: z.string().uuid().optional(),
    contractPoint: z.number().int().positive().optional(),
    /**
     * Which slice of the contract this settles — FR-505.
     *
     * `contractPoint` numbers the instalment; these name the dates it covers.
     * The dates are what the partial unique index enforces, so they are what
     * stops August being billed twice — and what lets the document say
     * "1 Aug to 31 Aug" rather than "instalment 5", which is the only one of
     * the two a customer can check.
     */
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
  })
  // Both or neither, matching the CHECK on the table. A period with one end is
  // not a period, and half of one would slip past the uniqueness guarantee.
  .refine((v) => (v.periodStart === undefined) === (v.periodEnd === undefined), {
    message: "A billing period needs both a start and an end",
  })
  .refine((v) => !v.periodStart || !!v.contractId, {
    message: "Only a contract invoice covers a billing period",
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

    /*
      No number yet — a draft is not a document anybody can refer to.

      It used to draw one here, so abandoning a draft left a permanent hole in
      a series Rule 46(b) wants consecutive, and two drafts raised in one order
      and issued in another gave dates that ran backwards against numbers. The
      number is drawn at issue, where the document becomes real.
    */
    const now = new Date();

    const [invoice] = await db
      .insert(invoices)
      .values({
        tenantId: caller.tenantId,
        branchId,
        number: null,
        financialYear: financialYear(now),
        jobId,
        contractId,
        contractPoint: body.contractPoint ?? null,
        periodStart: body.periodStart ?? null,
        periodEnd: body.periodEnd ?? null,
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

    // A draft has no number to name it by, so the customer does the naming.
    await audit(caller, "CREATE_INVOICE", `Drafted an invoice for ${resolved.billTo.name}`, {
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
    .select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      branchId: invoices.branchId,
    })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, caller.tenantId)))
    .limit(1);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);

  // Issuing twice is not idempotent housekeeping; it is a second document.
  if (invoice.status === "ISSUED") {
    return c.json({ error: `${invoice.number} has already been issued.` }, 409);
  }
  if (invoice.status === "CANCELLED") {
    return c.json({ error: `${invoice.number} was cancelled and cannot be issued.` }, 409);
  }

  const [lines] = await db
    .select({ value: count() })
    .from(invoiceLines)
    .where(eq(invoiceLines.invoiceId, id));
  if (Number(lines?.value ?? 0) === 0) {
    return c.json({ error: "An invoice with no lines bills nothing." }, 409);
  }

  const [branch] = await db
    .select({ id: branches.id, invoiceSeriesPrefix: branches.invoiceSeriesPrefix })
    .from(branches)
    .where(eq(branches.id, invoice.branchId))
    .limit(1);
  if (!branch) return c.json({ error: "No branch on file" }, 400);

  /*
    The number is drawn here, and the date with it.

    Both together, or the series stops meaning anything: a number allocated
    today against a date from last week is exactly the backwards-running series
    this change exists to prevent. `next_in_series` is atomic, so two people
    issuing at once get two numbers rather than racing for one.
  */
  const now = new Date();
  const sequence = await nextInSeries(caller.tenantId, branch.id, "invoice", now);
  const number = formatNumber("invoice", branch.invoiceSeriesPrefix, sequence, now);

  const [updated] = await db
    .update(invoices)
    .set({
      status: "ISSUED",
      number,
      issueDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      financialYear: financialYear(now),
    })
    .where(and(eq(invoices.id, id), eq(invoices.status, "DRAFT")))
    .returning({ id: invoices.id, number: invoices.number, status: invoices.status });

  await audit(caller, "ISSUE_INVOICE", `Issued ${number}`, {
    table: "invoices",
    id,
  });

  return c.json(updated);
});

/**
 * Cancel an invoice.
 *
 * **The number is kept.** Rule 46(b) wants one consecutive series per
 * financial year, and reusing a number that has been issued puts two documents
 * in that series under the same identity — which is the single thing the
 * series exists to prevent, and unarguable once the first one is in a filed
 * GSTR-1. A cancelled number is spent; the return reports it as cancelled.
 *
 * A draft needs no cancelling in this sense: it never had a number to spend,
 * which is the point of allocating at issue.
 *
 * If the supply happened and the amount is wrong, this is the wrong tool — a
 * credit note under §34 is, and it is a separate document with its own series.
 */
invoiceRoutes.post("/:id/cancel", requirePermission("invoice:finalise"), async (c) => {
  const caller = c.get("caller");
  const id = c.req.param("id");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: undefined }));

  if (!body.reason || body.reason.trim().length < 3) {
    return c.json(
      { error: "Say why it is being cancelled — a cancelled number is asked about.", field: "reason" },
      400,
    );
  }

  const [invoice] = await db
    .select({ id: invoices.id, number: invoices.number, status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.tenantId, caller.tenantId)))
    .limit(1);
  if (!invoice) return c.json({ error: "No such invoice" }, 404);
  if (invoice.status === "CANCELLED") {
    return c.json({ error: `${invoice.number} is already cancelled.` }, 409);
  }

  const [paid] = await db
    .select({ value: count() })
    .from(payments)
    .where(eq(payments.invoiceId, id));
  if (Number(paid?.value ?? 0) > 0) {
    return c.json(
      {
        error: `${invoice.number} has payments recorded against it. Refund or credit-note it instead — cancelling would leave money against a document that no longer exists.`,
      },
      409,
    );
  }

  /*
    A draft is deleted rather than cancelled: there is nothing to keep a record
    of, no number was spent, and leaving CANCELLED rows with no number would
    make the invoice register a list of things that never happened.
  */
  if (invoice.status === "DRAFT") {
    await db.delete(invoices).where(eq(invoices.id, id));
    await audit(caller, "DISCARD_DRAFT_INVOICE", `Discarded a draft — ${body.reason.trim()}`, {
      table: "invoices",
      id,
    });
    return c.json({ id, discarded: true });
  }

  const [updated] = await db
    .update(invoices)
    .set({ status: "CANCELLED" })
    .where(eq(invoices.id, id))
    .returning({ id: invoices.id, number: invoices.number, status: invoices.status });

  await audit(
    caller,
    "CANCEL_INVOICE",
    `Cancelled ${invoice.number} — ${body.reason.trim()}. The number stays spent.`,
    { table: "invoices", id },
  );

  return c.json(updated);
});
