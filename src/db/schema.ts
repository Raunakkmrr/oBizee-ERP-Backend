import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import * as e from "./enums.ts";

/**
 * Re-exported so drizzle-kit sees them.
 *
 * It introspects only what the schema entry file exports. Importing the enums
 * with `import * as e` used them in column definitions but left them invisible
 * to generation, so the first migration created tables referencing types it had
 * never created — `type "tax_head" does not exist`, on statement 1 of 98.
 */
export * from "./enums.ts";

/**
 * oBizee Service ERP — the schema.
 *
 * Ported from `obez-erp-web/src/lib/data/*`, which was written frontend-first
 * and became a de-facto specification. Three deliberate departures from what
 * the store does today, each recorded in `obez-erp-docs/ERD.md`:
 *
 * 1. **Name-joins become foreign keys.** `Contract.customer` was the string
 *    "Shakti Industries". Renaming a customer orphaned their history, two
 *    customers sharing a trading name merged, and the place-of-supply lookup
 *    fell back to `sites[0]` — which could bill a two-site customer against the
 *    wrong state, and therefore charge the wrong GST head.
 * 2. **Counters become real sequences.** The browser held one integer per
 *    series. Two people billing at once would both take SVC/26-27/0150, and
 *    §31 requires a consecutive series.
 * 3. **Constraints move out of the application.** Insert-only rate rows, a
 *    unique invoice number per branch and year, one adjustment per advance —
 *    all were conventions a hurried change could break.
 *
 * Two things that look like the same mistake and are deliberate: `invoices.
 * bill_to` and `purchase_bills.vendor_name` are **snapshots**. A tax document
 * keeps what was printed on it, so correcting a GSTIN next year must not
 * rewrite an invoice already filed.
 *
 * **Money is `bigint` paise, never a float.** `integer` tops out around ₹21
 * crore, which an annual contract total can pass.
 */

const money = (name: string) => bigint(name, { mode: "number" });

/* ------------------------------------------------------------ tenancy */

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessName: text("business_name").notNull(),
  legalName: text("legal_name").notNull(),
  aatoPaise: money("aato_paise").notNull().default(0),
  taxScheme: text("tax_scheme").notNull().default("REGULAR"),
  regionalLanguage: text("regional_language"),
  /** FR-1301's per-tenant overrides — technician price visibility and friends. */
  toggles: jsonb("toggles").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const branches = pgTable(
  "branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** FR-1303: each branch files under its own GSTIN. */
    gstin: text("gstin"),
    stateCode: text("state_code").notNull(),
    jobSeriesPrefix: text("job_series_prefix").notNull().default("J"),
    invoiceSeriesPrefix: text("invoice_series_prefix").notNull().default("SVC"),
  },
  (t) => [index("branches_tenant_idx").on(t.tenantId)],
);

/* ------------------------------------------------------------- people */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    branchId: uuid("branch_id").references(() => branches.id),
    name: text("name").notNull(),
    /**
     * Field staff sign in with a phone and an OTP; office staff with an email
     * and a password. One identity, two ways to prove it — so both are
     * nullable and at least one must be present.
     */
    phoneE164: text("phone_e164"),
    email: text("email"),
    passwordHash: text("password_hash"),
    role: e.roleEnum("role").notNull(),
    /** FR-1301: a level grants extra permissions within a role. */
    level: text("level"),
    languageOverride: text("language_override"),
    skills: jsonb("skills").notNull().default([]),
    localities: jsonb("localities").notNull().default([]),
    /**
     * Left, not deleted. A technician who quits still owns the history of every
     * job he closed, so the record stays and stops being assignable.
     */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("users_tenant_phone_uq").on(t.tenantId, t.phoneE164),
    unique("users_tenant_email_uq").on(t.tenantId, t.email),
    index("users_tenant_idx").on(t.tenantId),
  ],
);

