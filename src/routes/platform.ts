import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { adminDb } from "../db/client.ts";
import { hashPassword } from "../auth/password.ts";
import { apiRouter } from "../lib/router.ts";
import { zBody } from "../lib/validate.ts";
import { tenants, users } from "../db/schema.ts";
import { platformPlans, tenantSubscriptions, subscriptionEvents,
  tenantLifecycle, platformSupportGrants, platformAudit } from "../db/platform-schema.ts";

/** Privileged control plane: only the ERP admin server holds this environment
 * secret. It is never returned to a browser and has no development fallback. */
export const platformRoutes = apiRouter();
platformRoutes.use("*", async (c, next) => {
  const expected = process.env.ERP_PLATFORM_CONTROL_SECRET;
  if (!expected || expected.length < 32) return c.json({ error: "Platform control is not configured" }, 503);
  const presented = c.req.header("x-erp-platform-secret") ?? "";
  const left = Buffer.from(presented); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return c.json({ error: "Platform authorization required" }, 401);
  }
  const actor = c.req.header("x-erp-platform-actor") ?? "";
  if (!z.email().safeParse(actor).success) return c.json({ error: "Named platform actor required" }, 400);
  await next();
});
const actorOf = (c: { req: { header(name: string): string | undefined } }) =>
  c.req.header("x-erp-platform-actor")!;
const tenantId = z.uuid();
const planBody = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
  name: z.string().trim().min(2).max(120),
  modules: z.array(z.enum(["sales", "operations", "finance", "reports", "customFields"]))
    .min(1).max(5),
  allowances: z.object({ users: z.number().int().min(1).max(100_000),
    storageBytes: z.number().int().min(0).max(1_000_000_000_000),
    communications: z.number().int().min(0).max(100_000_000) }),
  monthlyPricePaise: z.number().int().min(0).max(1_000_000_000),
  trialDays: z.number().int().min(0).max(365) });
platformRoutes.get("/plans", async (c) => c.json({ plans: await adminDb.select().from(platformPlans)
  .orderBy(platformPlans.code) }));
/** Company setup needs a usable access profile, not a prerequisite catalogue task.
 * The unique code arbitrates concurrent retries. Plan and audit insert together;
 * a retry reads in a new statement so it sees a concurrent winner after waiting.
 * Never reactivate/overwrite a retired or operator-defined plan with the same code. */
platformRoutes.post("/plans/bootstrap", async (c) => {
  const activePlans = () => adminDb.select().from(platformPlans)
    .where(eq(platformPlans.active, true)).orderBy(platformPlans.code);
  const existing = await activePlans();
  if (existing.length) return c.json({ plans: existing, created: false });
  const result = await adminDb.execute(sql`
    WITH candidate AS (
      SELECT CASE WHEN n = 0 THEN 'ERP_DEFAULT_ACCESS'
        ELSE 'ERP_DEFAULT_ACCESS_' || n END AS code
      FROM generate_series(0, (SELECT count(*)::integer FROM platform_plans)) AS n
      WHERE NOT EXISTS (SELECT 1 FROM platform_plans WHERE code =
        CASE WHEN n = 0 THEN 'ERP_DEFAULT_ACCESS' ELSE 'ERP_DEFAULT_ACCESS_' || n END)
      ORDER BY n LIMIT 1
    ), inserted AS (
      INSERT INTO platform_plans
        (code, name, modules, allowances, monthly_price_paise, trial_days, active)
      SELECT code, 'Default access',
        '["sales","operations","finance","reports","customFields"]'::jsonb,
        '{"users":5,"storageBytes":100000000,"communications":1000}'::jsonb,
        0, 14, true FROM candidate
      WHERE NOT EXISTS (SELECT 1 FROM platform_plans WHERE active)
      ON CONFLICT (code) DO NOTHING RETURNING *
    ), audited AS (
      INSERT INTO platform_audit (actor, action, detail)
      SELECT ${actorOf(c)}, 'BOOTSTRAP_ERP_DEFAULT_ACCESS',
        jsonb_build_object('code', code, 'modules', modules, 'allowances', allowances,
          'monthlyPricePaise', monthly_price_paise, 'trialDays', trial_days)
      FROM inserted RETURNING id
    ) SELECT id FROM audited`);
  const plans = await activePlans();
  if (!plans.length) return c.json({ error: "Default access could not be prepared. Retry company setup." }, 409);
  return c.json({ plans, created: result.rows.length > 0 });
});
platformRoutes.post("/plans", zBody(planBody), async (c) => {
  const body = c.req.valid("json");
  const [plan] = await adminDb.insert(platformPlans).values(body).returning();
  await adminDb.insert(platformAudit).values({ actor: actorOf(c), action: "CREATE_ERP_PLAN",
    detail: { code: body.code, allowances: body.allowances, modules: body.modules } });
  return c.json(plan, 201);
});

