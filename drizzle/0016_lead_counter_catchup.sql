-- Start the lead counter above the leads that already exist.
--
-- `0015` moved lead numbering onto `next_in_series`, which is correct — but a
-- brand-new counter starts at zero and hands out `L-yymm-0001`, which the
-- seeded leads already hold. The unique constraint then refuses every new lead:
-- the same 409 the change was made to remove, arriving by a different route.
--
-- So the counter is caught up to the highest sequence any existing reference
-- carries, per branch and financial year.
--
-- **The maximum, not the count.** Counting is the bug being fixed — four leads
-- numbered 1, 2, 6 and 7 have a count of 4 and a maximum of 7, and only the
-- maximum is guaranteed not to collide with what is already there.
--
-- Idempotent: re-running takes the greater of what is recorded and what the
-- references show, so it can never wind a live counter backwards.
WITH parsed AS (
  SELECT
    l.tenant_id,
    -- `L-2608-0007` → year `26` at 3, month `08` at 5, sequence `0007` from 8.
    2000 + substring(l.reference FROM 3 FOR 2)::int AS calendar_year,
    substring(l.reference FROM 5 FOR 2)::int        AS month,
    substring(l.reference FROM 8)::int              AS sequence
  FROM leads l
  -- Only references in the shape this counter issues. The day-fixture writes
  -- `L-DAY-01`, which is not ours to reason about and must not move anything.
  WHERE l.reference ~ '^L-[0-9]{4}-[0-9]+$'
),
highest AS (
  SELECT
    p.tenant_id,
    -- April to March, so January belongs to the year that began last April.
    CASE WHEN p.month >= 4 THEN p.calendar_year ELSE p.calendar_year - 1 END AS financial_year,
    MAX(p.sequence) AS last_issued
  FROM parsed p
  GROUP BY p.tenant_id,
    CASE WHEN p.month >= 4 THEN p.calendar_year ELSE p.calendar_year - 1 END
)
INSERT INTO series_counters (tenant_id, branch_id, doc_type, financial_year, last_issued)
SELECT h.tenant_id, b.id, 'lead'::doc_type, h.financial_year, h.last_issued
FROM highest h
JOIN LATERAL (
  SELECT id FROM branches WHERE branches.tenant_id = h.tenant_id ORDER BY id LIMIT 1
) b ON true
ON CONFLICT (branch_id, doc_type, financial_year)
DO UPDATE SET last_issued = GREATEST(series_counters.last_issued, EXCLUDED.last_issued);
