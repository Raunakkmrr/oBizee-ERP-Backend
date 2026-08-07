import type { Context } from "hono";

/**
 * Turn a database refusal into an answer a person can act on.
 *
 * Every constraint in `0001_guards.sql` exists because a rule matters — a job
 * bills once, an instalment is raised once, a rate row is never edited. When
 * one fires, the caller was **stopped from doing something wrong**, which is
 * the system working. Answering that with a 500 and "Internal Server Error"
 * says the opposite: it reads as a broken server, tells the reader nothing,
 * and sends them to an engineer instead of to the fix.
 *
 * So each constraint is mapped to the sentence it is actually enforcing. An
 * unmapped violation still becomes a 409 rather than a 500 — a constraint
 * firing is never an internal error, even one nobody has written a message for
 * yet.
 */
const BY_CONSTRAINT: Record<string, { status: 409 | 400; message: string }> = {
  invoices_job_uq: {
    status: 409,
    message: "That job has already been invoiced — a job bills once.",
  },
  invoices_contract_point_uq: {
    status: 409,
    message: "That contract instalment has already been raised.",
  },
  invoices_series_uq: {
    status: 409,
    message:
      "That invoice number already exists for this branch and financial year. Section 31 requires a consecutive series.",
  },
  jobs_tenant_visitkey_uq: {
    status: 409,
    message: "Those visits are already on the board — generating twice would double them.",
  },
  jobs_tenant_number_uq: {
    status: 409,
    message: "That job number is already in use.",
  },
  advances_adjusted_by_uq: {
    status: 409,
    message: "That advance has already been adjusted — closing it twice would double-count the credit.",
  },
  advances_series_uq: {
    status: 409,
    message: "That receipt voucher number already exists for this branch and year.",
  },
  purchase_bills_vendor_number_uq: {
    status: 409,
    message: "That vendor's bill number is already recorded.",
  },
  rate_rows_code_from_uq: {
    status: 409,
    message: "A rate for that code already starts on that date. A change adds a later row.",
  },
  job_events_client_uuid_uq: {
    status: 409,
    message: "That event was already recorded.",
  },
  users_tenant_phone_uq: {
    status: 409,
    message: "Somebody here already uses that phone number.",
  },
  users_tenant_email_uq: {
    status: 409,
    message: "Somebody here already uses that email address.",
  },
  invoices_foots_exactly: {
    status: 400,
    message:
      "The invoice does not add up: taxable plus tax plus round-off must equal the total.",
  },
  invoices_whole_rupees: {
    status: 400,
    message: "An invoice total must be a whole number of rupees.",
  },
  invoices_round_off_bounded: {
    status: 400,
    message: "The round-off exceeds half a rupee, which means the arithmetic is wrong.",
  },
  users_reachable: {
    status: 400,
    message: "A user needs a phone number or an email address to sign in with.",
  },
  contract_schedules_anchor_day: {
    status: 400,
    message: "The anchor day is a date of the month — 1 to 31.",
  },
  sign_offs_rating_range: {
    status: 400,
    message: "A rating is 1 to 5.",
  },
};

type PgError = { code?: string; constraint?: string; message?: string };

/**
 * Find the driver's error inside whatever wrapped it.
 *
 * Drizzle raises a `DrizzleQueryError` with the Neon error on `.cause`, so
 * reading `constraint` off the top-level object finds nothing and every
 * refusal degrades to a 500 — the constraint fires, the rule works, and the
 * caller is told the server broke.
 */
function unwrap(err: unknown): PgError {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const candidate = current as PgError & { cause?: unknown };
    if (candidate.constraint || candidate.code) return candidate;
    current = candidate.cause;
  }
  return (err ?? {}) as PgError;
}

export function handleError(err: unknown, c: Context): Response {
  const pg = unwrap(err);

  if (pg?.constraint && BY_CONSTRAINT[pg.constraint]) {
    const known = BY_CONSTRAINT[pg.constraint]!;
    return c.json({ error: known.message, constraint: pg.constraint }, known.status);
  }

  // Unique violation, check violation, foreign key, not-null — all of these are
  // the caller being refused, not the server failing.
  if (pg?.code === "23505" || pg?.code === "23514" || pg?.code === "23503") {
    return c.json(
      {
        error: "That would break a rule this system enforces.",
        constraint: pg.constraint ?? null,
        code: pg.code,
      },
      409,
    );
  }

  // A genuine fault. Logged in full; the caller gets nothing to probe with.
  console.error("unhandled", err);
  return c.json({ error: "Something went wrong at our end." }, 500);
}
