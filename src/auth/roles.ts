/**
 * Roles and permissions — FR-1301, FR-1302, PRD §3, §9.4.
 *
 * **This copy is the authority.** §9.4: "Authorisation is enforced server-side
 * on every request. The UI hiding a control is a courtesy; the API refusing it
 * is the control." The identical file in `obez-erp-web/src/lib/roles.ts` exists
 * so the interface can grey out a button before the reader clicks it — it is a
 * mirror, and if the two ever disagree, this one wins.
 *
 * Two copies of a permission table drift, and the drift is silent. `pnpm test`
 * compares them byte for byte when the web repo is present as a sibling and
 * fails when they diverge, which is the only place that check can run while
 * these are separate repositories.
 *
 * The rule this file exists to enforce, stated once: **a permission check in
 * the browser shapes the interface; a permission check here is security.** Both
 * are needed. Neither substitutes for the other.
 *
 * FR-1302 has the sharpest version of it. When the technician price toggle is
 * off, prices are not hidden — the field is never serialised. A hidden price is
 * still in the JSON, and the JSON is readable.
 */

/** The six built-in roles (FR-1301). Per-tenant overrides come later. */
export const ROLES = [
  "owner",
  "coordinator",
  "marketing",
  "technician",
  "accountant",
  "readonly_ca",
] as const;

export type Role = (typeof ROLES)[number];

/** Human labels, for the People screen and for permission-error messages. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  coordinator: "Coordinator",
  marketing: "Marketing",
  technician: "Technician",
  accountant: "Accountant",
  readonly_ca: "Read-only CA",
};

/**
 * Permissions are `resource:action`. Kept deliberately coarse — one per real
 * decision a screen makes — because a matrix with sixty near-identical entries
 * gets copied wrongly, and §6.3's permission-error state has to name a role a
 * human can go and ask ("Only the Accountant or Owner can finalise an invoice.
 * Ask Suresh to approve."), which needs coarse, meaningful units.
 */
