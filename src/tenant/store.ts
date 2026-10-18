import { and, eq, sql } from "drizzle-orm";
import { adminDb, db, withTenant } from "../db/client.ts";
import { users } from "../db/schema.ts";

export type TenantUser = typeof users.$inferSelect;

/** Only deployed 0079 objects. Missing account state is a refusal, never a grant. */
export async function accountAllowed(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async () => {
    const result = await db.execute<{ allowed: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM tenant_lifecycle l
      JOIN tenant_subscriptions s ON s.tenant_id=l.tenant_id
      JOIN platform_plans p ON p.code=s.plan_code
      WHERE l.tenant_id=${tenantId}::uuid AND l.status='ACTIVE'
        AND (s.status='ACTIVE' OR (s.status='TRIAL' AND s.trial_ends_at>now()))
    ) AS allowed`);
    return result.rows[0]?.allowed === true;
  });
}

export async function passwordCandidates(email: string): Promise<TenantUser[]> {
  return adminDb.select().from(users).where(sql`lower(${users.email})=${email}`);
}

export async function activeUser(tenantId: string, userId: string): Promise<TenantUser | null> {
  return withTenant(tenantId, async () => {
    const [user] = await db.select().from(users).where(and(
      eq(users.tenantId, tenantId), eq(users.id, userId), eq(users.active, true),
    )).limit(1);
    return user && await accountAllowed(tenantId) ? user : null;
  });
}

export async function saveRefresh(tenantId: string, userId: string, sessionId: string,
  tokenHash: string): Promise<void> {
  // One statement: token and session link either both exist or neither does.
  await adminDb.execute(sql`WITH token AS (
    INSERT INTO refresh_tokens(tenant_id,user_id,token_hash,expires_at)
    VALUES(${tenantId}::uuid,${userId}::uuid,${tokenHash},now()+interval '30 days')
    RETURNING token_hash,tenant_id
  ) INSERT INTO z_session_refresh(token_hash,tenant_id,session_id)
    SELECT token_hash,tenant_id,${sessionId}::uuid FROM token`);
}

export async function revokeRefresh(tokenHash: string): Promise<void> {
  await adminDb.execute(sql`UPDATE refresh_tokens SET revoked_at=now()
    WHERE token_hash=${tokenHash} AND revoked_at IS NULL`);
}
