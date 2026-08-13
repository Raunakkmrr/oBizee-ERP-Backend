import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, count, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client.ts";
import {
  branches,
  contacts,
  customers,
  jobEvents,
  jobHelpers,
  jobs,
  signOffs,
  sites,
  users,
} from "../db/schema.ts";
import {
  PRICE_FIELDS,
  requirePermission,
  stripFields,
  type AppEnv,
} from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { sla } from "../lib/sla.ts";
import { can } from "../auth/roles.ts";
import { formatNumber, nextInSeries } from "../lib/series.ts";
import { audit } from "../lib/audit.ts";

/**
 * Jobs — FR-201 to FR-207.
 *
 * **FR-1302 lives here.** A technician gets the same rows as a coordinator with
 * the money fields *removed from the payload*, not hidden in the response. The
 * web app greys prices out and still ships them; anyone with a developer
 * console can read those. `stripFields` deletes the keys.
 *
 * The site is a foreign key, not a typed locality. That is what makes the place
 * of supply — and therefore the tax head — derivable at all.
 */
export const jobRoutes = apiRouter();

/** The primary technician, aliased so a second join can never collide. */
const technician = alias(users, "primary_technician");

/**
 * How many rows a page holds.
 *
 * The list used to end in a bare `.limit(200)` — no total, no next page, no
 * indication. Under two hundred jobs nobody would ever notice; a firm doing
 * twenty visits a day crosses it in ten days, and from then on the oldest work
 * orders are absent from a screen headed "every work order". Silent truncation
 * is the worst of the three options, because the screen still looks complete.
 */
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Two characters. One is every job.
 *
 * Below this the query is ignored rather than refused, so a box being typed
 * into shows the unfiltered list instead of an error that appears and vanishes
 * on the second keystroke.
 */
const MIN_QUERY = 2;

/**
 * The board's five views, plus the one the record needs.
 *
 * These are applied **here**, not in the browser, for the same reason the
 * search is: the list is paged, so filtering fifty rows in hand and calling the
 * result "Unassigned (3)" would be a count of this page rather than of the
 * firm. The five names are §6.4.1's own, so a coordinator moving between Today
 * and Jobs does not relearn the vocabulary.
 *
 * `unscheduled` is the sixth and belongs only to the record. The board has no
 * use for it — a job with no date cannot be dispatched today — but it is the
 * fastest way to find the stubs somebody started and never finished, which is
 * otherwise a needle in the whole table.
 */
const FILTERS = [
  "unassigned",
  "en_route",
  "on_site",
  "parts_awaited",
  "done_not_billed",
  "unscheduled",
] as const;

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  filter: z.enum(FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
});

/** One definition, matching `matchesFilter` in the web app row-for-row. */
function filterPredicate(filter: (typeof FILTERS)[number]) {
  switch (filter) {
    case "unassigned":
      return sql`${jobs.primaryTechnicianId} is null`;
    case "en_route":
      return eq(jobs.status, "EN_ROUTE");
    case "on_site":
      return eq(jobs.status, "ON_SITE");
    case "parts_awaited":
      return eq(jobs.status, "PARTS_AWAITED");
    case "done_not_billed":
      return inArray(jobs.status, ["WORK_DONE", "SIGNED_OFF"]);
    case "unscheduled":
      return sql`${jobs.scheduledDate} is null`;
  }
}

/**
 * How close a word has to be to count as the word somebody meant.
 *
 * **Measured, not chosen.** `similarity()` compares the query against the
 * *whole* string, so a short query is diluted by the words it does not mention:
 * `Nidi` against `Nidhi Singh` scores 0.214 and misses the 0.3 default outright,
 * while `Shakit` against `Shakti Industries` scores 0.190. Both are exactly the
 * typo the fuzzy match exists to absorb.
 *
 * `word_similarity()` compares the query against the best-matching *word* in
 * the target, which is the question actually being asked — "is this one of the
 * words in that name?" The same two score 0.600 and 0.571.
 *
 * 0.5 is where every real misspelling in the register passes and nothing
 * unrelated does. Measured across the customer list: Nidi→Nidhi Singh, Shakit→
 * Shakti Industries, Nandni→Nandini Foods, Grean→Green Park, Sunris→Sunrise
 * all match; `zzz`, `Verma` and `Kapoor` match nothing. Raising it to Postgres'
 * 0.6 default drops Shakit and Nandni; lowering it to 0.4 starts pulling in
 * names that merely share a syllable.
 */
