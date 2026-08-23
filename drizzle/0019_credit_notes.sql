-- Credit notes — §34(1), and the only lawful way to reduce output tax.
--
-- **The problem this exists for.** When a corporate customer part-pays and asks
-- for "a new invoice" for the balance, the firm issues one. That is a second
-- declaration that a second supply happened: the same work taxed twice, roughly
-- 50% more GST than owed on every invoice it happens to. The balance is a
-- receivable, not a supply, and the only instrument that lawfully reduces the
-- tax already declared is a credit note.
--
-- **Its own table, not a flag on `invoices`.** A discriminator column would put
-- credit notes inside every existing sum — receivables, customer outstanding,
-- the owner snapshot, the ageing buckets — and each of those would be silently
-- wrong until somebody noticed. A separate table means every place that has to
-- account for a credit note must say so, which is the blast radius made visible
-- instead of hidden.
--
-- **Its own series.** §34 documents are numbered separately from invoices;
-- sharing a series would put two document types under one consecutive run and
-- break the thing Rule 46(b) asks for.
--
-- ⚠️ Nothing here is tax advice. The CA signs off before this becomes filing
-- behaviour — in particular the §34(2) deadline and the IMS interaction below.
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'credit_note';
--> statement-breakpoint

/*
  Whether the customer has accepted it — and why that decides everything.

  From October 2025, Rule 67B read with the Invoice Management System: a
  supplier may reduce liability against a credit note ONLY once the recipient
  accepts it. Rejected or ignored, the liability is added back in the following
  month's GSTR-3B.

  So a credit note is no longer a decision the supplier makes alone. It is a
  request, and an unactioned one silently reverses. Any screen that shows
  "credit note issued → tax recovered" without tracking this is lying to its
  reader, which is why the state is on the row rather than assumed.
*/
CREATE TYPE credit_note_ims AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),

  /*
    Null until issued, exactly as an invoice is.

    Numbering at draft leaves a permanent hole in the series when a draft is
    abandoned, and two drafts raised in one order and issued in another give
    dates that run backwards against their numbers. The number is drawn when
    the document becomes real.
  */
  number text,
  financial_year integer NOT NULL,

  -- The invoice this reduces. A credit note that names no invoice cannot be
  -- reported in GSTR-1's CDNR table, which is where it has to appear.
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  site_id uuid REFERENCES sites(id),

  /* Frozen at issue, like the invoice's — the address it was sent to. */
  bill_to jsonb,
  issue_date date NOT NULL,

  /*
    Why, in words, and required.

    §34 permits a credit note for specific causes — a deficiency in supply, tax
    charged in excess, goods returned. "The customer did not pay" is NOT one of
    them, and the difference decides whether the note survives scrutiny. Asking
    for the reason is how the person raising it is made to think about which
    one applies.
  */
  reason text NOT NULL,

  head tax_head NOT NULL,
  explanation text NOT NULL,
  taxable_paise bigint NOT NULL,
  total_tax_paise bigint NOT NULL,
  round_off_paise bigint NOT NULL DEFAULT 0,
  grand_total_paise bigint NOT NULL,

  status invoice_status NOT NULL DEFAULT 'DRAFT',

  ims_state credit_note_ims NOT NULL DEFAULT 'PENDING',
  /* When somebody last checked the portal. Null means nobody has. */
  ims_checked_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One consecutive series per branch per year, the same rule invoices follow.
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_uq
  ON credit_notes (tenant_id, number) WHERE number IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx ON credit_notes (invoice_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  credit_note_id uuid NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  description text NOT NULL,
  code text NOT NULL,
  kind text NOT NULL DEFAULT 'service',
  qty numeric(12, 3) NOT NULL DEFAULT 1,
  rate_paise bigint NOT NULL,
  rate_percent integer NOT NULL DEFAULT 18,
  taxable_paise bigint NOT NULL,
  tax_paise bigint NOT NULL
);
--> statement-breakpoint

-- RLS: the same discovery loop as 0010, re-run so the two new tables are
-- covered. Found rather than listed.
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
