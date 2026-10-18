import {sql} from "drizzle-orm";
import {adminDb} from "../db/client.ts";

/** Auth-only privileged table. Request handlers never receive its rows. */
export async function createAuthSession(tenantId:string,userId:string):Promise<string>{
  const result=await adminDb.execute<{id:string}>(sql`INSERT INTO z_sessions
    (tenant_id,user_id) VALUES(${tenantId}::uuid,${userId}::uuid) RETURNING id`);
  return result.rows[0]!.id;
}

/**
 * Password verification is deliberately slow and happens before this call.
 * Recheck the exact hash under the user row lock before creating a session:
 * a concurrent owner reset or own change either revokes this new session in
 * the same lock order, or wins first and makes the old proof invalid.
 */
export async function createPasswordAuthSession(tenantId:string,userId:string,
  verifiedHash:string,verifiedEmail:string):Promise<string|null>{
  const result=await adminDb.execute<{id:string|null}>(sql`
    SELECT z_create_password_session_if_current(${tenantId}::uuid,${userId}::uuid,
      ${verifiedHash},${verifiedEmail}) AS id`);
  return result.rows[0]?.id??null;
}

/** One locked commit for credential replacement and all current token revocation. */
export async function replacePasswordAndRevoke(input:{tenantId:string;userId:string;
  passwordHash:string;mustChangePassword:boolean;email?:string;
  expectedHash?:string;reason:"PASSWORD_CHANGE"|"COMPROMISE"}):Promise<boolean>{
  const result=await adminDb.execute<{changed:boolean}>(sql`
    SELECT z_replace_password_and_revoke(${input.tenantId}::uuid,${input.userId}::uuid,
      ${input.passwordHash},${input.mustChangePassword},${input.email??null},
      ${input.expectedHash??null},${input.reason}) AS changed`);
  return result.rows[0]?.changed===true;
}

export async function linkRefreshSession(tenantId:string,tokenHash:string,
  sessionId:string):Promise<void>{
  await adminDb.execute(sql`INSERT INTO z_session_refresh
    (token_hash,tenant_id,session_id) VALUES(${tokenHash},${tenantId}::uuid,
      ${sessionId}::uuid)`);
}

export async function accessSessionActive(tenantId:string,userId:string,
  sessionId:string):Promise<boolean>{
  const result=await adminDb.execute<{active:boolean}>(sql`SELECT EXISTS(
    SELECT 1 FROM z_sessions WHERE tenant_id=${tenantId}::uuid AND
      user_id=${userId}::uuid AND id=${sessionId}::uuid AND revoked_at IS NULL
  ) AS active`);
  return result.rows[0]?.active===true;
}

/** One SQL statement consumes the refresh token under a row lock. */
export async function consumeActiveRefresh(tokenHash:string):Promise<{
  id:string;tenantId:string;userId:string;sessionId:string}|null>{
  const result=await adminDb.execute<{id:string;tenant_id:string;user_id:string;
    session_id:string}>(sql`WITH matched AS (
    SELECT r.id,r.tenant_id,r.user_id,m.session_id FROM refresh_tokens r
    JOIN z_session_refresh m ON m.token_hash=r.token_hash AND m.tenant_id=r.tenant_id
    JOIN z_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_id
      AND s.user_id=r.user_id
    WHERE r.token_hash=${tokenHash} AND r.revoked_at IS NULL AND
      r.expires_at>now() AND s.revoked_at IS NULL FOR UPDATE OF r,s),
    consumed AS (UPDATE refresh_tokens r SET revoked_at=now() FROM matched
      WHERE r.id=matched.id AND r.revoked_at IS NULL RETURNING r.id)
    SELECT matched.id,matched.tenant_id,matched.user_id,matched.session_id
      FROM matched JOIN consumed ON consumed.id=matched.id`);
  const row=result.rows[0];return row?{id:row.id,tenantId:row.tenant_id,
    userId:row.user_id,sessionId:row.session_id}:null;
}

export async function revokeSessionByRefresh(tokenHash:string):Promise<void>{
  await adminDb.execute(sql`UPDATE z_sessions s SET revoked_at=now(),
    revocation_reason='SIGN_OUT' FROM z_session_refresh m
    WHERE m.token_hash=${tokenHash} AND s.id=m.session_id AND
      s.tenant_id=m.tenant_id AND s.revoked_at IS NULL`);
}

export async function revokeAllAuthSessions(tenantId:string,userId:string,
  reason:"PASSWORD_CHANGE"|"ACCOUNT_EXIT"|"COMPROMISE"):Promise<void>{
  await adminDb.execute(sql`UPDATE z_sessions SET revoked_at=now(),
    revocation_reason=${reason} WHERE tenant_id=${tenantId}::uuid
    AND user_id=${userId}::uuid AND revoked_at IS NULL`);
}