const WORD_MATCH = 0.5;

/**
 * What the search looks at, and why each one is on the list.
 *
 * `q` reaches this having been typed by somebody with a customer on the line,
 * so it is matched three ways at once:
 *
 * - **substring**, for the things read back off a screen — a job number, a
 *   locality, the tail of a phone number;
 * - **trigram similarity**, for the things typed from memory — "Kumar" has to
 *   find "Rani Kumari" and "Deshmuk" has to find "Deshmukh Hospital", which no
 *   amount of prefix matching will do;
 * - **digits only**, for phones, because a caller reads "98116 67788" with a
 *   space and the column holds `919811667788`.
 *
 * Similarity alone would be wrong: `pg_trgm`'s default 0.3 threshold refuses
 * short queries outright, and "1007" against "J-2610-1007" scores far below it
 * while being an exact substring. Substring alone would be wrong for every
 * misspelling. Both, OR-ed, is what makes the box feel like it works.
 */
function searchPredicate(raw: string) {
  const like = `%${raw}%`;
  const digits = raw.replace(/\D/g, "");

  const clauses = [
    ilike(jobs.jobNumber, like),
    ilike(jobs.serviceType, like),
    ilike(customers.name, like),
    ilike(sites.locality, like),
    ilike(technician.name, like),
    /*
      The fuzzy half, written as an explicit comparison rather than the `<%`
      operator.

      `<%` reads its threshold from `pg_trgm.word_similarity_threshold`, a
      session GUC — and this connection is the Neon HTTP driver, where every
      statement is its own round trip and the only thing riding along is the
      tenant `set_config` the client shim sends. A threshold set in one request
      would not be there for the next. Naming the number in the predicate makes
      it true regardless of session state, which is worth more here than the
      index the operator would have used.
    */
    sql`word_similarity(${raw}, ${customers.name}) >= ${WORD_MATCH}`,
    sql`word_similarity(${raw}, coalesce(${technician.name}, '')) >= ${WORD_MATCH}`,
    sql`word_similarity(${raw}, ${jobs.serviceType}) >= ${WORD_MATCH}`,
    sql`word_similarity(${raw}, coalesce(${sites.locality}, '')) >= ${WORD_MATCH}`,
  ];

  /*
    Three digits before a phone is worth searching. Fewer matches most numbers
    in the book, which is not a search result — it is the whole list wearing a
    disguise.
  */
  if (digits.length >= 3) {
    clauses.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(contacts)
          .where(
            and(
              eq(contacts.siteId, jobs.siteId),
              ilike(contacts.phoneE164, `%${digits}%`),
            ),
          ),
      ),
    );
  }

  return or(...clauses);
}

/**
 * Best match first, but only while searching.
 *
 * With no query the list is a record and reads newest-first. With one it is an
 * answer to a question, and the row that answers it belongs at the top —
 * otherwise searching "Kumari" puts her October visit above her June one and
 * buries both under whatever else happens to match.
 */
function searchRank(raw: string) {
  return sql`greatest(
    word_similarity(${raw}, ${customers.name}),
    word_similarity(${raw}, coalesce(${technician.name}, '')),
    word_similarity(${raw}, ${jobs.jobNumber}),
    word_similarity(${raw}, ${jobs.serviceType}),
    word_similarity(${raw}, coalesce(${sites.locality}, ''))
  )`;
}