platformRoutes.get("/tenants", async (c) => {
  const rows = await adminDb.select({ id: tenants.id, businessName: tenants.businessName,
    legalName: tenants.legalName, planCode: tenantSubscriptions.planCode,
    subscriptionStatus: tenantSubscriptions.status, lifecycleStatus: tenantLifecycle.status })
    .from(tenants).leftJoin(tenantSubscriptions, eq(tenants.id, tenantSubscriptions.tenantId))
    .leftJoin(tenantLifecycle, eq(tenants.id, tenantLifecycle.tenantId))
    .orderBy(tenants.businessName);
  return c.json({ tenants: rows });
});
const tenantBody = z.object({ businessName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(160), ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.email().max(255), initialPassword: z.string().min(10).max(200),
  branchName: z.string().trim().min(2).max(120), stateCode: z.string().regex(/^[0-9]{2}$/),
  planCode: z.string().min(3).max(40) });
platformRoutes.post("/tenants", zBody(tenantBody), async (c) => {
  const body = c.req.valid("json");
  const passwordHash = await hashPassword(body.initialPassword);
  const created = await adminDb.execute(sql`SELECT * FROM create_platform_erp_tenant(
    ${body.businessName}, ${body.legalName}, ${body.ownerName},
    ${body.ownerEmail.toLowerCase()}, ${passwordHash}, ${body.branchName},
    ${body.stateCode}, ${body.planCode}, ${actorOf(c)})`);
  return c.json(created.rows[0], 201);
});

platformRoutes.get("/tenants/:id", async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const [company] = await adminDb.select().from(tenants).where(eq(tenants.id, parsed.data)).limit(1);
  if (!company) return c.json({ error: "No such tenant" }, 404);
  const [[subscription], [lifecycle], events] = await Promise.all([
    adminDb.select().from(tenantSubscriptions).where(eq(tenantSubscriptions.tenantId, parsed.data)),
    adminDb.select().from(tenantLifecycle).where(eq(tenantLifecycle.tenantId, parsed.data)),
    adminDb.select().from(subscriptionEvents).where(eq(subscriptionEvents.tenantId, parsed.data))
      .orderBy(desc(subscriptionEvents.occurredAt)),
  ]);
  return c.json({ company, subscription: subscription ?? null, lifecycle: lifecycle ?? null, events });
});
platformRoutes.get("/tenants/:id/usage", async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const result = await adminDb.execute(sql`
    SELECT (SELECT count(*) FROM users WHERE tenant_id = ${parsed.data}::uuid AND active) AS users,
      (SELECT coalesce(sum(byte_length), 0) FROM site_document_versions
        WHERE tenant_id = ${parsed.data}::uuid) AS storage_bytes,
      (SELECT count(*) FROM reminders WHERE tenant_id = ${parsed.data}::uuid
        AND state = 'sent') AS communications`);
  const [subscription] = await adminDb.select().from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.tenantId, parsed.data)).limit(1);
  const [plan] = subscription ? await adminDb.select().from(platformPlans)
    .where(eq(platformPlans.code, subscription.planCode)).limit(1) : [];
  return c.json({ usage: result.rows[0] ?? null, allowances: plan?.allowances ?? null });
});
platformRoutes.post("/tenants/:id/plan", zBody(z.object({ planCode: z.string().min(3),
  reason: z.string().trim().min(5).max(500) })), async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const body = c.req.valid("json");
  const [plan] = await adminDb.select().from(platformPlans).where(and(
    eq(platformPlans.code, body.planCode), eq(platformPlans.active, true))).limit(1);
  if (!plan) return c.json({ error: "No active plan has that code" }, 404);
  const result = await adminDb.execute(sql`
    WITH changed AS (UPDATE tenant_subscriptions SET plan_code = ${plan.code},
      updated_at = now() WHERE tenant_id = ${parsed.data}::uuid
      AND status <> 'CLOSED' RETURNING tenant_id, plan_code),
    event AS (INSERT INTO subscription_events
      (tenant_id, kind, plan_code, amount_paise, note, actor)
      SELECT tenant_id, 'PLAN_CHANGED', plan_code, 0, ${body.reason}, ${actorOf(c)}
      FROM changed RETURNING id)
    SELECT changed.tenant_id FROM changed JOIN event ON true`);
  if (!result.rows.length) return c.json({ error: "No open subscription" }, 409);
  await adminDb.insert(platformAudit).values({ tenantId: parsed.data,
    actor: actorOf(c), action: "CHANGE_ERP_PLAN",
    detail: { planCode: plan.code, reason: body.reason } });
  return c.json({ tenantId: parsed.data, planCode: plan.code });
});
const subscriptionEventBody = z.object({ kind: z.enum(["INVOICE_CREATED", "RENEWED",
    "PAYMENT_FAILED", "TRIAL_EXPIRED"]),
  note: z.string().trim().min(5).max(500),
  invoiceNumber: z.string().trim().min(2).max(80).optional(),
  periodEndsAt: z.iso.datetime().optional() });