/* ---------------------------------------------------------- customers */

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    customerType: e.customerTypeEnum("customer_type").notNull(),
    /** Null for a household customer — the common case (§7.4). */
    gstin: text("gstin"),
    billingStateCode: text("billing_state_code").notNull(),
    creditDays: integer("credit_days").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customers_tenant_idx").on(t.tenantId)],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    addressLine1: text("address_line1").notNull(),
    locality: text("locality").notNull(),
    city: text("city").notNull(),
    /** FR-802. This column decides CGST+SGST versus IGST on every invoice. */
    stateCode: text("state_code").notNull(),
    pincode: text("pincode").notNull(),
    /** Its own column, never concatenated — how an Indian address resolves. */
    landmark: text("landmark"),
    accessNotes: text("access_notes"),
    /** Optional pin. The landmark is what actually gets a technician there. */
    lat: text("lat"),
    lng: text("lng"),
  },
  (t) => [index("sites_customer_idx").on(t.customerId)],
);

export const contacts = pgTable("contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phoneE164: text("phone_e164").notNull(),
  /** Stored separately because it differs often enough to matter (§7.6). */
  whatsappE164: text("whatsapp_e164"),
  roleLabel: e.contactRoleEnum("role_label").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
});

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  assetType: text("asset_type").notNull(),
  make: text("make").notNull(),
  model: text("model").notNull(),
  serialNumber: text("serial_number"),
  locationInSite: text("location_in_site"),
  condition: e.assetConditionEnum("condition").notNull().default("GOOD"),
  warrantyExpiry: date("warranty_expiry"),
  repeatFailure: boolean("repeat_failure").notNull().default(false),
});

/* --------------------------------------------------------------- leads */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    reference: text("reference").notNull(),
    name: text("name").notNull(),
    phoneE164: text("phone_e164"),
    locality: text("locality"),
    stage: e.leadStageEnum("stage").notNull().default("NEW"),
    source: text("source").notNull(),
    /** FR-103: incentives are paid on who took it, and it is immutable. */
    takenByUserId: uuid("taken_by_user_id").references(() => users.id),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    quotedPaise: money("quoted_paise"),
    /** FR-104: a lead with no next date gets forgotten, so this is required. */
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    /** Set when the lead becomes a customer, so conversion is traceable. */
    convertedCustomerId: uuid("converted_customer_id").references(() => customers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("leads_tenant_reference_uq").on(t.tenantId, t.reference),
    index("leads_followup_idx").on(t.tenantId, t.nextFollowUpAt),
  ],
);

/**
 * Every follow-up that actually happened — FR-104, §6.6.3.
 *
 * The lead row carries the *next* date; this carries what was said last time.
 * §6.6.2 calls that "the highest-value element in the row", because without it
 * a coordinator opens the record before every call. The lead table alone could
 * not hold it: a lead has many follow-ups and only the latest is shown, so
 * flattening it onto `leads` would lose the history the incentive and
 * conversion reports read.
 *
 * `outcome` is the closed list from §6.6.3 rather than free text — free text
 * alone is useless for reporting. `note` carries the words.
 */
export const leadActivities = pgTable(
  "lead_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    outcome: text("outcome").notNull(),
    note: text("note"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_activities_lead_idx").on(t.tenantId, t.leadId, t.occurredAt)],
);

/* ----------------------------------------------------------- contracts */

export const contracts = pgTable(
  "contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    branchId: uuid("branch_id").references(() => branches.id),
    reference: text("reference").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    siteId: uuid("site_id").references(() => sites.id),
    fromLeadId: uuid("from_lead_id").references(() => leads.id),
    annualValuePaise: money("annual_value_paise").notNull(),
    coverage: e.coverageEnum("coverage").notNull(),
    /** FR-505: independent of the visit schedule, deliberately. */
    billing: e.billingFrequencyEnum("billing").notNull(),
    reschedulePolicy: e.reschedulePolicyEnum("reschedule_policy")
      .notNull()
      .default("SHIFT_SUBSEQUENT"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: e.contractStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("contracts_tenant_reference_uq").on(t.tenantId, t.reference),
    index("contracts_customer_idx").on(t.customerId),
  ],
);

export const contractSchedules = pgTable("contract_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  contractId: uuid("contract_id")
    .notNull()
    .references(() => contracts.id, { onDelete: "cascade" }),
  /** FR-1406: one contract, several cadences, each measurable. */
  scope: text("scope").notNull(),
  recurrence: e.recurrenceEnum("recurrence").notNull(),
  /** FR-501: 31 clamps to the month end rather than spilling into the next. */
  anchorDay: integer("anchor_day").notNull(),
  visitsCommitted: integer("visits_committed").notNull(),
});

