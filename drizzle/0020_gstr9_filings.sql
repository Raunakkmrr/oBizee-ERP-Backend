-- When the annual return was filed, per year.
--
-- **Why this has to be recorded rather than assumed.** §34(2) shuts the
-- credit-note window on 30 November following the financial year *or the date
-- the annual return was filed, whichever is earlier*. GSTR-9 is optional below
-- ₹2 crore turnover and mandatory above it — so for a firm above the line whose
-- CA files in September, the window shuts in September, two months before the
-- statute's outside date.
--
-- A hardcoded 30 November is therefore wrong for exactly the firms this matters
-- to, and being well-organised is what costs them. Nobody can infer the date;
-- somebody has to say it.
--
-- One row per financial year. Absent means nobody has told us — which is not
-- the same as "not filed", and the screens say which.
CREATE TABLE IF NOT EXISTS gstr9_filings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  /* 2026 means the 2026-27 year. */
  financial_year integer NOT NULL,
  filed_on date NOT NULL,
  recorded_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE gstr9_filings
  ADD CONSTRAINT gstr9_filings_year_uq UNIQUE (tenant_id, financial_year);
--> statement-breakpoint

-- RLS: the same discovery loop as 0010, re-run for the new table.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
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