platformRoutes.post("/tenants/:id/subscription-events", zBody(subscriptionEventBody), async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const body = c.req.valid("json");
  const [subscription] = await adminDb.select().from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.tenantId, parsed.data)).limit(1);
  if (!subscription || subscription.status === "CLOSED") return c.json({ error: "No open subscription" }, 409);
  const [plan] = await adminDb.select().from(platformPlans)
    .where(eq(platformPlans.code, subscription.planCode)).limit(1);
  if (!plan) return c.json({ error: "Plan unavailable" }, 409);
  if (body.kind === "TRIAL_EXPIRED" &&
    (subscription.status !== "TRIAL" || !subscription.trialEndsAt ||
      subscription.trialEndsAt > new Date())) {
    return c.json({ error: "Trial has not expired" }, 409);
  }
  if (body.kind === "INVOICE_CREATED" && !body.invoiceNumber) {
    return c.json({ error: "Platform invoice number required" }, 400);
  }
  const next = body.kind === "TRIAL_EXPIRED" ? "EXPIRED" :
    body.kind === "PAYMENT_FAILED" ? "PAST_DUE" :
      body.kind === "RENEWED" ? "ACTIVE" : subscription.status;
  const amount = body.kind === "INVOICE_CREATED" ? plan.monthlyPricePaise : 0;
  const result = await adminDb.execute(sql`
    WITH changed AS (UPDATE tenant_subscriptions SET status = ${next},
      period_ends_at = COALESCE(${body.periodEndsAt ?? null}::timestamptz, period_ends_at),
      updated_at = now() WHERE tenant_id = ${parsed.data}::uuid AND status <> 'CLOSED'
      RETURNING tenant_id, plan_code),
    event AS (INSERT INTO subscription_events
      (tenant_id, kind, plan_code, amount_paise, invoice_number, note, actor)
      SELECT tenant_id, ${body.kind}, plan_code, ${amount}::bigint,
        ${body.invoiceNumber ?? null}, ${`[SIMULATED — NO CHARGE] ${body.note}`}, ${actorOf(c)}
      FROM changed RETURNING id)
    SELECT event.id FROM event`);
  return c.json({ id: (result.rows[0] as { id: string }).id, kind: body.kind,
    simulated: true, chargeAttempted: false }, 201);
});
platformRoutes.post("/maintenance/trials", async (c) => {
  const result = await adminDb.execute(sql`
    WITH due AS (UPDATE tenant_subscriptions SET status = 'EXPIRED', updated_at = now()
      WHERE status = 'TRIAL' AND trial_ends_at <= now()
      RETURNING tenant_id, plan_code),
    events AS (INSERT INTO subscription_events
      (tenant_id, kind, plan_code, amount_paise, note, actor)
      SELECT tenant_id, 'TRIAL_EXPIRED', plan_code, 0,
        'Trial ended by platform maintenance; no charge attempted', ${actorOf(c)}
      FROM due RETURNING tenant_id)
    SELECT tenant_id FROM events`);
  await adminDb.insert(platformAudit).values({ actor: actorOf(c),
    action: "RECONCILE_ERP_TRIALS", detail: { expired: result.rows.length } });
  return c.json({ expired: result.rows.length });
});