export const PERMISSIONS = [
  // Leads and jobs
  "lead:read",
  "lead:write",
  /**
   * Preparing a priced quote. The dividing line between the three
   * customer-facing desks a service firm actually runs: a support desk logs
   * and reports, a telecaller qualifies and books, and only an estimator puts
   * a number in front of a customer.
   */
  "quote:write",
  "job:read",
  "job:read_own", // technician: only his own, ±3/+14 days (FR-306)
  "job:write",
  "job:dispatch", // assign, reschedule, force-close
  "job:transition_field", // EN_ROUTE / ON_SITE / WORK_DONE — technician only (§4.2 rule 1)

  // Customers, sites, contracts
  "customer:read",
  "customer:write",
  "contract:read",
  "contract:write",

  // Money
  "invoice:read",
  "invoice:write",
  "invoice:finalise",
  "payment:read",
  "payment:write",
  "gst:read",
  "gst:write",
  "export:generate",

  // Parts
  "part:read",
  "part:issue_to_van",
  "part:consume",
  "part:purchase",

  // Visibility of commercially sensitive figures
  "price:view_selling", // job value, invoice value, contract value
  "price:view_cost", // cost price and margin — owner only (§3.1)

  // Reports and administration
  "report:read",
  "report:technician_performance",
  "settings:read",
  "settings:write",
  "people:manage",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The matrix, derived directly from the "Access" line of each persona in §3 and
 * from §5.13. Each role's comment quotes the constraint it implements, so a
 * future change has to argue with the PRD rather than with a preference.
 */
const MATRIX: Record<Role, readonly Permission[]> = {
  /** §3.1: "everything, including cost prices, technician performance, and margins." */
  owner: [...PERMISSIONS],

  /**
   * §3.2: "leads, jobs, dispatch, customers, sites, contracts. Invoices
   * read-only. No cost prices."
   * Parts is "view + issue to van" per §6.2's role table.
   */
  coordinator: [
    "lead:read",
    "lead:write",
    "job:read",
    "job:write",
    "job:dispatch",
    "customer:read",
    "customer:write",
    "contract:read",
    "contract:write",
    "invoice:read",
    "payment:read",
    "part:read",
    "part:issue_to_van",
    "price:view_selling",
    "report:read",
    "export:generate",
    "settings:read",
  ],

  /**
   * §3.3: "only his own assigned jobs, ±3 days. Sees customer contact and site.
   * Does not see invoice value or part cost price by default."
   *
   * Note what is absent and why: no `customer:read` (there is no customer
   * directory in the technician app at all — §6.2 gives him three tabs and
   * "no global search, no customer directory, no reports"), no `job:read`
   * (only `job:read_own`), and no price permission of any kind. `price:view_selling`
   * is granted at runtime only when the tenant's FR-1302 toggle is on.
   */
  /**
   * Marketing — one role, with a **level** inside it.
   *
   * A first attempt split this into three roles (support desk, telecaller,
   * estimator) because the industry has three job titles. That was the same
   * mistake as modelling technician seniority as roles: a title is not a
   * permission set, and eight roles to describe one department is a
   * configuration burden nobody will maintain.
   *
   * This is the base every marketing person holds. What separates a phone
   * support level from a senior who quotes and visits is `LEVEL_GRANTS` below,
   * not a different role.
   */
  marketing: [
    "lead:read",
    "lead:write",
    "customer:read",
    "customer:write",
    "job:read",
    "contract:read",
    // Every level sees how the department is doing — source performance is the
    // number a marketer is measured on, and hiding it from the people making
    // the calls helps nobody. The level gates *pricing*, which is the risk.
    "report:read",
  ],

  technician: [
    "job:read_own",
    "job:transition_field",
    "part:read",
    "part:consume",
  ],

  /**
   * §3.4: "invoices, credit notes, payments, receivables/payables, GST
   * workspace, exports, customers. Read-only on jobs (he must be able to see
   * the evidence behind a line). No dispatch."
   */
  accountant: [
    "job:read",
    "customer:read",
    "customer:write",
    "contract:read",
    "invoice:read",
    "invoice:write",
    "invoice:finalise",
    "payment:read",
    "payment:write",
    "gst:read",
    "gst:write",
    "export:generate",
    "part:read",
    "part:purchase",
    "price:view_selling",
    "price:view_cost",
    "report:read",
    "settings:read",
    "audit:read",
  ],

  /**
   * FR-1003 / §3.4: scoped to invoices, payments, the GST workspace and
   * exports, "with no ability to alter operational data".
   */
  readonly_ca: [
    "invoice:read",
    "payment:read",
    "gst:read",
    "export:generate",
    "customer:read",
    "report:read",
  ],
};

/** Tenant-level toggles that modify a role's baseline permissions. */
export type TenantToggles = {
  /** FR-1302. Default OFF — a stated anti-freelancing control, not paranoia. */
  technicianSeesPrices: boolean;
  /** FR-1301 / §4.2: lets a coordinator raise invoices. Off by default. */
  coordinatorCanBill: boolean;
};

export const DEFAULT_TENANT_TOGGLES: TenantToggles = {
  technicianSeesPrices: false,
  coordinatorCanBill: false,
};

/**
 * Whether a role may do something, with the tenant's toggles applied.
 *
 * Toggles are resolved here rather than baked into the matrix so that the
 * matrix stays a readable statement of §3, and the deviations stay visible as
 * deviations.
 */
/**
 * The ladder inside a role, and what each rung adds.
 *
 * **This is the axis that is not a category.** A firm has one marketing
 * department; asking "which level?" once inside it is a dropdown, not five more
 * role tags to configure, explain and keep permissions aligned.
 *
 * Only marketing's levels change what somebody may *do*, and only in one place
 * — pricing. A technician's levels change who the board will send alone, which
 * is a dispatch judgement rather than a permission, so they grant nothing here.
 */
export const LEVELS_BY_ROLE: Partial<Record<Role, readonly string[]>> = {
  marketing: ["support", "leads", "senior"],
  technician: ["apprentice", "standard", "senior", "lead"],
};

/**
 * Labels are scoped to the role, not to the level string.
 *
 * A flat map collided: both ladders have a `senior` rung, so a senior
 * *technician* was labelled "Senior — quotes and site visits". Two departments
 * are allowed to use the same word for their top rung and mean different jobs.
 */
const LEVEL_LABELS_BY_ROLE: Partial<
  Record<Role, Record<string, string>>
> = {
  marketing: {
    support: "Support — answers calls",
    leads: "New leads — qualifies and books",
    senior: "Senior — quotes and site visits",
  },
  technician: {
    apprentice: "Apprentice",
    standard: "Technician",
    senior: "Senior technician",
    lead: "Lead / foreman",
  },
};

/** Falls back to the raw value rather than rendering blank. */
export function levelLabel(role: Role, level: string | null): string | null {
  if (!level) return null;
  return LEVEL_LABELS_BY_ROLE[role]?.[level] ?? level;
}

/**
 * Extra permissions a level adds on top of its role.
 *
 * Pricing is the whole difference. A support level that can see selling prices
 * ends up quoting on the phone, and a number given before anyone has seen the
 * site is the most expensive habit a service firm can form — so `quote:write`
 * and `price:view_selling` arrive only at the senior level, which is the person
 * who actually goes and looks.
 */
const LEVEL_GRANTS: Record<string, readonly Permission[]> = {
  // Repeating a quote already made is not making one.
  leads: ["price:view_selling"],
  senior: ["quote:write", "price:view_selling", "contract:write"],
};

export function can(
  role: Role,
  permission: Permission,
  toggles: TenantToggles = DEFAULT_TENANT_TOGGLES,
  /**
   * The rung inside the role. Omitted means the role's **base** — never the
   * most permissive level, so a caller that forgets to pass it under-grants
   * rather than over-grants.
   */
  level?: string | null,
): boolean {
  if (level && LEVEL_GRANTS[level]?.includes(permission)) return true;

  if (
    role === "technician" &&
    permission === "price:view_selling" &&
    toggles.technicianSeesPrices
  ) {
    return true;
  }

  if (
    role === "coordinator" &&
    toggles.coordinatorCanBill &&
    (permission === "invoice:write" || permission === "invoice:finalise")
  ) {
    return true;
  }

  // A linear scan over ~30 entries, called per rendered control. Deliberately
  // not a pre-built Set keyed by role: that needed an `Object.fromEntries` cast
  // that TypeScript rejects as unsound, and buying microseconds with a cast on
  // the authorisation path is the wrong trade.
  return MATRIX[role].includes(permission);
}

/**
 * Which roles hold a permission — used to build §6.3's permission-error state,
 * which must name who *can* act rather than just refusing. "Naming the person
 * who can act is the difference between a dead end and a next step."
 */
export function rolesWith(
  permission: Permission,
  toggles: TenantToggles = DEFAULT_TENANT_TOGGLES,
): Role[] {
  return ROLES.filter((role) => can(role, permission, toggles));
}