jobRoutes.get("/", async (c) => {
  const caller = c.get("caller");

  /*
    FR-306 — a technician sees only his own jobs.

    Two permissions, not one: `job:read` is the whole board, `job:read_own` is
    his own work. Gating this route on `job:read` alone refused technicians
    outright, which is the wrong answer — they need the list, narrowed.
  */
  const seesEverything = can(caller.role, "job:read", undefined, caller.level);
  const seesOwn = can(caller.role, "job:read_own", undefined, caller.level);
  if (!seesEverything && !seesOwn) {
    return c.json(
      { error: `A ${caller.role} cannot do this`, needs: "job:read", role: caller.role },
      403,
    );
  }

  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "That is not a page of jobs.", detail: parsed.error.issues }, 400);
  }
  const { limit, offset } = parsed.data;
  const raw = parsed.data.q ?? "";
  const searching = raw.length >= MIN_QUERY;

  /*
    FR-306 is applied *before* the search, never after.

    A technician searching "Shakti" must not learn that a job at Shakti exists
    and merely belongs to somebody else. Narrowing first means the search runs
    over the rows he is allowed to see, so an absent result and an unauthorised
    one are the same answer.
  */
  const scope = seesEverything
    ? eq(jobs.tenantId, caller.tenantId)
    : and(eq(jobs.tenantId, caller.tenantId), eq(jobs.primaryTechnicianId, caller.userId));

  const where = and(
    scope,
    searching ? searchPredicate(raw) : undefined,
    parsed.data.filter ? filterPredicate(parsed.data.filter) : undefined,
  );

  /*
    The true total, counted with the same joins and the same filter.

    A second round trip, and worth it: "showing 50 of 1,284" is the sentence
    that was missing, and it is the only way a reader can tell a short list
    from a truncated one.
  */
  const [counted] = await db
    .select({ total: count() })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .leftJoin(technician, eq(jobs.primaryTechnicianId, technician.id))
    .where(where);

  // `count()` over a grouped-less select always returns one row; the zero case
  // is a zero, not an absent row. Defaulted anyway so a shape change here
  // cannot become a 500 on the list everybody opens first.
  const total = counted?.total ?? 0;

  const rows = await db
    .select({
      id: jobs.id,
      jobNumber: jobs.jobNumber,
      status: jobs.status,
      priority: jobs.priority,
      serviceType: jobs.serviceType,
      scheduledDate: jobs.scheduledDate,
      slot: jobs.slot,
      visitAttempt: jobs.visitAttempt,
      valuePaise: jobs.valuePaise,
      customer: customers.name,
      locality: sites.locality,
      siteStateCode: sites.stateCode,
      technicianId: jobs.primaryTechnicianId,
      technicianName: technician.name,
      visitNumber: jobs.visitNumber,
      visitOf: jobs.visitOf,
      visitKey: jobs.visitKey,
      promisedBy: jobs.promisedBy,
    })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .leftJoin(technician, eq(jobs.primaryTechnicianId, technician.id))
    .where(where)
    /*
      Newest first by the date the work is *for*, not the row's birthday. A
      visit generated today for October is not newer than one happening
      tomorrow, and this is the record rather than the dispatch board.

      **Undated last, explicitly.** Postgres puts NULLs *first* under DESC, so a
      job with no date sat above every dated one — and since an undated job is
      usually a stub nobody has scheduled, the top of the record was a wall of
      them and the real work started somewhere below the fold. They are found by
      the Unscheduled filter and marked in the row, which is a deliberate way to
      surface a problem; sorting by accident is not.
    */
    .orderBy(
      ...(searching ? [desc(searchRank(raw))] : []),
      sql`${jobs.scheduledDate} desc nulls last`,
      desc(jobs.createdAt),
      // A stable last resort, so a row cannot appear on two pages or neither.
      asc(jobs.id),
    )
    .limit(limit)
    .offset(offset);

  /*
    FR-1302. Stripped server-side unless the caller may see selling prices.
    The tenant toggle defaults off, which is a stated anti-freelancing control
    rather than paranoia — a technician who can see the margin can quote around
    the firm.
  */
  const maySeePrices = can(caller.role, "price:view_selling", undefined, caller.level);

  /*
    Shaped like the board's rows, deliberately.

    The Jobs screen renders the same row and reuses the board's own filters, so
    a second shape would mean a second set of them. It called `/api/board/today`
    for exactly that reason — and got only today's work under a heading that
    says "every work order", so a contract visit generated for October was
    invisible on the screen whose job is to list it.
  */
  const now = new Date();
  const shaped = rows.map((r) => ({
    ...r,
    slot: r.slot ?? "Unslotted",
    locality: r.locality ?? "—",
    technician: r.technicianId ? { id: r.technicianId, name: r.technicianName ?? "—" } : null,
    visit:
      r.visitNumber !== null || r.visitOf !== null
        ? { n: r.visitNumber, of: r.visitOf }
        : null,
    // FR-207 — a word, never a bare colour, and the same words the board uses.
    sla: sla(r.promisedBy, now),
  }));

  return c.json({
    jobs: maySeePrices
      ? shaped
      : stripFields(shaped, [...PRICE_FIELDS] as (keyof (typeof shaped)[number])[]),
    pricesVisible: maySeePrices,
    scope: seesEverything ? "all" : "own",
    /*
      The page, stated rather than implied. `total` is what the filter actually
      matches; `hasMore` is derived here so no reader has to do the arithmetic
      and get it wrong at the last page.
    */
    total,
    limit,
    offset,
    hasMore: offset + shaped.length < total,
    // Echoed back so a slow response cannot repaint the list for a query the
    // reader has already replaced.
    query: searching ? raw : null,
    filter: parsed.data.filter ?? null,
  });
});

