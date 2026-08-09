import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Every closed list, as a Postgres enum.
 *
 * These are not `text` with a check constraint because the web app already
 * treats each of them as a discriminated union — `Coverage`, `TaxHead`,
 * `MsmeClass`. A string column would let the API accept a value no screen can
 * render, and the failure would surface as a blank badge months later.
 *
 * Adding a value to a pg enum is a migration. That is the point: these lists
 * change the law the application applies, so changing one should be deliberate.
 */

export const roleEnum = pgEnum("role", [
  "owner",
  "coordinator",
  "marketing",
  "technician",
  "accountant",
  "readonly_ca",
]);

export const customerTypeEnum = pgEnum("customer_type", ["INDIVIDUAL", "BUSINESS"]);

export const leadStageEnum = pgEnum("lead_stage", [
  "NEW",
  "CONTACTED",
  "QUOTED",
  "WON",
  "LOST",
]);

export const coverageEnum = pgEnum("coverage", [
  "COMPREHENSIVE",
  "NON_COMPREHENSIVE",
  "LABOUR_ONLY",
]);

export const billingFrequencyEnum = pgEnum("billing_frequency", [
  "UPFRONT_ANNUAL",
  "HALF_YEARLY",
  "QUARTERLY",
  "MONTHLY",
  "PER_VISIT",
]);

export const recurrenceEnum = pgEnum("recurrence", [
  "WEEKLY",
  "FORTNIGHTLY",
  "MONTHLY",
  "ALTERNATE_MONTHLY",
  "QUARTERLY",
  "HALF_YEARLY",
  "ANNUAL",
]);

export const reschedulePolicyEnum = pgEnum("reschedule_policy", [
  "SHIFT_SUBSEQUENT",
  "KEEP_SCHEDULE",
]);

export const contractStatusEnum = pgEnum("contract_status", [
  "DRAFT",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "CREATED",
  "ASSIGNED",
  "EN_ROUTE",
  "ON_SITE",
  "PARTS_AWAITED",
  "CUSTOMER_UNAVAILABLE",
  "WORK_DONE",
  "SIGNED_OFF",
  "CANCELLED",
]);

export const priorityEnum = pgEnum("priority", ["normal", "urgent", "breakdown"]);

/** FR-802. The whole reason a site carries a state code. */
export const taxHeadEnum = pgEnum("tax_head", ["CGST_SGST", "IGST"]);

export const lineKindEnum = pgEnum("line_kind", ["service", "goods"]);

export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "ISSUED", "CANCELLED"]);

export const advanceStatusEnum = pgEnum("advance_status", ["OPEN", "ADJUSTED"]);

export const msmeClassEnum = pgEnum("msme_class", [
  "MICRO",
  "SMALL",
  "MEDIUM",
  "NOT_REGISTERED",
  "UNVERIFIED",
]);

export const udyamActivityEnum = pgEnum("udyam_activity", [
  "MANUFACTURING",
  "SERVICE",
  "TRADING",
]);

/** §194C charges 1% to an individual or HUF and 2% to everyone else. */
export const panTypeEnum = pgEnum("pan_type", ["INDIVIDUAL_HUF", "COMPANY_FIRM_OTHER"]);

export const tdsSectionEnum = pgEnum("tds_section", ["194C", "194J", "NONE"]);

export const purchaseStatusEnum = pgEnum("purchase_status", ["UNPAID", "PAID"]);

/** FR-811: each document type gets its own counter per branch per financial year. */
export const docTypeEnum = pgEnum("doc_type", ["job", "invoice", "receipt_voucher"]);

/** FR-1305: an entry written by the technician app carries where it happened. */
export const auditOriginEnum = pgEnum("audit_origin", ["web", "offline_sync"]);

export const assetConditionEnum = pgEnum("asset_condition", [
  "GOOD",
  "NEEDS_ATTENTION",
  "CRITICAL",
]);

/*
  The roles a site contact actually has, in the words the screen uses.

  `MANAGER` and a bare `ACCOUNTS` were the first guess; the customer screen's
  own list is `SITE_INCHARGE` and `TENANT`, which are the two that matter on an
  Indian service call — the person who lets you in, and the person who is not
  the owner. The database is the one that was wrong.
*/
export const contactRoleEnum = pgEnum("contact_role", [
  "OWNER",
  "SITE_INCHARGE",
  "TENANT",
  "SECURITY",
  "ACCOUNTS",
  "OTHER",
]);

/** Where stock sits. A van belongs to a technician; a store belongs to a branch. */
export const stockLocationKindEnum = pgEnum("stock_location_kind", ["STORE", "VAN"]);

/**
 * Why stock moved — FR-601 to FR-604.
 *
 * Every movement has a reason, because "the count changed" is not an answer
 * anybody can act on. `ADJUSTMENT` is the one that admits the count was wrong,
 * and it is deliberately its own kind rather than a silent correction: a stock
 * take that quietly rewrites a balance hides the shrinkage it exists to find.
 */
export const stockMovementKindEnum = pgEnum("stock_movement_kind", [
  "RECEIPT",
  "ISSUE_TO_VAN",
  "RETURN_TO_STORE",
  "CONSUME",
  "ADJUSTMENT",
]);
