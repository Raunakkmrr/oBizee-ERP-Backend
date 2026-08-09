-- A stored phone number is digits, or it is not a phone number.
--
-- FR-102's duplicate check matches on `phone_e164` exactly, and `e164()`
-- normalises to bare digits — `919810011223`, no plus, no spaces. Three write
-- paths did not go through it: the day fixture wrote a literal with a `+`,
-- the customer route fell back to the raw input when normalisation failed, and
-- the contract conversion never normalised at all.
--
-- The effect is quiet and bad. A row stored in any other shape can never match
-- a lookup, so the coordinator is told a returning customer is new — which is
-- the exact data-quality failure FR-102 exists to prevent, and it presents as
-- the feature simply not firing rather than as an error anybody would report.
--
-- Enforced here rather than in the three call sites, because there will be a
-- fourth. A handler can forget; a constraint cannot.

-- Normalise what is already stored, by the same rules as `lib/phone.ts`.
-- Written inline rather than as a persisted function: the transformation lives
-- in one place in TypeScript, and what the database owns is the *shape*.
UPDATE contacts SET phone_e164 = CASE
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^91[0-9]{10}$'
    THEN regexp_replace(phone_e164, '\D', '', 'g')
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^0[0-9]{10}$'
    THEN '91' || substr(regexp_replace(phone_e164, '\D', '', 'g'), 2)
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^[0-9]{10}$'
    THEN '91' || regexp_replace(phone_e164, '\D', '', 'g')
  ELSE phone_e164
END
WHERE phone_e164 !~ '^[0-9]{10,15}$';
--> statement-breakpoint

UPDATE contacts SET whatsapp_e164 = regexp_replace(whatsapp_e164, '\D', '', 'g')
WHERE whatsapp_e164 IS NOT NULL AND whatsapp_e164 !~ '^[0-9]{10,15}$';
--> statement-breakpoint

UPDATE leads SET phone_e164 = CASE
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^91[0-9]{10}$'
    THEN regexp_replace(phone_e164, '\D', '', 'g')
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^0[0-9]{10}$'
    THEN '91' || substr(regexp_replace(phone_e164, '\D', '', 'g'), 2)
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^[0-9]{10}$'
    THEN '91' || regexp_replace(phone_e164, '\D', '', 'g')
  ELSE phone_e164
END
WHERE phone_e164 IS NOT NULL AND phone_e164 !~ '^[0-9]{10,15}$';
--> statement-breakpoint

UPDATE users SET phone_e164 = CASE
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^91[0-9]{10}$'
    THEN regexp_replace(phone_e164, '\D', '', 'g')
  WHEN regexp_replace(phone_e164, '\D', '', 'g') ~ '^[0-9]{10}$'
    THEN '91' || regexp_replace(phone_e164, '\D', '', 'g')
  ELSE phone_e164
END
WHERE phone_e164 IS NOT NULL AND phone_e164 !~ '^[0-9]{10,15}$';
--> statement-breakpoint

-- These fail loudly if anything above could not be normalised, which is the
-- intended behaviour: a migration that silently discarded an unmatchable phone
-- number would be hiding the same defect one layer down.
ALTER TABLE contacts ADD CONSTRAINT contacts_phone_is_digits
  CHECK (phone_e164 ~ '^[0-9]{10,15}$');
--> statement-breakpoint
ALTER TABLE contacts ADD CONSTRAINT contacts_whatsapp_is_digits
  CHECK (whatsapp_e164 IS NULL OR whatsapp_e164 ~ '^[0-9]{10,15}$');
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT leads_phone_is_digits
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[0-9]{10,15}$');
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_phone_is_digits
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^[0-9]{10,15}$');
