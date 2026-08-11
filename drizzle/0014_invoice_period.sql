-- Which period a contract invoice covers.
--
-- An invoice could already name its contract (`contract_id`) but never which
-- slice of it, so nothing could answer "has August been billed yet" without
-- guessing from dates on linked jobs. That guess is exactly what a billing
-- system must not do: bill the same month twice and the customer notices;
-- bill it never and the firm does not.
--
-- Nullable because most invoices are not contract invoices. An ad-hoc repair
-- covers a visit, not a period, and inventing a one-day period for it would
-- make "which periods are billed" a question with a meaningless answer.
--
-- FR-505 is the reason these are separate from the visit schedule: a contract
-- may bill quarterly while visiting monthly, so a period holds however many
-- visits it holds.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_start date;
--> statement-breakpoint
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_end date;
--> statement-breakpoint

-- Both or neither. A period with one end is not a period, and a half-filled
-- pair would silently widen every "is this billed" check into a false negative.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_period_both_or_neither
  CHECK ((period_start IS NULL) = (period_end IS NULL));
--> statement-breakpoint

ALTER TABLE invoices
  ADD CONSTRAINT invoices_period_ordered
  CHECK (period_end IS NULL OR period_end >= period_start);
--> statement-breakpoint

-- **One live invoice per contract period.**
--
-- This is the guarantee, and it is enforced here rather than in a handler
-- because two coordinators clicking the same "Ready to bill" row half a second
-- apart is a race no amount of checking-then-inserting wins.
--
-- Cancelled invoices are excluded: cancelling August's bill has to leave August
-- billable again, or a mistake would lock the month out for ever.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_contract_period_uq
  ON invoices (tenant_id, contract_id, period_start)
  WHERE contract_id IS NOT NULL
    AND period_start IS NOT NULL
    AND status <> 'CANCELLED';