/* ---------------------------------------------------------------- jobs */

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    branchId: uuid("branch_id").notNull().references(() => branches.id),
    jobNumber: text("job_number").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    siteId: uuid("site_id").notNull().references(() => sites.id),
    contractScheduleId: uuid("contract_schedule_id").references(() => contractSchedules.id),
    fromLeadId: uuid("from_lead_id").references(() => leads.id),
    /**
     * FR-502's idempotency key — `contract:schedule:n`. Unique per tenant, so
     * generating a contract's visits twice cannot double them. The `Set` in the
     * reducer becomes a constraint the database keeps.
     */
    visitKey: text("visit_key"),
    visitNumber: integer("visit_number"),
    visitOf: integer("visit_of"),
    serviceType: text("service_type").notNull(),
    /** FR-203: a date and a slot, never a false-precision timestamp. */
    scheduledDate: date("scheduled_date"),
    slot: text("slot"),
    status: e.jobStatusEnum("status").notNull().default("CREATED"),
    priority: e.priorityEnum("priority").notNull().default("normal"),
    /** FR-207: priority drives this, and it drives the SLA chip everywhere. */
    promisedBy: timestamp("promised_by", { withTimezone: true }),
    primaryTechnicianId: uuid("primary_technician_id").references(() => users.id),
    visitAttempt: integer("visit_attempt").notNull().default(1),
    /** Null until quoted or billed — never a fabricated zero. */
    valuePaise: money("value_paise"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("jobs_tenant_number_uq").on(t.tenantId, t.jobNumber),
    unique("jobs_tenant_visitkey_uq").on(t.tenantId, t.visitKey),
    index("jobs_scheduled_idx").on(t.tenantId, t.scheduledDate),
    index("jobs_status_idx").on(t.tenantId, t.status),
  ],
);

/** FR-205: one primary technician and any number of helpers at half weight. */
export const jobHelpers = pgTable(
  "job_helpers",
  {
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.userId] })],
);

export const jobParts = pgTable("job_parts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** FR-504: parts are taxed at their own HSN rate, not the service's. */
  code: text("code").notNull(),
  qty: integer("qty").notNull(),
  unit: text("unit").notNull().default("no"),
  ratePaise: money("rate_paise").notNull().default(0),
  ratePercent: integer("rate_percent").notNull().default(18),
});

export const jobEvents = pgTable(
  "job_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    /** When it happened on the ground, which is not when it synced. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    offline: boolean("offline").notNull().default(false),
    place: text("place"),
    /** FR-303: the technician app's idempotency key for replayed writes. */
    clientUuid: uuid("client_uuid"),
  },
  (t) => [unique("job_events_client_uuid_uq").on(t.tenantId, t.clientUuid)],
);