platformRoutes.post("/tenants/:id/lifecycle", zBody(z.object({ action: z.enum(["PAUSE", "REACTIVATE", "CLOSE"]),
  reason: z.string().trim().min(10).max(500), retentionUntil: z.iso.datetime().optional() })),
  async (c) => {
    const parsed = tenantId.safeParse(c.req.param("id"));
    if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
    const body = c.req.valid("json");
    const [before] = await adminDb.select().from(tenantLifecycle)
      .where(eq(tenantLifecycle.tenantId, parsed.data)).limit(1);
    if (!before) return c.json({ error: "No lifecycle record" }, 404);
    if (body.action === "REACTIVATE" && before.status !== "PAUSED" ||
      body.action === "PAUSE" && before.status !== "ACTIVE" ||
      body.action === "CLOSE" && (before.status === "CLOSED" ||
        !before.lastExportAt || Date.now() - before.lastExportAt.getTime() > 86_400_000 ||
        !body.retentionUntil || new Date(body.retentionUntil) <= new Date())) {
      return c.json({ error: "Lifecycle transition needs the correct prior state, a recent export and explicit future retention for closure" }, 409);
    }
    const status = body.action === "REACTIVATE" ? "ACTIVE" :
      body.action === "PAUSE" ? "PAUSED" : "CLOSED";
    const [updated] = await adminDb.update(tenantLifecycle).set({ status,
      reason: body.reason, retentionUntil: body.action === "CLOSE" ?
        new Date(body.retentionUntil!) : before.retentionUntil,
      changedAt: new Date(), changedBy: actorOf(c) })
      .where(eq(tenantLifecycle.tenantId, parsed.data)).returning();
    await adminDb.insert(platformAudit).values({ tenantId: parsed.data,
      actor: actorOf(c), action: `ERP_TENANT_${status}`, detail: { reason: body.reason,
        retentionUntil: body.retentionUntil ?? null } });
    return c.json(updated);
  });

platformRoutes.post("/tenants/:id/export", async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const [company] = await adminDb.select().from(tenants).where(eq(tenants.id, parsed.data)).limit(1);
  if (!company) return c.json({ error: "No such tenant" }, 404);
  const tableRows = await adminDb.execute(sql`
    SELECT DISTINCT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
      AND table_name <> 'tenants' ORDER BY table_name`);
  const records: Record<string, unknown[]> = { tenants: [company] };
  for (const item of tableRows.rows as { table_name: string }[]) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.table_name)) continue;
    const result = await adminDb.execute(sql.raw(`SELECT to_jsonb(t) - 'password_hash' -
      'token_hash' - 'code_hash' AS record FROM "${item.table_name}" t WHERE tenant_id =
      '${parsed.data}'::uuid`));
    records[item.table_name] = result.rows.map((row) => row.record);
  }
  const exportedAt = new Date();
  const manifest = { tenantId: parsed.data, exportedAt: exportedAt.toISOString(),
    format: "ERP tenant JSON v1", records };
  const sha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  await adminDb.update(tenantLifecycle).set({ lastExportAt: exportedAt,
    lastExportSha256: sha256 }).where(eq(tenantLifecycle.tenantId, parsed.data));
  await adminDb.insert(platformAudit).values({ tenantId: parsed.data,
    actor: actorOf(c), action: "EXPORT_ERP_TENANT", detail: { sha256 } });
  return c.json({ ...manifest, sha256 });
});

