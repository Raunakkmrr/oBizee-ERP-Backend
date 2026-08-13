/**
 * Settings — the numbering series, and the audit trail.
 *
 * Both are read-only here on purpose. A series counter is not a preference: it
 * is the thing GST §31 makes consecutive, and an interface that let somebody
 * type a new value into it would be an interface for creating a gap. It is
 * shown so it can be *checked*, which is a different verb.
 */
import { and, count, desc, eq, gte, max } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import { advances, auditEntries, branches, invoices, jobs, seriesCounters, tenants } from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";
import { financialYear } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";
import { zBody, zQuery } from "../lib/validate.ts";

export const settingsRoutes = apiRouter();

/**
 * Who this firm is, for the top of a printed document.
 *
 * The name and GSTIN were in the database from the first migration and no
 * endpoint returned them, so anything printed had no letterhead — a job card
 * handed to a customer at their door, with no firm on it, is a loose sheet of
 * paper. The invoice print will want exactly the same three facts.
 *
 * Under `settings:read` rather than open, because the GSTIN is the firm's own
 * registration and belongs to the office. The card falls back to the job's own
 * content when a caller may not read it, rather than failing to print.
 */
settingsRoutes.get("/profile", requirePermission("settings:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const [firm] = await db
    .select({ businessName: tenants.businessName, legalName: tenants.legalName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!firm) return c.json({ error: "No such firm" }, 404);

  /*
    One branch at launch (FR-1303), but the column has existed from day one, so
    this reads the first rather than assuming there is only ever one.
  */
  const [branch] = await db
    .select({ name: branches.name, gstin: branches.gstin, stateCode: branches.stateCode })
    .from(branches)
    .where(eq(branches.tenantId, tenantId))
    .limit(1);

  return c.json({
    businessName: firm.businessName,
    legalName: firm.legalName,
    branch: branch ?? null,
  });
});

/**
 * What each counter believes, and what the documents say.
 *
 * Both, because they can disagree and the disagreement is the whole reason to
 * look. A counter ahead of the highest document issued means numbers were
 * drawn and never used — a gap somebody will be asked about. Reporting only
 * the counter would hide exactly that.
 */
/**
 * Change the firm's own name.
 *
 * **Nothing could.** `update(tenants)` appeared nowhere in the API, so a firm
 * carried whatever name it was created with for ever — and every document it
 * printed carried that name too. An invoice is issued *by* somebody; getting
 * that wrong is not a cosmetic defect, it is the wrong supplier on a tax
 * document.
 *
 * `settings:write`, which only an owner holds. The trading name and the legal
 * name are separate fields because they are separate things: the legal name is
 * what a tax invoice must carry, the trading name is what a customer
 * recognises, and plenty of Indian firms differ on the two.
 *
 * The GSTIN is deliberately **not** here. It encodes the entity's PAN and is
 * issued by the department, not chosen — a screen that let somebody type a new
 * one would be a screen for putting a false registration on an invoice. It
 * moves with a branch, under its own route, when that is built.
 */
settingsRoutes.patch(
  "/profile",
  requirePermission("settings:write"),
  zBody(
    z.object({
      businessName: z.string().trim().min(2).max(120).optional(),
      legalName: z.string().trim().min(2).max(160).optional(),
    }).refine((v) => v.businessName !== undefined || v.legalName !== undefined, {
      message: "Give a trading name, a legal name, or both",
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [before] = await db
      .select({ businessName: tenants.businessName, legalName: tenants.legalName })
      .from(tenants)
      .where(eq(tenants.id, caller.tenantId))
      .limit(1);

    if (!before) return c.json({ error: "No such firm" }, 404);

    const [updated] = await db
      .update(tenants)
      .set({
        businessName: body.businessName ?? before.businessName,
        legalName: body.legalName ?? before.legalName,
      })
      .where(eq(tenants.id, caller.tenantId))
      .returning({ businessName: tenants.businessName, legalName: tenants.legalName });

    /*
      FR-1305. Renaming the firm changes the supplier printed on every invoice
      raised afterwards, so the trail records both sides of the change — "who
      changed what" is uninteresting here without the what it changed from.
    */
    await audit(
      caller,
      "RENAME_FIRM",
      `Renamed the firm from ${before.legalName} to ${updated!.legalName}`,
      { table: "tenants", id: caller.tenantId },
    );

    return c.json(updated);
  },
);

settingsRoutes.get("/numbering", requirePermission("settings:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const year = financialYear(new Date());

  const [branchRows, counters] = await Promise.all([
    db
      .select({
        id: branches.id,
        name: branches.name,
        jobSeriesPrefix: branches.jobSeriesPrefix,
        invoiceSeriesPrefix: branches.invoiceSeriesPrefix,
      })
      .from(branches)
      .where(eq(branches.tenantId, tenantId)),
    db
      .select({
        branchId: seriesCounters.branchId,
        docType: seriesCounters.docType,
        lastIssued: seriesCounters.lastIssued,
      })
      .from(seriesCounters)
      .where(
        and(eq(seriesCounters.tenantId, tenantId), eq(seriesCounters.financialYear, year)),
      ),
  ]);

  /*
    The numbers on documents that exist — never what the counter believes.

    Gap detection is the whole reason this screen exists, and it is a question
    only the register can answer: it compares the counter against every
    document actually issued this year. Done in a browser it would compare the
    counter against whatever that browser happened to have loaded, and report
    gaps that are merely absences.
  */
  const [jobRows, invoiceRows, advanceRows] = await Promise.all([
    db
      .select({ number: jobs.jobNumber, branchId: jobs.branchId })
      .from(jobs)
      .where(eq(jobs.tenantId, tenantId)),
    db
      .select({ number: invoices.number, branchId: invoices.branchId })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.financialYear, year))),
    db
      .select({ number: advances.voucherNumber, branchId: advances.branchId })
      .from(advances)
      .where(and(eq(advances.tenantId, tenantId), eq(advances.financialYear, year))),
  ]);

  /** `SVC/26-27/0150` → 150. The trailing group, which is the series. */
  const sequenceOf = (value: string): number | null => {
    const match = /(\d+)\s*$/.exec(value);
    return match ? Number(match[1]) : null;
  };

  const issued = new Map<string, number[]>();
  const collect = (docType: string, rows: { number: string | null; branchId: string | null }[]) => {
    for (const row of rows) {
      // A draft has no number, so it is not part of the series to check.
      const n = row.number ? sequenceOf(row.number) : null;
      if (n === null || !row.branchId) continue;
      const key = `${row.branchId}:${docType}`;
      issued.set(key, [...(issued.get(key) ?? []), n]);
    }
  };
  collect("job", jobRows);
  collect("invoice", invoiceRows);
  collect("receipt_voucher", advanceRows);

  return c.json({
    financialYear: year,
    branches: branchRows,
    counters: counters.map((row) => {
      const present = (issued.get(`${row.branchId}:${row.docType}`) ?? []).filter(
        (n) => n <= row.lastIssued,
      );
      const from = present.length > 0 ? Math.min(...present) : row.lastIssued + 1;
      const seen = new Set(present);
      const gaps: number[] = [];
      for (let n = from; n <= row.lastIssued; n += 1) if (!seen.has(n)) gaps.push(n);

      return {
        branchId: row.branchId,
        docType: row.docType,
        lastIssued: row.lastIssued,
        next: row.lastIssued + 1,
        issuedCount: present.length,
        /*
          Numbers drawn and never used. §31 wants a consecutive series, so a
          gap is a question at assessment — and one somebody has to be able to
          answer, which means seeing it before the auditor does.
        */
        gaps,
      };
    }),
  });
});