export const signOffs = pgTable("sign_offs", {
  jobId: uuid("job_id").primaryKey().references(() => jobs.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  signerName: text("signer_name").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
  /** FR-1202: 1 to 5, and always rendered as a word, never stars alone. */
  rating: integer("rating"),
  comment: text("comment"),
  signatureUploaded: boolean("signature_uploaded").notNull().default(false),
  /** FR-1205: a 1 or 2 reaches a person within sixty seconds. */
  acknowledgedByUserId: uuid("acknowledged_by_user_id").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
});

/* ------------------------------------------------------------- money in */

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    branchId: uuid("branch_id").notNull().references(() => branches.id),
    number: text("number").notNull(),
    /** Which financial year's series this number came from — FR-811. */
    financialYear: integer("financial_year").notNull(),
    jobId: uuid("job_id").references(() => jobs.id),
    contractId: uuid("contract_id").references(() => contracts.id),
    /** Which instalment of the contract's schedule this settles. */
    contractPoint: integer("contract_point"),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    siteId: uuid("site_id").references(() => sites.id),
    /**
     * SNAPSHOT, deliberately — not a join. A tax invoice is a document: if the
     * customer corrects their GSTIN next year, every invoice already issued
     * must keep showing what was printed and filed.
     */
    billTo: jsonb("bill_to").notNull(),
    issueDate: date("issue_date").notNull(),
    head: e.taxHeadEnum("head").notNull(),
    /** FR-802: rendered verbatim on the invoice, so it is stored, not derived. */
    explanation: text("explanation").notNull(),
    taxablePaise: money("taxable_paise").notNull(),
    totalTaxPaise: money("total_tax_paise").notNull(),
    /** FR-812: keeps the printed total a whole number of rupees. */
    roundOffPaise: money("round_off_paise").notNull().default(0),
    grandTotalPaise: money("grand_total_paise").notNull(),
    placeOfSupplyOverrideReason: text("place_of_supply_override_reason"),
    status: e.invoiceStatusEnum("status").notNull().default("DRAFT"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** §31's consecutive series, enforced rather than assumed. */
    unique("invoices_series_uq").on(t.branchId, t.financialYear, t.number),
    /** A job bills once. The duplicate the customer notices before we do. */
    unique("invoices_job_uq").on(t.jobId),
    /** An instalment is raised once. */
    unique("invoices_contract_point_uq").on(t.contractId, t.contractPoint),
    index("invoices_customer_idx").on(t.customerId),
  ],
);

export const invoiceLines = pgTable("invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  /** FR-803: 4 digits at or below ₹5 crore AATO, 6 above. */
  code: text("code").notNull(),
  kind: e.lineKindEnum("kind").notNull(),
  qty: integer("qty").notNull(),
  ratePaise: money("rate_paise").notNull(),
  ratePercent: integer("rate_percent").notNull(),
});

export const advances = pgTable(
  "advances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    branchId: uuid("branch_id").notNull().references(() => branches.id),
    /** §31(3)(d): its own series, never the invoice series. */
    voucherNumber: text("voucher_number").notNull(),
    financialYear: integer("financial_year").notNull(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    contractId: uuid("contract_id").references(() => contracts.id),
    receivedOn: date("received_on").notNull(),
    /** Gross. The tax is back-calculated out, never grossed up on top. */
    receiptPaise: money("receipt_paise").notNull(),
    ratePercent: integer("rate_percent").notNull().default(18),
    head: e.taxHeadEnum("head").notNull(),
    status: e.advanceStatusEnum("status").notNull().default("OPEN"),
    /** Adjusted once only — closing twice double-counts the credit. */
    adjustedByInvoiceId: uuid("adjusted_by_invoice_id").references(() => invoices.id),
    adjustedAt: timestamp("adjusted_at", { withTimezone: true }),
  },
  (t) => [
    unique("advances_series_uq").on(t.branchId, t.financialYear, t.voucherNumber),
    unique("advances_adjusted_by_uq").on(t.adjustedByInvoiceId),
  ],
);

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoices.id),
  receivedOn: date("received_on").notNull(),
  amountPaise: money("amount_paise").notNull(),
  method: text("method").notNull(),
  reference: text("reference"),
  recordedByUserId: uuid("recorded_by_user_id").references(() => users.id),
});

/* ------------------------------------------------------------ money out */

