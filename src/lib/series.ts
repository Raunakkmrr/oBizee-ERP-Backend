import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";

/**
 * Take the next number in a series — FR-811.
 *
 * Delegates to the `next_in_series` function created in `0001_guards.sql`,
 * which is a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. That is
 * atomic: twenty concurrent callers get 1..20 with no duplicate and no gap,
 * which is verified against the live database rather than assumed.
 *
 * The browser held this as one integer per series and `series.ts` in the web
 * app said outright that a shared statutory sequence needs the backend. This is
 * that backend.
 */
export type DocType = "job" | "invoice" | "receipt_voucher";

/** 1 April boundary — 2026 means the 2026-27 financial year. */
export function financialYear(on: Date): number {
  return on.getMonth() >= 3 ? on.getFullYear() : on.getFullYear() - 1;
}

export function fyLabel(year: number): string {
  return `${String(year).slice(2)}-${String(year + 1).slice(2)}`;
}

export async function nextInSeries(
  tenantId: string,
  branchId: string,
  docType: DocType,
  on: Date,
): Promise<number> {
  const year = financialYear(on);
  const rows = await db.execute<{ next_in_series: number }>(
    sql`select next_in_series(${tenantId}::uuid, ${branchId}::uuid, ${docType}::doc_type, ${year}) as next_in_series`,
  );
  const value = rows.rows?.[0]?.next_in_series ?? (rows as unknown as { next_in_series: number }[])[0]?.next_in_series;
  if (typeof value !== "number") throw new Error("next_in_series returned nothing");
  return value;
}

export function formatNumber(
  docType: DocType,
  prefix: string,
  sequence: number,
  on: Date,
): string {
  const nnnn = String(sequence).padStart(4, "0");
  if (docType === "job") {
    // Spoken on the phone (FR-210), so month-shaped rather than FY-shaped.
    return `${prefix}-${String(on.getFullYear()).slice(2)}${String(on.getMonth() + 1).padStart(2, "0")}-${nnnn}`;
  }
  const fy = fyLabel(financialYear(on));
  return docType === "invoice" ? `${prefix}/${fy}/${nnnn}` : `RV/${fy}/${nnnn}`;
}