/**
 * The audit trail — FR-1305.
 *
 * Newest first and paged, because it only grows. `occurredAt` is separate from
 * `at` for the technician's phone: an event recorded in a basement at 11:04
 * and synced at 14:20 happened at 11:04, and a trail that stamps the sync time
 * has lost the fact it existed to record.
 */
settingsRoutes.get(
  "/audit",
  requirePermission("audit:read"),
  zQuery(
    z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.string().datetime().optional(),
    }),
  ),
  async (c) => {
    const { tenantId } = c.get("caller");
    const { limit, before } = c.req.valid("query");

    const where = before
      ? and(eq(auditEntries.tenantId, tenantId), gte(auditEntries.at, new Date(before)))
      : eq(auditEntries.tenantId, tenantId);

    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(auditEntries)
        .where(where)
        .orderBy(desc(auditEntries.at))
        .limit(limit),
      db.select({ value: count() }).from(auditEntries).where(eq(auditEntries.tenantId, tenantId)),
    ]);

    return c.json({
      entries: rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        // Never "system": somebody is accountable for every write.
        actor: row.actorName,
        action: row.action,
        summary: row.summary,
        origin: row.origin,
        occurredAt: row.occurredAt?.toISOString() ?? null,
      })),
      total: Number(total?.value ?? 0),
    });
  },
);