/**
 * Every chase on an unpaid invoice — FR-904, §6.12.1.
 *
 * The collections list is not a list of amounts, it is a list of
 * conversations: "24 Jul — promised 5 Aug" is what stops a second call being
 * made to someone who already committed. FR-904 excludes an unbroken promise
 * from reminders, which means the promise has to be a stored fact with a date,
 * not a note somebody typed into a spreadsheet.
 *
 * `promisedFor` is null when the customer said something other than a date.
 * Whether a promise is *broken* is derived against today rather than stored —
 * a stored flag would go stale overnight, which is exactly when it matters.
 */
export const collectionContacts = pgTable(
  "collection_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    note: text("note").notNull(),
    promisedFor: date("promised_for"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("collection_contacts_invoice_idx").on(t.tenantId, t.invoiceId, t.occurredAt)],
);

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    name: text("name").notNull(),
    /** FR-807: null means unregistered, which is the reverse-charge trigger. */
    gstin: text("gstin"),
    stateCode: text("state_code").notNull(),
    /** FR-906: null means §206AA, and TDS becomes 20%. */
    pan: text("pan"),
    panType: e.panTypeEnum("pan_type").notNull(),
    msmeClass: e.msmeClassEnum("msme_class").notNull().default("UNVERIFIED"),
    udyamNumber: text("udyam_number"),
    /** A trading registration does not attract the MSMED timeline at all. */
    udyamActivity: e.udyamActivityEnum("udyam_activity"),
  /**
   * When the Udyam status was last checked — §6.12.3.
   *
   * A stored status with a date is honest; a stored status without one is a
   * claim the screen cannot defend. A registration can lapse or be
   * reclassified, so "Micro" with no date is not evidence of anything.
   */
  udyamVerifiedOn: date("udyam_verified_on"),
    /** §15 MSMED: with an agreement the limit is 45 days, without it 15. */
    hasWrittenAgreement: boolean("has_written_agreement").notNull().default(false),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  },
  (t) => [index("vendors_tenant_idx").on(t.tenantId)],
);

export const purchaseBills = pgTable(
  "purchase_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
    /** SNAPSHOT — renaming a vendor must not rewrite a recorded bill. */
    vendorName: text("vendor_name").notNull(),
    /** Theirs, not ours. This is an inward document. */
    vendorBillNumber: text("vendor_bill_number").notNull(),
    /** FR-905: this date starts the §43B(h) clock. */
    billDate: date("bill_date").notNull(),
    description: text("description").notNull(),
    taxablePaise: money("taxable_paise").notNull(),
    gstPercent: integer("gst_percent").notNull(),
    gstPaise: money("gst_paise").notNull(),
    /** FR-807: when true the GST is ours to remit, not theirs to collect. */
    reverseCharge: boolean("reverse_charge").notNull().default(false),
    tdsSection: e.tdsSectionEnum("tds_section").notNull().default("NONE"),
    tdsPaise: money("tds_paise").notNull().default(0),
    payablePaise: money("payable_paise").notNull(),
    status: e.purchaseStatusEnum("status").notNull().default("UNPAID"),
    paidOn: date("paid_on"),
  },
  (t) => [
    unique("purchase_bills_vendor_number_uq").on(t.tenantId, t.vendorId, t.vendorBillNumber),
    index("purchase_bills_clock_idx").on(t.tenantId, t.status, t.billDate),
  ],
);

/* ------------------------------------------------------------ reference */

export const rateRows = pgTable(
  "rate_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    code: text("code").notNull(),
    description: text("description").notNull(),
    ratePercent: integer("rate_percent").notNull(),
    /**
     * FR-804. Insert-only: a change adds a dated row and the old one still
     * answers for its own period. There is no update path, by design — an
     * invoice raised before the 2025 rationalisation was correct at 28% and
     * must stay correct at 28%.
     */
    effectiveFrom: date("effective_from").notNull(),
    note: text("note").notNull(),
  },
  (t) => [unique("rate_rows_code_from_uq").on(t.tenantId, t.code, t.effectiveFrom)],
);

/**
 * FR-811 — the statutory counters.
 *
 * A row per (branch, document type, financial year). The browser held these as
 * one integer and `series.ts` said outright that a shared sequence needs the
 * backend. Taking a number is `UPDATE ... SET last_issued = last_issued + 1
 * RETURNING`, which is atomic — two people billing at once cannot both take
 * 0150.
 */
