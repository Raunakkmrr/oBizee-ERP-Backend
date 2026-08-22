-- Telling people about work before it happens.
--
-- **The gap this fills.** A contract knows a visit is due on the 24th. Nothing
-- acted on that: the contracts screen showed "1 of 3 visits due in the next 90
-- days are not on the board yet — Put 1 on the board", and waited to be
-- clicked. Every WhatsApp in the product is a `wa.me/` link a person presses,
-- and there is no email sending at all. So three separate things depended on
-- somebody remembering, and in this business a forgotten visit is not a missed
-- task — it is a missed invoice.
--
-- **Why an outbox and not a send call.** A reminder is a side effect on the
-- outside world: it cannot be rolled back, and sending it twice is worse than
-- sending it late. Writing the intention down first, then draining it, makes
-- the send idempotent, retryable and — the part that matters when a customer
-- says "nobody told us" — auditable, with the exact text and timestamp.
CREATE TYPE reminder_kind AS ENUM (
  'visit_in_7_days',
  'visit_tomorrow',
  -- The office does not get one of these per job. Twenty-five a day to the same
  -- five people is a folder rule inside a week, and a system nobody reads is
  -- worse than no system because it is still trusted.
  'daily_digest'
);
--> statement-breakpoint

CREATE TYPE reminder_channel AS ENUM ('whatsapp', 'email');
--> statement-breakpoint

-- Who is being told, because the same visit means different things to each and
-- the message differs. A customer is told to expect somebody; a technician is
-- told where to be; the office is told what is unassigned.
CREATE TYPE reminder_audience AS ENUM ('customer', 'technician', 'office');
--> statement-breakpoint

CREATE TYPE reminder_state AS ENUM ('pending', 'sent', 'failed', 'skipped');
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),

  -- Null for a digest, which is about a day rather than about one job.
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,

  kind reminder_kind NOT NULL,
  channel reminder_channel NOT NULL,
  audience reminder_audience NOT NULL,

  /*
    The address as it was resolved when the reminder was raised, not a join to
    wherever it lives now. A contact who changes their number after we wrote to
    the old one should leave a record of the old one — that is the whole point
    of keeping evidence of what was sent.
  */
  recipient text NOT NULL,
  -- Set when the recipient is one of ours, so the board can say who was told.
  recipient_user_id uuid REFERENCES users(id),

  template_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,

  state reminder_state NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,

  /*
    When it should go, not when it was raised.

    Reminders are enqueued by a run that may happen at any hour, and nobody
    wants a WhatsApp at 03:00. The sender honours this, so the quiet-hours rule
    lives in data rather than in whoever calls the sender.
  */
  scheduled_for timestamptz NOT NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  /*
    The idempotency key, spelled out rather than inferred.

    A composite unique over (job_id, kind, channel, recipient) looks equivalent
    and is not: `job_id` is null for digests, and Postgres treats nulls as
    distinct, so every digest would insert cleanly and the office would be
    messaged once per run. An explicit key covers both shapes with one rule.

    Format: `job:<uuid>:visit_tomorrow:whatsapp:<recipient>`
            `digest:2026-08-23:email:<recipient>`
  */
  dedupe_key text NOT NULL
);
--> statement-breakpoint

-- The whole idempotency story, in one constraint. A scheduler that double
-- fires, a Lambda that retries, a person re-running the job by hand — none of
-- them can message a customer twice, because the second insert loses.
ALTER TABLE reminders
  ADD CONSTRAINT reminders_dedupe_uq UNIQUE (tenant_id, dedupe_key);
--> statement-breakpoint

-- A digest has no job; everything else must have one. Stated as a constraint
-- because "we only ever insert it correctly" is not a property, it is a hope.
ALTER TABLE reminders
  ADD CONSTRAINT reminders_job_required_unless_digest
  CHECK ((kind = 'daily_digest') = (job_id IS NULL));
--> statement-breakpoint

-- What the drain reads: the due, unsent ones, oldest first.
CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (tenant_id, state, scheduled_for)
  WHERE state = 'pending';
--> statement-breakpoint

-- What the job screen reads: has this customer been told?
CREATE INDEX IF NOT EXISTS reminders_job_idx ON reminders (job_id);
--> statement-breakpoint

/*
  Consent, on the contact rather than on the reminder.

  Business-initiated WhatsApp requires opt-in, and an opt-out has to be
  honoured by every future send rather than remembered by whoever writes the
  next feature. Default true for the phone the customer gave us to be rung on —
  and explicitly recorded, so withdrawing it is a fact and not an absence.
*/
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reminders_opted_out boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- RLS: the same discovery loop as `0010_rls.sql`, re-run so the new table is
-- covered. Found rather than listed, because a list is a thing somebody forgets
-- to add the twenty-ninth table to.
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