/**
 * A window, or an exact time.
 *
 * `9-1`, `1-5` and `5-8` are the day's three windows and cover most visits.
 * An exact time is the one a customer was actually promised — "the doctor is
 * only free at 11:30" — and the board already sorts it among the windows by
 * its own hour. The validator allowed only the three, which refused a job the
 * column and the board both handle.
 */
const slotSchema = z.union([
  z.enum(["9-1", "1-5", "5-8"]),
  z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "A time like 11:30, or one of the day's windows"),
]);

const newJob = z.object({
  customerId: z.string().uuid(),
  siteId: z.string().uuid(),
  serviceType: z.string().trim().min(2),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** FR-203: a slot, never a false-precision timestamp. */
  slot: slotSchema.optional(),
  priority: z.enum(["normal", "urgent", "breakdown"]).default("normal"),
  primaryTechnicianId: z.string().uuid().nullable().optional(),
});

jobRoutes.post(
  "/",
  requirePermission("job:write"),
  zBody( newJob),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    // The site must belong to the customer *and* the tenant. Checking the
    // tenant alone would let a caller attach a job to another customer's site.
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.id, body.siteId),
          eq(sites.customerId, body.customerId),
          eq(sites.tenantId, caller.tenantId),
        ),
      )
      .limit(1);
    if (!site) return c.json({ error: "That site is not on that customer" }, 400);

    const branchId = caller.branchId ?? (
      await db.select({ id: branches.id }).from(branches)
        .where(eq(branches.tenantId, caller.tenantId)).limit(1)
    )[0]?.id;
    if (!branchId) return c.json({ error: "No branch on file" }, 400);

    const [branch] = await db
      .select({ prefix: branches.jobSeriesPrefix })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1);

    const now = new Date();
    const sequence = await nextInSeries(caller.tenantId, branchId, "job", now);
    const jobNumber = formatNumber("job", branch?.prefix ?? "J", sequence, now);

    const [job] = await db
      .insert(jobs)
      .values({
        tenantId: caller.tenantId,
        branchId,
        jobNumber,
        customerId: body.customerId,
        siteId: body.siteId,
        serviceType: body.serviceType,
        scheduledDate: body.scheduledDate ?? null,
        slot: body.slot ?? null,
        priority: body.priority,
        primaryTechnicianId: body.primaryTechnicianId ?? null,
        status: body.primaryTechnicianId ? "ASSIGNED" : "CREATED",
      })
      .returning();

    await audit(caller, "CREATE_JOB", `Raised work order ${jobNumber}`, {
      table: "jobs",
      id: job!.id,
    });

    return c.json(job, 201);
  },
);

/* --------------------------------------------------------------- mutations */

const assignBody = z.object({
  primaryTechnicianId: z.string().uuid().nullable(),
  /** FR-205: any number, counted at half weight in workload. */
  helperIds: z.array(z.string().uuid()).max(6).default([]),
});

jobRoutes.post(
  "/:id/assign",
  requirePermission("job:dispatch"),
  zBody( assignBody),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    // Everyone named must be an active technician in this tenant. Without the
    // check a dispatcher could assign a job to another firm's staff.
    const named = [body.primaryTechnicianId, ...body.helperIds].filter(
      (x): x is string => x !== null,
    );
    if (named.length > 0) {
      const found = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, caller.tenantId),
            eq(users.role, "technician"),
            eq(users.active, true),
            inArray(users.id, named),
          ),
        );
      if (found.length !== new Set(named).size) {
        return c.json({ error: "Someone named is not an active technician here" }, 400);
      }
    }

    const [updated] = await db
      .update(jobs)
      .set({
        primaryTechnicianId: body.primaryTechnicianId,
        // Assigning does not un-start a job that is already moving.
        status: job.status === "CREATED" && body.primaryTechnicianId ? "ASSIGNED" : job.status,
      })
      .where(eq(jobs.id, id))
      .returning();

    await db.delete(jobHelpers).where(eq(jobHelpers.jobId, id));
    if (body.helperIds.length > 0) {
      await db
        .insert(jobHelpers)
        .values(body.helperIds.map((userId) => ({ jobId: id, userId })));
    }

    await audit(caller, "ASSIGN_JOB", `Assigned ${job.jobNumber}`, {
      table: "jobs",
      id,
    });
    return c.json(updated);
  },
);

