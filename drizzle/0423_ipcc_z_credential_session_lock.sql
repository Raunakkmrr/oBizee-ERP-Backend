-- ERP-Z-001: serialize credential proof, replacement and session revocation.
-- Called only by the privileged auth handle. No runtime-route role receives EXECUTE.
CREATE FUNCTION z_create_password_session_if_current(
  p_tenant uuid,p_user uuid,p_verified_hash text,p_verified_email text
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_user record;v_id uuid;
BEGIN
  SELECT password_hash,email,active INTO v_user FROM users
    WHERE tenant_id=p_tenant AND id=p_user FOR UPDATE;
  IF NOT FOUND OR NOT v_user.active OR
     v_user.password_hash IS DISTINCT FROM p_verified_hash OR
     v_user.email IS DISTINCT FROM p_verified_email THEN
    RETURN NULL;
  END IF;
  INSERT INTO z_sessions(tenant_id,user_id) VALUES(p_tenant,p_user) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION z_replace_password_and_revoke(
  p_tenant uuid,p_user uuid,p_new_hash text,p_must_change boolean,
  p_email text,p_expected_hash text,p_reason text
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE v_user record;
BEGIN
  IF p_reason NOT IN ('PASSWORD_CHANGE','COMPROMISE') OR
     p_new_hash IS NULL OR length(p_new_hash)<20 THEN
    RAISE EXCEPTION 'Invalid credential transition';
  END IF;
  SELECT password_hash,active INTO v_user FROM users
    WHERE tenant_id=p_tenant AND id=p_user FOR UPDATE;
  IF NOT FOUND OR NOT v_user.active OR
     (p_expected_hash IS NOT NULL AND
       v_user.password_hash IS DISTINCT FROM p_expected_hash) THEN
    RETURN false;
  END IF;
  UPDATE users SET password_hash=p_new_hash,must_change_password=p_must_change,
    email=COALESCE(p_email,email) WHERE tenant_id=p_tenant AND id=p_user;
  UPDATE z_sessions SET revoked_at=now(),revocation_reason=p_reason
    WHERE tenant_id=p_tenant AND user_id=p_user AND revoked_at IS NULL;
  UPDATE refresh_tokens SET revoked_at=now()
    WHERE tenant_id=p_tenant AND user_id=p_user AND revoked_at IS NULL;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION z_create_password_session_if_current(uuid,uuid,text,text)
  FROM PUBLIC,app_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION z_replace_password_and_revoke(uuid,uuid,text,boolean,text,text,text)
  FROM PUBLIC,app_runtime;