platformRoutes.get("/tenants/:id/support", async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const grants = await adminDb.select().from(platformSupportGrants)
    .where(eq(platformSupportGrants.tenantId, parsed.data))
    .orderBy(desc(platformSupportGrants.createdAt));
  return c.json({ grants });
});
platformRoutes.post("/tenants/:id/support", zBody(z.object({ adminEmail: z.email(),
  reason: z.string().trim().min(10).max(500), expiresAt: z.iso.datetime() })), async (c) => {
  const parsed = tenantId.safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid tenant" }, 400);
  const body = c.req.valid("json");
  const expiry = new Date(body.expiresAt);
  if (body.adminEmail.toLowerCase() !== actorOf(c).toLowerCase()) {
    return c.json({ error: "A support grant must name the signed-in ERP administrator" }, 403);
  }
  const [lifecycle] = await adminDb.select().from(tenantLifecycle)
    .where(eq(tenantLifecycle.tenantId, parsed.data)).limit(1);
  if (!lifecycle || lifecycle.status === "CLOSED") {
    return c.json({ error: "Closed or unknown tenant cannot receive support access" }, 409);
  }
  if (expiry <= new Date() || expiry.getTime() - Date.now() > 24 * 3_600_000) {
    return c.json({ error: "Support grants must expire within 24 hours" }, 400);
  }
  const [grant] = await adminDb.insert(platformSupportGrants).values({ tenantId: parsed.data,
    adminEmail: body.adminEmail.toLowerCase(), reason: body.reason,
    expiresAt: expiry, createdBy: actorOf(c) }).returning();
  await adminDb.insert(platformAudit).values({ tenantId: parsed.data,
    actor: actorOf(c), action: "GRANT_ERP_SUPPORT", detail: { id: grant!.id,
      adminEmail: grant!.adminEmail, reason: body.reason, expiresAt: body.expiresAt } });
  return c.json(grant, 201);
});
platformRoutes.post("/support/:id/revoke", async (c) => {
  const parsed = z.uuid().safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid grant" }, 400);
  const [grant] = await adminDb.update(platformSupportGrants).set({ revokedAt: new Date() })
    .where(and(eq(platformSupportGrants.id, parsed.data),
      sql`${platformSupportGrants.revokedAt} IS NULL`)).returning();
  if (!grant) return c.json({ error: "Grant is already revoked or absent" }, 404);
  await adminDb.insert(platformAudit).values({ tenantId: grant.tenantId,
    actor: actorOf(c), action: "REVOKE_ERP_SUPPORT", detail: { id: grant.id } });
  return c.json({ id: grant.id, revokedAt: grant.revokedAt });
});
platformRoutes.post("/support/:id/records", async (c) => {
  const parsed = z.uuid().safeParse(c.req.param("id"));
  if (!parsed.success) return c.json({ error: "Invalid grant" }, 400);
  const [grant] = await adminDb.select().from(platformSupportGrants)
    .where(eq(platformSupportGrants.id, parsed.data)).limit(1);
  const [lifecycle] = grant ? await adminDb.select().from(tenantLifecycle)
    .where(eq(tenantLifecycle.tenantId, grant.tenantId)).limit(1) : [];
  if (!grant || grant.revokedAt || grant.beginsAt > new Date() || grant.expiresAt <= new Date() ||
      grant.adminEmail !== actorOf(c).toLowerCase() || lifecycle?.status === "CLOSED") {
    return c.json({ error: "Support access has expired or been revoked" }, 403);
  }
  const records = await adminDb.execute(sql`
    SELECT id, name, customer_type, account_status FROM customers
      WHERE tenant_id = ${grant.tenantId}::uuid ORDER BY name LIMIT 100`);
  await adminDb.insert(platformAudit).values({ tenantId: grant.tenantId,
    actor: actorOf(c), action: "READ_ERP_SUPPORT_RECORDS", detail: { grantId: grant.id } });
  return c.json({ tenantId: grant.tenantId, records: records.rows });
});
