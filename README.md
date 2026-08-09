# oBizee Service ERP — API

TypeScript · Postgres (Neon) · Drizzle ORM.

Ported from `obez-erp-web/src/lib/data/*`, which was written frontend-first and
became the de-facto specification. `../obez-erp-docs/ERD.md` records what the
schema changed on the way across and why.

## The database

Neon project `obizee-erp`, branch `production`, **Postgres 16** in
`ap-southeast-1` (Singapore). 16 rather than the newer default so it matches the
local instance on port 5433 exactly — a version gap between development and
staging is a class of bug that costs hours and teaches nothing.

Neon Auth is off. Identity is ours, in our own tables.

Copy `.env.example` to `.env` and fill both values. `DATABASE_URL` is the
**pooled** string from Dashboard → Connect.

## Verified against the real database

Every guard below was executed, not assumed:

    tables: 24 | enums: 23

    FR-811   20 concurrent next_in_series() calls returned 1..20,
             no duplicate and no gap
    FR-804   UPDATE and DELETE on rate_rows both refused
    FR-1305  DELETE on audit_entries refused
    FR-812   a total that does not add up is refused
             a total that is not whole rupees is refused
    §31      a duplicate invoice number in the same branch and year is refused
             a user with neither phone nor email is refused

## Commands

    pnpm typecheck            # tsc --noEmit
    ./scripts/db-generate.sh  # generate a migration from the schema
    pnpm db:migrate           # apply migrations
    pnpm db:studio            # browse the data

**Generate through the script, not `drizzle-kit` directly.** This repo sits on
an exFAT volume where macOS writes an AppleDouble sibling for every file;
drizzle-kit globs `meta/*.json`, tries to parse one, and dies. The script runs
generation on the system disk and copies the result back. The note is in
`scripts/db-generate.sh`.

## What the database enforces, not the application

Every one of these was a convention in the frontend store — a comment, or a
`Set` in a reducer. Conventions hold until somebody is in a hurry.

| Guard | Requirement |
|---|---|
| `next_in_series()` — atomic `UPDATE ... RETURNING` | FR-811. Two people billing at once cannot both take 0150 |
| `invoices_series_uq` on (branch, FY, number) | §31's consecutive series |
| `invoices_job_uq`, `invoices_contract_point_uq` | A job bills once; an instalment is raised once |
| `jobs_tenant_visitkey_uq` | FR-502. Generating a contract's visits twice cannot double them |
| `advances_adjusted_by_uq` | Closing a voucher twice would double-count the credit |
| `rate_rows_insert_only` trigger | FR-804. A rate is a fact about a period, not a setting |
| `audit_entries_insert_only` trigger | FR-1305. A trail that can be tidied is worthless |
| `invoices_foots_exactly` + `invoices_whole_rupees` | FR-812, asserted by the database |
| `job_events_client_uuid_uq` | FR-303. The technician app's replay is idempotent |

## Authorisation

`src/auth/roles.ts` is **the** permission table. The identical file in
`obez-erp-web/src/lib/roles.ts` is a mirror so the interface can grey out a
control before it is clicked; if the two disagree, this one wins. `pnpm test`
compares them byte for byte whenever the web repo is checked out beside this
one.

The rule, stated once: **a permission check in the browser shapes the interface;
a permission check here is security.** Both are needed, neither substitutes.

| Piece | What it does |
|---|---|
| `requireCaller` | Resolves the caller from a bearer token. No anonymous mode, no "assume owner" fallback. Public routes mount *before* it, so being public is a decision |
| `requirePermission(p)` | Refuses with the permission and the role named — the reader is usually a colleague who needs to know who to ask |
| `stripFields` | FR-1302. Deletes the key rather than hiding it: a hidden price is still in the JSON |

The tenant comes off the token and never from a parameter, so a handler cannot
forget to scope a query.

## Signing in

One identity, two ways to prove it. Field staff use a phone and a one-time
code; the office uses an email and a password. Both land in the same `users`
row and produce the same tokens.

    POST /auth/otp/request   { phone }
    POST /auth/otp/verify    { phone, code }  -> access + refresh
    POST /auth/password      { email, password }
    POST /auth/refresh       { refreshToken }

