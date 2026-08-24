-- The firm's own MSMED registration, and a customer's written agreement.
--
-- **Why this is new.** `purchases.ts` already has everything to answer "does
-- the 15/45-day clock apply, and against whom" for a *vendor* the firm buys
-- from. The same clock runs the other way: if this firm is itself a
-- Udyam-registered micro or small enterprise, its own corporate customers
-- lose their income-tax deduction for the whole bill if they pay late — §15
-- MSMED Act for the payment obligation, §37(2)(g) Income-tax Act 2025 (the
-- successor to §43B(h), in force from 1 April 2026) for the consequence. That
-- only computes once the firm has said what it is registered as, which
-- nothing before this asked.
--
-- `has_written_agreement` on `customers` mirrors the column vendors already
-- have, for the same reason: §15 sets 45 days with a written agreement on
-- payment terms and 15 days without one, and the two cannot be told apart
-- without somebody saying which applies. Defaults to false — the shorter,
-- more urgent clock — because assuming an agreement exists when none does is
-- the wrong direction to be wrong in.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS msme_class "msme_class" NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS udyam_number text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS udyam_activity "udyam_activity";
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS udyam_verified_on date;
--> statement-breakpoint

ALTER TABLE customers ADD COLUMN IF NOT EXISTS has_written_agreement boolean NOT NULL DEFAULT false;
