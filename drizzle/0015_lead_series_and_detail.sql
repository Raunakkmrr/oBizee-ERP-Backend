-- Two defects in one place: how a lead is numbered, and what it is allowed to
-- remember.
--
-- **The numbering.** `POST /api/leads` built its reference by counting rows and
-- adding one, against a `unique (tenant_id, reference)` constraint:
--
--     const sequence = Number(counted?.value ?? 0) + 1;
--     const reference = `L-${yy}${mm}-${pad(sequence)}`;
--
-- Four leads therefore always produce `L-2608-0005`. Once that reference exists
-- — a lead created and later removed, a gap in the seed, two people saving at
-- once — every subsequent creation collides and answers 409, permanently. It is
-- not flaky; it can never succeed again until the collision is cleared by hand.
--
-- Jobs and invoices already number themselves through `next_in_series`, a
-- counter table with a row lock. Leads get the same treatment rather than a
-- second, worse mechanism.
ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'lead';
--> statement-breakpoint

-- **What a lead may remember.**
--
-- The capture form asks for the service, the PIN code, the city, the state, a
-- landmark and a note — "what they actually said" — and the table had nowhere
-- to put any of them, so `createLead` sent five fields and dropped the rest on
-- the floor. A lead worked over three or four calls is *made of* those details;
-- discarding them is why the address had to be asked for again at conversion,
-- and why nobody could see what the customer had actually asked for.
--
-- All nullable. A lead is deliberately cheap to capture (FR-101 gives it thirty
-- seconds), and most of this arrives over the calls that follow, not on the
-- first one.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS service_type text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS note text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS pincode text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS city text;
--> statement-breakpoint

-- Two digits, and the reason it matters: this is the field that decides
-- CGST+SGST or IGST on every invoice the resulting customer is ever sent
-- (FR-802). Carried from the lead so conversion can offer it rather than ask
-- again and risk a different answer.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS state_code text;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS landmark text;
--> statement-breakpoint

ALTER TABLE leads
  ADD CONSTRAINT leads_state_code_shape
  CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');