Route order is the security model: these are mounted **before**
`requireCaller`, so a new route is protected by default. Forgetting a guard
fails closed.

### The development OTP

There is no SMS provider yet, so `OTP_PROVIDER=dev` accepts a fixed code —
**123456** — for every number.

That is a reasonable thing to build and a catastrophic thing to ship, so it is
not guarded by a comment. `DevOtpSender` throws at construction when
`NODE_ENV=production`, and again unless `OTP_DEV_MODE=on` is set explicitly.
Two independent switches must both be wrong before a fixed code reaches a real
user, and the process refuses to boot rather than running insecurely.

`OTP_PROVIDER` has **no default** — an unset value is a configuration mistake,
and guessing is how the wrong sender gets used.

Wiring MSG91 later is implementing `Msg91OtpSender.send` and setting
`OTP_PROVIDER=msg91`. Nothing else changes: not the routes, not the challenge
table, not verification, expiry, single-use or the attempt limit. The dev
sender does not skip any of that — it only makes the code predictable.

### What the flow enforces

| | |
|---|---|
| Requesting a code | Identical reply and timing whether the number is real, unknown, malformed or deactivated — otherwise the endpoint is a staff directory |
| A code | Expires in 5 minutes, works exactly once, and is stored hashed |
| Guessing | Five attempts per challenge. Six digits is 100,000 guesses, which is nothing |
| Passwords | scrypt from Node core — see `src/auth/password.ts` for why not argon2 — with cost stored alongside so it can be raised later |
| Wrong password vs unknown email | The same reply, and the same time spent |
| Refresh tokens | Rotated on use; the old one is revoked, and the new one records what it replaced, so a replay is visible |

## Seed data

    node --env-file=.env --experimental-strip-types src/db/seed.ts

Idempotent. Creates Shakti Cooling — the firm the web app's fixtures describe.
Nothing in it is random; every row exercises a rule:

| Row | The rule it exercises |
|---|---|
| Shakti Industries — sites in **07 and 27** | The same customer bills CGST+SGST from one site and IGST from the other |
| Sunrise Apartments RWA — Haryana GSTIN | Permanently interstate against a Delhi branch |
| Mrs. Deshpande — **no GSTIN** | The common household case |
| Verma Electricals — unregistered **individual** | Reverse charge *and* §194C at 1%, not 2% |
| Metro Refrigeration — **trading** Udyam | The MSMED timeline excludes it — the case people get wrong |
| Counters at 440 / 149 / 6 | The first document issued is 0441, not a suspicious 0001 |

    office:  manish@shakticooling.test / obizee-dev-2026
    field:   9820012345 + OTP 123456

## Routes

    GET  /api/customers          list, with sites
    GET  /api/customers/:id      404s across tenants, even with a valid id
    POST /api/customers          customer + first site in one call
    GET  /api/jobs               scoped by role — see below
    POST /api/jobs               takes its number from the atomic sequence
    POST /api/jobs/:id/assign       primary + helpers        FR-205
    POST /api/jobs/:id/reschedule   same job, attempt + 1    FR-206
    POST /api/jobs/:id/transition   explicit state table     FR-303

    GET  /api/leads              dated follow-up queue       FR-107
    GET  /api/leads/lookup       duplicate detection         FR-102
    POST /api/leads              closed source list          FR-101, FR-105
    PATCH /api/leads/:id         taken_by is immutable       FR-103, FR-104
    POST /api/leads/:id/convert  customer + site + job       FR-106

    GET  /api/contracts          with their schedules        FR-1406
    POST /api/contracts          visits and billing are separate axes  FR-505
    POST /api/contracts/:id/generate-visits   idempotent     FR-502

Two rules the jobs list enforces that are easy to get wrong:

- **FR-306** — `job:read` is the whole board, `job:read_own` is a technician's
  own work. Gating on `job:read` alone refuses technicians outright, which is
  the wrong answer: they need the list, narrowed.
- **FR-1302** — prices are removed from the payload, not hidden in it. A
  technician's response has no `valuePaise` key at all.

### Transitions and replay

State moves are an explicit table, not any-status-to-any-status: a job cannot
jump from `ASSIGNED` to `SIGNED_OFF`, because the reason a state exists is that
something happened.

