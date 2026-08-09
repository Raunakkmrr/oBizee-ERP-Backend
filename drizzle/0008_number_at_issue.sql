-- The invoice number is allocated at issue, not when the draft is created.
--
-- Rule 46(b) asks for one consecutive series per financial year. Allocating at
-- draft meant an abandoned draft left a permanent hole in it, and two drafts
-- raised in one order but issued in another produced a series whose dates ran
-- backwards against its numbers — the question nobody wants at an assessment.
--
-- Postgres treats NULLs as distinct in a unique index, so `invoices_series_uq`
-- keeps working: any number of unnumbered drafts, and still no two issued
-- invoices sharing a number.

ALTER TABLE "invoices" ALTER COLUMN "number" DROP NOT NULL;

--> statement-breakpoint

/*
  Hand back the numbers existing drafts are holding.

  They were allocated at create under the old rule and belong to documents that
  were never issued. Releasing them is the whole point of the change: a draft
  should not be sitting on a number it may never use. The counter is not wound
  back — those sequence values stay spent, and the numbering screen reports
  them as gaps, which is the truth.
*/
UPDATE "invoices" SET "number" = NULL WHERE "status" = 'DRAFT';

--> statement-breakpoint

/*
  An issued invoice has a number; a draft does not.

  Enforced at the table because it is the one rule that makes the column
  nullable safe. A document that is ISSUED without a number is not an invoice
  anybody could refer to, and a DRAFT holding one has already burnt a number it
  may never use.

  CANCELLED keeps whatever it had: the number is consumed, and reusing it would
  put two documents in the series under one number.
*/
ALTER TABLE "invoices"
  ADD CONSTRAINT invoices_numbered_when_issued
  CHECK (
    (status = 'DRAFT'  AND number IS NULL)
    OR (status IN ('ISSUED', 'CANCELLED') AND number IS NOT NULL)
  );
