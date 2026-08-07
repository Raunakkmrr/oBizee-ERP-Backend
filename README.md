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

Two rules the jobs list enforces that are easy to get wrong:

- **FR-306** — `job:read` is the whole board, `job:read_own` is a technician's
  own work. Gating on `job:read` alone refuses technicians outright, which is
  the wrong answer: they need the list, narrowed.
- **FR-1302** — prices are removed from the payload, not hidden in it. A
  technician's response has no `valuePaise` key at all.

## Still to build

Invoices and contracts over the schema, then pointing the web app at the API.
