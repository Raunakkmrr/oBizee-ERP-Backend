import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, withTenant } from "../db/client.ts";
import { cohortEntitlements } from "./entitlements.ts";

export type Actor = { id: string; tenantId: string; name: string };
export type NewCustomer = { id: string; branchId: string; name: string; customerType: "INDIVIDUAL" | "BUSINESS";
  billingStateCode: string; addressLine1: string; locality: string; city: string; pincode: string };
export async function readWorkspace(actor: Actor) {
  return withTenant(actor.tenantId, async () => {
    // Explicit baseline columns only; never serialize credentials, toggles or money.
    const company = await db.execute<{ id: string; businessName: string; legalName: string }>(sql`
      SELECT id,business_name AS "businessName",legal_name AS "legalName"
      FROM tenants WHERE id=${actor.tenantId}::uuid`);
    if (!company.rows[0]) return null;
    const branches = await db.execute<{ id: string; name: string; stateCode: string }>(sql`
      SELECT id,name,state_code AS "stateCode" FROM branches
      WHERE tenant_id=${actor.tenantId}::uuid ORDER BY name,id`);
    const counts = await db.execute<{ customers: number; openJobs: number }>(sql`
      SELECT (SELECT count(*)::int FROM customers WHERE tenant_id=${actor.tenantId}::uuid) AS customers,
        (SELECT count(*)::int FROM jobs WHERE tenant_id=${actor.tenantId}::uuid
          AND status NOT IN ('SIGNED_OFF','CANCELLED')) AS "openJobs"`);
    const jobs = await db.execute<{ id: string; number: string; service: string;
      status: string; scheduledDate: string | null; customer: string; branch: string }>(sql`
      SELECT j.id,j.job_number AS number,j.service_type AS service,j.status,
        j.scheduled_date::text AS "scheduledDate",c.name AS customer,b.name AS branch
      FROM jobs j JOIN customers c ON c.id=j.customer_id AND c.tenant_id=j.tenant_id
      JOIN branches b ON b.id=j.branch_id AND b.tenant_id=j.tenant_id
      WHERE j.tenant_id=${actor.tenantId}::uuid AND j.status NOT IN ('SIGNED_OFF','CANCELLED')
      ORDER BY j.scheduled_date ASC NULLS LAST,j.created_at,j.id LIMIT 20`);
    const totals = counts.rows[0];
    if (!totals) throw new Error("Incomplete company summary");
    return { company: company.rows[0], branches: branches.rows,
      counts: totals, jobs: jobs.rows, access: cohortEntitlements(),
      asOf: new Date().toISOString() };
  });
}
export async function readCustomers(actor: Actor, page: number) {
  return withTenant(actor.tenantId, async () => {
    const rows = await db.execute<{ id: string; name: string; customerType: string; billingStateCode: string }>(sql`
      SELECT id,name,customer_type AS "customerType",billing_state_code AS "billingStateCode"
      FROM customers WHERE tenant_id=${actor.tenantId}::uuid ORDER BY name,id
      LIMIT 51 OFFSET ${page * 50}`);
    return { items: rows.rows.slice(0,50), page, hasMore: rows.rows.length > 50 };
  });
}
export async function createCustomer(actor: Actor, input: NewCustomer) {
  return withTenant(actor.tenantId, async () => {
    // The existing 0073 function preserves branch/actor scope, duplicate review,
    // atomic first-site creation and its domain audit. Never bypass it.
    const customer = JSON.stringify({ name: input.name, customerType: input.customerType,
      gstin: null, udyamNumber: null, creditDays: 0, hasWrittenAgreement: false });
    const site = JSON.stringify({ label: "Primary site", addressLine1: input.addressLine1,
      locality: input.locality, city: input.city, stateCode: input.billingStateCode, pincode: input.pincode });
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = async () => {
      const result = await db.execute<{ id: string }>(sql`
        SELECT entity_id AS id FROM audit_entries WHERE tenant_id=${actor.tenantId}::uuid
          AND id=${input.id}::uuid AND actor_user_id=${actor.id}::uuid
          AND action='core.customer.request' AND summary=${fingerprint}`);
      return result.rows[0] ? { id: result.rows[0].id, created: false } : null;
    };
    const replay = await prior();
    if (replay) return replay;
    try {
      // Audit id is the idempotency key. A concurrent duplicate fails this whole
      // statement, rolling back function-created customer/site/domain audit.
      const result = await db.execute<{ id: string }>(sql`
        WITH created AS MATERIALIZED (
          SELECT customer_id FROM create_erp_customer(${actor.tenantId}::uuid,${input.branchId}::uuid,
            ${actor.id}::uuid,${actor.name},${customer}::jsonb,${site}::jsonb,NULL::jsonb)
        ) INSERT INTO audit_entries(id,tenant_id,actor_user_id,actor_name,action,summary,entity_table,entity_id)
          SELECT ${input.id}::uuid,${actor.tenantId}::uuid,${actor.id}::uuid,${actor.name},
            'core.customer.request',${fingerprint},'customers',customer_id FROM created
          RETURNING entity_id AS id`);
      return result.rows[0] ? { id: result.rows[0].id, created: true } : null;
    } catch (error) {
      const replayAfterRace = await prior();
      if (replayAfterRace) return replayAfterRace;
      const failure = error as { code?: string; cause?: { code?: string } };
      // Scope, duplicate or stale request conflicts are safe generic refusals.
      if (["23514", "23505", "23503"].includes(failure.code ?? failure.cause?.code ?? "")) return null;
      throw error;
    }
  });
}
