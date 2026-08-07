-- Guards the table definitions cannot express.
--
-- Each of these was a convention in the frontend store: a comment saying "there
-- is no update path, by design", or a `Set` in a reducer. A convention holds
-- until somebody in a hurry writes the update. These make the database refuse.

--> statement-breakpoint

-- FR-804 — a rate is a fact about a period, not a setting.
--
-- An invoice raised before the 2025 rationalisation was correct at 28% and must
-- stay correct at 28%. Editing a row silently re-prices history: reprints stop
-- agreeing with what the customer paid, and the GSTR-1 working paper stops
-- reconciling. A change inserts a new dated row instead.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'This table is insert-only: % on % is not permitted. Insert a superseding row instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

CREATE TRIGGER rate_rows_insert_only
  BEFORE UPDATE OR DELETE ON rate_rows
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

--> statement-breakpoint

-- FR-1305 — the trail's only value is that it cannot be tidied.
--
-- Retained eight years. A control to clear it would make every entry above it
-- worthless, so there is no such control and now no such path.
CREATE TRIGGER audit_entries_insert_only
  BEFORE UPDATE OR DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

--> statement-breakpoint

-- FR-811 — take the next number atomically.
--
-- The browser held one integer per series and `series.ts` said outright that a
-- shared statutory sequence needs the backend. UPDATE ... RETURNING is atomic:
-- two people billing at the same moment cannot both take 0150.
--
-- Rows are created on demand, so a branch's first invoice of a new financial
-- year starts at 1 without anyone seeding a counter.
CREATE OR REPLACE FUNCTION next_in_series(
  p_tenant uuid,
  p_branch uuid,
  p_doc_type doc_type,
  p_financial_year integer
) RETURNS integer AS $$
DECLARE
  v_next integer;
BEGIN
  INSERT INTO series_counters (tenant_id, branch_id, doc_type, financial_year, last_issued)
  VALUES (p_tenant, p_branch, p_doc_type, p_financial_year, 1)
  ON CONFLICT (branch_id, doc_type, financial_year)
  DO UPDATE SET last_issued = series_counters.last_issued + 1
  RETURNING last_issued INTO v_next;

  RETURN v_next;
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint

-- FR-812 — every invoice foots exactly, checked by the database.
--
-- taxable + tax + round-off = grand total, and the grand total is whole rupees.
-- Property-tested over 100,000 generated invoices in the web app; asserted here
-- so a future write path cannot quietly break it.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_foots_exactly
  CHECK (taxable_paise + total_tax_paise + round_off_paise = grand_total_paise);

--> statement-breakpoint

ALTER TABLE invoices
  ADD CONSTRAINT invoices_whole_rupees
  CHECK (grand_total_paise % 100 = 0);

--> statement-breakpoint

-- FR-812's rounding is capped at half a rupee either way.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_round_off_bounded
  CHECK (round_off_paise BETWEEN -50 AND 50);

--> statement-breakpoint

-- A user must be reachable by at least one of the two sign-in routes: field
-- staff by phone and OTP, office staff by email and password.
ALTER TABLE users
  ADD CONSTRAINT users_reachable
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

--> statement-breakpoint

-- FR-501 — the anchor is a date of the month.
ALTER TABLE contract_schedules
  ADD CONSTRAINT contract_schedules_anchor_day
  CHECK (anchor_day BETWEEN 1 AND 31);

--> statement-breakpoint

-- FR-1202 — a rating is 1 to 5 or absent, never 0.
ALTER TABLE sign_offs
  ADD CONSTRAINT sign_offs_rating_range
  CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);