/**
 * FR-206 — rescheduling preserves the job and counts the attempt.
 *
 * A new job would lose the history and make "second visit" uncountable. The
 * attempt counter is what tells a coordinator this is a customer already let
 * down once.
 */
jobRoutes.post(
  "/:id/reschedule",
  requirePermission("job:write"),
  zBody(
    z.object({
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slot: slotSchema.optional(),
      reason: z.string().trim().min(3),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    const [updated] = await db
      .update(jobs)
      .set({
        scheduledDate: body.scheduledDate,
        slot: body.slot ?? job.slot,
        visitAttempt: job.visitAttempt + 1,
      })
      .where(eq(jobs.id, id))
      .returning();

    /*
      Also on the job's own timeline, not only in the audit log.

      The audit log answers "who changed what" months later; the timeline
      answers "what has happened to this visit" to the next person who opens
      it. A visit that moved — and why — is exactly what the technician
      arriving tomorrow needs, and FR-203's reason was reaching only the log
      nobody reads while working.
    */
    await db.insert(jobEvents).values({
      tenantId: caller.tenantId,
      jobId: id,
      label: `Moved to ${body.scheduledDate}${body.slot ? ` ${body.slot}` : ""} — ${body.reason}`,
      actorUserId: caller.userId,
      occurredAt: new Date(),
    });

    await audit(
      caller,
      "RESCHEDULE_JOB",
      `Moved ${job.jobNumber} to ${body.scheduledDate} — ${body.reason}`,
      { table: "jobs", id },
    );
    return c.json(updated);
  },
);

/**
 * State transitions — FR-205, FR-208.
 *
 * **Only the primary technician may transition from the field.** A helper
 * cannot, and a coordinator moving a job on a technician's behalf is a
 * different act with a different audit line. The transition table is explicit
 * rather than "any status to any status": a job cannot jump from CREATED to
 * SIGNED_OFF, and the reason a state exists is that something happened.
 */
const NEXT: Record<string, readonly string[]> = {
  CREATED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["EN_ROUTE", "CUSTOMER_UNAVAILABLE", "CANCELLED"],
  EN_ROUTE: ["ON_SITE", "CUSTOMER_UNAVAILABLE"],
  ON_SITE: ["WORK_DONE", "PARTS_AWAITED", "CUSTOMER_UNAVAILABLE"],
  PARTS_AWAITED: ["ASSIGNED", "ON_SITE", "CANCELLED"],
  CUSTOMER_UNAVAILABLE: ["ASSIGNED", "CANCELLED"],
  WORK_DONE: ["SIGNED_OFF"],
  SIGNED_OFF: [],
  CANCELLED: [],
};

/**
 * Record that the customer signed for the work — FR-1201, FR-1202.
 *
 * **Nothing wrote to `sign_offs`.** The table was read in three places and
 * written in none, so a job could reach `SIGNED_OFF` with no signature behind
 * it — which is exactly what happened: two jobs in the register badged "Signed
 * off" while the sign-off panel on the same screen said nobody had signed. The
 * status and the record disagreed because only one of them existed.
 *
 * **The transition happens here, and only here.** Moving to `SIGNED_OFF` is not
 * a state change somebody should be able to make on its own — it is the
 * consequence of a signature. Writing the record and moving the status in one
 * request is what stops the two drifting apart again.
 *
 * **`origin` is honest about which this was.** §6.9 specifies the customer
 * signing on the technician's device; that surface does not exist yet, so what
 * the office can record is a *reported* sign-off — the technician rang in, or
 * the customer confirmed on WhatsApp. FR-1204 already anticipates that path.
 * Storing it as though a finger had touched glass would put a claim on the
 * record that nobody made, so it is named.
 */
jobRoutes.post(
  "/:id/sign-off",
  requirePermission("job:write"),
  zBody(
    z.object({
      signerName: z.string().trim().min(2).max(120),
      /** FR-1202 — words on the screen, a number in the register. */
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(500).optional(),
      origin: z.enum(["reported_by_office", "signed_on_device"]).default("reported_by_office"),
      /** When the customer actually signed, not when the office typed it in. */
      signedAt: z.string().datetime().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select({ id: jobs.id, jobNumber: jobs.jobNumber, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    /*
      The same table the transition route enforces. A job that has not reached
      WORK_DONE has not been done, and a signature against it would be a
      customer signing for work nobody has reported finishing.
    */
    if (job.status !== "WORK_DONE") {
      return c.json(
        {
          error: `A job cannot be signed off from ${job.status}`,
          allowed: NEXT[job.status] ?? [],
        },
        409,
      );
    }

    const signedAt = body.signedAt ? new Date(body.signedAt) : new Date();

    await db.insert(signOffs).values({
      jobId: job.id,
      tenantId: caller.tenantId,
      signerName: body.signerName,
      signedAt,
      rating: body.rating,
      comment: body.comment ?? null,
      // No image until §6.9's capture surface exists. Saying `true` here would
      // promise a signature somebody could be asked to produce.
      signatureUploaded: false,
    });

    await db
      .update(jobs)
      .set({ status: "SIGNED_OFF" })
      .where(and(eq(jobs.id, job.id), eq(jobs.tenantId, caller.tenantId)));

    await db.insert(jobEvents).values({
      tenantId: caller.tenantId,
      jobId: job.id,
      actorUserId: caller.userId,
      label: "SIGNED_OFF",
      occurredAt: signedAt,
      offline: false,
    });

    await audit(
      caller,
      "RECORD_SIGN_OFF",
      `${body.signerName} signed off ${job.jobNumber}` +
        (body.origin === "reported_by_office" ? " — reported to the office" : ""),
      { table: "jobs", id: job.id },
    );

    return c.json({ id: job.id, status: "SIGNED_OFF", signerName: body.signerName });
  },
);

jobRoutes.post(
  "/:id/transition",
  zBody(
    z.object({
      to: z.enum([
        "ASSIGNED", "EN_ROUTE", "ON_SITE", "PARTS_AWAITED",
        "CUSTOMER_UNAVAILABLE", "WORK_DONE", "SIGNED_OFF", "CANCELLED",
      ]),
      /** When it happened on the ground — not when it reached us. */
      occurredAt: z.string().datetime().optional(),
      note: z.string().optional(),
      /** FR-303: the technician app's replay key. */
      clientUuid: z.string().uuid().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.tenantId, caller.tenantId)))
      .limit(1);
    if (!job) return c.json({ error: "No such job" }, 404);

    const fromField = caller.role === "technician";
    if (fromField && job.primaryTechnicianId !== caller.userId) {
      // A helper is on the job sheet and counts at half weight; he does not
      // record what happened. One person owns the account of a visit.
      return c.json({ error: "Only the primary technician can record this" }, 403);
    }
    if (!fromField && !can(caller.role, "job:write", undefined, caller.level)) {
      return c.json({ error: `A ${caller.role} cannot do this`, needs: "job:write" }, 403);
    }

    /*
      FR-303 — the replay check comes first, before the transition table.

      An offline technician's queue is replayed on reconnect, and the second
      attempt to record "reached site" arrives when the job is already ON_SITE.
      Validating the transition first answered that with a 409: the app would
      treat a successful sync as a failure and keep retrying forever. A write
      the server has already accepted is not an illegal transition, it is the
      same write.
    */
    if (body.clientUuid) {
      const [seen] = await db
        .select({ id: jobEvents.id })
        .from(jobEvents)
        .where(
          and(
            eq(jobEvents.tenantId, caller.tenantId),
            eq(jobEvents.clientUuid, body.clientUuid),
          ),
        )
        .limit(1);
      if (seen) return c.json({ ...job, replayed: true });
    }

    const allowed = NEXT[job.status] ?? [];
    if (!allowed.includes(body.to)) {
      return c.json(
        {
          error: `A job cannot go from ${job.status} to ${body.to}`,
          allowed,
        },
        409,
      );
    }

    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();

    try {
      await db.insert(jobEvents).values({
        tenantId: caller.tenantId,
        jobId: id,
        label: body.note ? `${body.to} — ${body.note}` : body.to,
        actorUserId: caller.userId,
        occurredAt,
        offline: occurredAt.getTime() < Date.now() - 60_000,
        clientUuid: body.clientUuid ?? null,
      });
    } catch {
      // Belt and braces: two replays racing each other both pass the check
      // above, and the unique constraint catches the loser.
      const [current] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return c.json({ ...current, replayed: true });
    }

    const [updated] = await db
      .update(jobs)
      .set({ status: body.to })
      .where(eq(jobs.id, id))
      .returning();

    await audit(caller, "TRANSITION_JOB", `${job.jobNumber} → ${body.to}`, {
      table: "jobs",
      id,
    });
    return c.json(updated);
  },
);