export const seriesCounters = pgTable(
  "series_counters",
  {
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    branchId: uuid("branch_id").notNull().references(() => branches.id),
    docType: e.docTypeEnum("doc_type").notNull(),
    /** The year the FY starts in — 2026 means 2026-27, rolling on 1 April. */
    financialYear: integer("financial_year").notNull(),
    lastIssued: integer("last_issued").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.branchId, t.docType, t.financialYear] })],
);

/**
 * FR-1305 — append-only, and the only table with no update or delete path.
 *
 * Eight-year retention, so it is partitioned by month in production rather
 * than one growing heap. `occurred_at` differs from `at` when the technician
 * app replays a queue: an entry recorded in a basement at 11:04 and synced at
 * 14:20 must not claim to have happened at 14:20.
 */
export const auditEntries = pgTable(
  "audit_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    /** Denormalised on purpose: a deactivated user must still read as a name. */
    actorName: text("actor_name").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    origin: e.auditOriginEnum("origin").notNull().default("web"),
    entityTable: text("entity_table"),
    entityId: uuid("entity_id"),
  },
  (t) => [index("audit_tenant_at_idx").on(t.tenantId, t.at)],
);

/* ------------------------------------------------------------ relations */

export const customerRelations = relations(customers, ({ many }) => ({
  sites: many(sites),
  contracts: many(contracts),
  invoices: many(invoices),
}));

export const siteRelations = relations(sites, ({ one, many }) => ({
  customer: one(customers, { fields: [sites.customerId], references: [customers.id] }),
  contacts: many(contacts),
  assets: many(assets),
  jobs: many(jobs),
}));

export const contractRelations = relations(contracts, ({ one, many }) => ({
  customer: one(customers, { fields: [contracts.customerId], references: [customers.id] }),
  schedules: many(contractSchedules),
  invoices: many(invoices),
}));

export const jobRelations = relations(jobs, ({ one, many }) => ({
  customer: one(customers, { fields: [jobs.customerId], references: [customers.id] }),
  site: one(sites, { fields: [jobs.siteId], references: [sites.id] }),
  parts: many(jobParts),
  events: many(jobEvents),
}));

export const invoiceRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  lines: many(invoiceLines),
  payments: many(payments),
}));

export const vendorRelations = relations(vendors, ({ many }) => ({
  bills: many(purchaseBills),
}));

/** Guards the schema cannot express, kept where the schema is read. */
export const SQL_GUARDS = sql`
  -- FR-804: rate rows are inserted, never updated or deleted.
  -- FR-1305: audit entries likewise.
  -- Applied as migrations after table creation; see drizzle/0001_guards.sql
`;

/* ------------------------------------------------------------ sign-in */

/**
 * A one-time code in flight.
 *
 * Stored hashed, exactly like a password. A six-digit code is guessable in a
 * hundred thousand tries, so the row carries its own attempt counter and the
 * verifier refuses after five — rate limiting lives on the challenge rather
 * than on an IP, because the thing being protected is this phone number.
 *
 * `user_id` is resolved when the code is requested, not when it is verified. A
 * request for a number nobody has still returns 200 and still takes the same
 * time; telling a caller which numbers exist is a free directory of your staff.
 */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    userId: uuid("user_id").references(() => users.id),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Set the moment it is spent. A code works exactly once. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_phone_idx").on(t.phoneE164, t.createdAt)],
);

/**
 * Refresh tokens, hashed and rotated.
 *
 * Rotated on every use: presenting a refresh token returns a new one and
 * revokes the old. If a stolen token is used after the real one has rotated,
 * `rotated_from` shows a token being replayed — which is the only reliable
 * signal that a session was lifted.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedFrom: uuid("rotated_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("refresh_tokens_hash_uq").on(t.tokenHash),
    index("refresh_tokens_user_idx").on(t.userId),
  ],
);
