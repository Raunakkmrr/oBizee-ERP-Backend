-- An email address for a site contact.
--
-- The reminder planner offers two channels to a customer and could only ever
-- use one: `contacts` carried a phone and no address, so every customer email
-- was planned as impossible and silently skipped. Choosing an email provider
-- and having nowhere to read an email from is the kind of gap that survives a
-- design review and fails on the first real send.
--
-- Nullable, deliberately. Most Indian household customers have no email worth
-- writing to and WhatsApp is the channel that reaches them; requiring one would
-- block the contact record that the job card actually needs.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email text;
--> statement-breakpoint

-- Shape checked at the table, because an address that cannot be sent to is
-- worse than none: it reports a reminder as planned and fails at the provider,
-- one bounce at a time, in a log nobody reads.
ALTER TABLE contacts
  ADD CONSTRAINT contacts_email_shape
  CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
