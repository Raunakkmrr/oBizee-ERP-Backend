-- ERP-Z-001. Server-side session identity for immediate access-token revocation.
CREATE TABLE z_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_rotated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revocation_reason text,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX z_sessions_user_active ON z_sessions(tenant_id,user_id,created_at DESC)
  WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE TABLE z_session_refresh (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(token_hash) REFERENCES refresh_tokens(token_hash) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,session_id) REFERENCES z_sessions(tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX z_session_refresh_session ON z_session_refresh(tenant_id,session_id);
--> statement-breakpoint
-- These tables are deliberately reached by the privileged auth handle only.
-- No business route should be able to enumerate or mutate session material.
REVOKE ALL ON z_sessions,z_session_refresh FROM app_runtime;
