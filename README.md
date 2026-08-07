# oBizee Service ERP — API

TypeScript · Postgres (Neon) · Drizzle ORM.

Ported from `obez-erp-web/src/lib/data/*`, which was written frontend-first and
became the de-facto specification. `../obez-erp-docs/ERD.md` records what the
schema changed on the way across and why.

## Getting a database

Neon, one project per environment. Copy the pooled connection string into
`.env`:

    DATABASE_URL=postgresql://...neon.tech/obizee_erp?sslmode=require

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

## Still to build

Sign-in itself — phone and OTP for field staff, email and password for the
office — the route layer over the schema, and refresh-token rotation.
