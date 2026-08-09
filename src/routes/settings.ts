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
import { advances, auditEntries, branches, invoices, jobs, seriesCounters } from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";
import { financialYear } from "../lib/series.ts";
import { zQuery } from "../lib/validate.ts";

export const settingsRoutes = apiRouter();

/**
 * What each counter believes, and what the documents say.
 *
 * Both, because they can disagree and the disagreement is the whole reason to
 * look. A counter ahead of the highest document issued means numbers were
 * drawn and never used — a gap somebody will be asked about. Reporting only
 * the counter would hide exactly that.
 */
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