Only the **primary** technician may transition from the field. A helper is on
the job sheet and counts at half weight in workload; he does not record what
happened. One person owns the account of a visit.

**FR-303 — a replayed write is not an error.** The `clientUuid` check runs
*before* the transition table. An offline queue replayed on reconnect tries to
record "reached site" when the job is already `ON_SITE`; validating the
transition first answered that with a 409, and the app would treat a successful
sync as a failure and retry forever.

    GET/POST /api/invoices       place of supply from the site     FR-802
    GET/POST /api/vendors        reverse charge + MSMED on the row  FR-705
    POST /api/vendors/advise     what a bill would attract, and why
    POST /api/vendors/bills      TDS recomputed, never trusted      FR-906
    GET  /api/vendors/bills      savable and lost, apart            FR-905

### Money, and what it refuses

- **The place of supply is derived, never accepted.** It is not a field a
  request may set. Charging CGST+SGST where IGST was due is the commonest and
  most expensive GST error a small firm makes, and it is invisible until a
  notice arrives — so it comes from the customer's own site, and the sentence
  explaining it is stored on the invoice.
- **Totals are computed here.** A client that sends its own `grandTotalPaise`
  can round differently, and the register would stop agreeing with the returns.
  The footing constraint in the database is the second line of defence.
- **A customer with no site cannot be invoiced at all** — an invoice that
  cannot state its own tax head must not be issued.
- **TDS is recomputed on save**, not taken from the request. `/advise` exists so
  the interface can show reverse charge and TDS *with their reasons* while the
  reader types, and what it shows is what the server will apply — not a second
  implementation in the browser that drifts.

### Refusals read like sentences

Every constraint in `0001_guards.sql` exists because a rule matters. When one
fires the caller was stopped from doing something wrong, which is the system
working — so it answers with the rule, not a 500:

    409  That job has already been invoiced — a job bills once.
    409  That contract instalment has already been raised.
    409  That vendor's bill number is already recorded.

Route groups are built with `apiRouter()` rather than `new Hono()`. Hono routes
a thrown error to the `onError` of the instance it was thrown in, so a sub-app
mounted with `route()` never reaches the parent's handler and a wrapping
middleware never sees the rejection — the constraint fired, the rule worked, and
the caller still got a bare 500.

    GET/POST /api/advances            Receipt Voucher, own series   FR-810
    POST /api/advances/:id/adjust     once only
    POST /api/payments                partial is normal             FR-901
    GET  /api/payments/receivables    six buckets, §43B(h) flagged  FR-903

- **An advance's tax is back-calculated, not grossed up.** A customer paying
  "₹3,60,000 for the year" pays a gross figure; they have not separately handed
  over 18%. Grossing up collects tax the customer never sent.
- **An invoice's balance is derived from its payments**, never a status field
  somebody has to remember to flip. Overpayment is refused rather than
  reconciled later — an overpaid invoice is a credit note nobody raised.
- **FR-806 asks, it does not decide.** Goods and services at different rates may
  be a composite supply or two things sold apart. The tax position belongs to
  the taxpayer, so the advisory never blocks.

    GET /api/gst/:period          can I file this, and what is unresolved  FR-814
    GET /api/gst/:period/export   tally | zoho | json — refuses if not ready

### The GST workspace

The one decision it serves is **can I file this period, and what is
unresolved** — not "here are your numbers". The accountant already has numbers.
What he has never had is a machine willing to say *no, and here is exactly why*.

- **The export is blocked, not warned about.** A partial GST export produces a
  return that looks filed and is wrong, and the taxpayer carries that.
- **The tables are rebuilt from the lines** and then checked against the stored
  invoice totals. If the two disagree, one of them is lying — and the
  reconciliation names which side is short rather than reporting a cheerful
  total. Verified: a ₹1 wrong line is caught and blocks the export.
- **Every export carries its provenance** — source, period, branch, GSTIN, who
  and when. A number whose filters are unknown cannot be defended in an
  assessment, and the accountant is the one who will be asked.

## Still to build

Pointing the web app at the API, then retiring the browser store and the
acting-as switcher.
# oBizee-ERP-Backend
