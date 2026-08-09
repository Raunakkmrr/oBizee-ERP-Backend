-- Row-level security: the database refuses, so a handler cannot forget.
--
-- Until now one firm's records were kept from another by every route
-- remembering `where tenant_id = ...`. The authorization matrix showed they all
-- did, and a live test proves it still holds — but that is detection, and the
-- bug it detects is one missing clause in a query somebody writes next month.
--
-- Two things make the policies real rather than decorative. The tenant arrives
-- as a setting each statement carries (see db/client.ts for why it cannot be a
-- session variable), and the request path connects as a role that is not
-- allowed to bypass policies. Neon's default owner carries BYPASSRLS; policies
-- written against it would never once be consulted.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  -- `nullif` so an absent setting reads as NULL rather than failing the cast:
  -- every policy then compares against NULL, which is false, and the answer is
  -- no rows. Fail-closed. If the plumbing in db/client.ts ever breaks, the app
  -- stops working loudly instead of quietly serving everything to everyone.
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint

-- Created without a password, and without the right to log in. The password is
-- set once by scripts/create-app-role.ts and lives only in the environment, so
-- that a credential is never a thing this repository contains.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;
--> statement-breakpoint

-- Three tables the request path has no business reading. Sign-in codes and
-- attempt budgets are counted before anyone is authenticated, so they are
-- reached through the privileged handle; leaving them readable would mean a
-- flaw in any route could hand out a colleague's one-time code.
REVOKE ALL ON public.otp_challenges, public.rate_limits, public._applied_migrations
  FROM app_runtime;
--> statement-breakpoint

-- Every table that carries a tenant, found rather than listed. A list is a
-- thing somebody forgets to add the twenty-ninth table to.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I
         USING (tenant_id = app_current_tenant())
         WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- The firm's own record: same rule, different column.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.tenants;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());
--> statement-breakpoint

-- Helpers on a job carry no tenant of their own; they inherit the job's. The
-- subquery is itself filtered by the policy on `jobs`, so naming the tenant
-- again here would only be a second place to get it wrong.
ALTER TABLE public.job_helpers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON public.job_helpers;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.job_helpers
  USING (EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_helpers.job_id))
  WITH CHECK (EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = job_helpers.job_id));
