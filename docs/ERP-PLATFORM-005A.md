# ERP-PLATFORM-005A — reviewed candidate contract (not deployment approval)

## Immutable bases and outcome
Backend: 19d865ef9a9a05d9755d24f47be1c91651d0f2a7.
Web: 8df79c0cbd7be89d07bb5466a04cf90aa63c1912.
Owner: /root/erp_admin_company_console (gpt-6.1-sol).
Independent reviewer: /root/erp_prod_sso_review (gpt-6-sol), read-only.

This is the first operational cohort, not the complete A–Z platform.
- /: real business/legal name, branches, customer/open-job counts and the next 20 open jobs.
- /customers: real paginated directory; create a customer and primary site together.
- /account: confirmed identity and workspace link; no longer the forced landing.
- All actual active roles, including technician and readonly_ca, have equal cohort access.
- Other modules are labelled Upcoming and have no links. Inherited routes redirect to /;
  the proxy is a release manifest, not an authentication substitute.
- No role switcher, browser-selected API, sample identity, fixtures, synthetic served
  backend, invented provider, financial operation, message or payment is included.

## Central temporary entitlement and authentication
src/tenant/entitlements.ts is the sole audited server policy:
TEMPORARY_ACCESS.enabled=true, policy ERP-PLATFORM-005A, modules overview/customers.
It is evaluated per request, not granted by role/plan allowance, browser state or JWT.
Changing enabled to false in a reviewed release revokes every cohort API, while
/api/me and /account remain available. No new environment variable is required.
Later modules must join this policy only with their reviewed dependency closure.
This is not a bypass in the old can() table, nor an owner-role impersonation.

Before policy evaluation, every core request calls existing currentIdentity:
tenant HS256 issuer/audience, SID validation, current session, current active user,
and ACTIVE tenant lifecycle + ACTIVE or unexpired TRIAL subscription. Missing state,
inactive user, expired/closed account, forged/admin-realm or revoked token is refused.
The real role is retained and the existing create function records the actual actor.
All business queries use db + withTenant and explicit tenant predicates, never adminDb.

## Exact new contracts / routing
GET /api/core/workspace
- Bearer verified current identity. No supplied tenant/role is authority.
- Explicit baseline fields only: company identity, branch identity/state, aggregate
  customers/open jobs, 20 earliest scheduled open job rows with customer/branch names.
- No prices, credentials, plan internals or unshipped detail links.

GET /api/core/customers?page=N
- Integer page 0..10000, 50 rows plus hasMore; stable name/id ordering.
- id, name, customerType, billingStateCode only.
POST /api/core/customers
- Strict JSON: id (request UUID), branchId, name (1..200 trimmed),
  customerType BUSINESS|INDIVIDUAL, billingStateCode (accepted code),
  addressLine1 (1..300), locality/city (1..120), pincode (6 digits, nonzero first).
- Browser tenant/actor/role extra fields refused. Branch must belong to verified tenant.
- Reuses existing create_erp_customer from applied 0073: active actor/branch scope,
  duplicate-address guard, atomic first site and domain audit. No duplicate-review
  bypass is offered. Conflicts are refused; advanced duplicate review remains upcoming.
- An immutable audit entry keyed by request UUID and normalized-payload digest makes
  unchanged retries safe. A concurrent key conflict rolls the entire statement back.
  Reusing the same UUID with different input never silently changes existing data.
- 201 created; 200 unchanged replay; 409 safe conflict; generic redacted 503 for faults.

The existing API Gateway CloudFormation template adds exactly THREE explicit route
resources to the EXISTING tenant API/integration: those two GETs and that POST.
No default/proxy route, new API/Lambda, public/admin/cron router or DNS is added.
The web server allowlist adds exactly those methods/paths. Authorization is forwarded,
refresh cookies are NOT forwarded to core endpoints; no viewer/tenant/control headers
are trusted. Only the directory page query is forwarded; arbitrary query overrides
are refused. Existing 16 KiB JSON body limit, exact HTTPS execute-api upstream check,
configured HTTPS origin, same-origin POST enforcement, no-store, timeout, redirect
refusal, cookie validation and refresh rotation remain unchanged.
The API catch-all now exports POST, but its server allowlist still rejects all other
API writes. Existing /auth cookies stay Secure/HttpOnly/Lax/host-only/Path=/auth.

## Schema dependency and rehearsal
NEW MIGRATIONS: NONE. Production baseline remains accepted 0079 plus applied0421/0423.
This cohort requires:
- 0000 core tenants, branches, users, customers, sites, jobs, audit_entries and enums;
- 0001 immutable audit trigger; 0010 app_runtime grant/RLS/current-tenant policy;
- applied0023/0027+ customer/branch tenant keys and subsequent baseline customer/site
  columns/invariants; applied0073 final create_erp_customer;
- applied0076 tenant lifecycle/subscription/plan tables; 0421/0423 current session gates.
The exact accepted 82-file source hash manifest is BASELINE-MANIFEST.json in the review
evidence. No unapplied A–Z migration was copied into the source patch.

An entirely new local loopback-only PostgreSQL16 database was created with no
production dump/data/credentials and all accepted82 source files replayed successfully.
Five actual-SQL tests execute candidate workspace.ts SQL and existing0073 function
under SET LOCAL ROLE app_runtime plus tenant GUC:
- ACTIVE/live-trial versus missing/expired/closed lifecycle;
- atomic customer/site/domain audit and same-request replay;
- duplicate, foreign-branch and changed-request refusal without orphan records;
- two-tenant company/branch/customer/job/count isolation;
- absent-GUC SELECT denial and foreign-tenant INSERT denial.
The test transport adapter uses psql instead of Neon HTTP; it is not a hosted backend
and does not replace the unchanged production db/client.ts. It runs only with explicit
ERP_CORE_TEST_PG=local-005a-disposable against the hardcoded loopback disposable DB.
Without that local setup, five tests skip honestly in CI. Existing focused auth tests
cover active-user/SID revocation, refresh replay, wrong-realm, generic refusal and CORS.
No production DB was inspected. Accepted baseline evidence is authoritative.

## CI / IAM / release (separately authorized only)
The R1 workflow correction is required: main previously deployed BOTH Lambdas on every
push. Both deployment jobs now depend on explicit checked impact outputs. The full
type/test/build/import/archive checks still run, even when neither target needs deploy.
No deployment-role policy or permission expansion is required.

scripts/lambda-impact.mjs defines and tests these impact sets:
- Platform: before/after union of src/platform-lambda.ts local import closure (currently
  12 source files, including shared schema/client/password/validation dependencies).
- Tenant: before/after union of src/tenant-lambda.ts local import closure (currently
  14 source files, including dynamically imported workspace.ts).
- Both: package.json, pnpm-lock.yaml, .nvmrc, .node-version, .npmrc, .pnpmfile.cjs,
  pnpm-workspace.yaml, tsconfig.json, scripts/build-lambda.mjs, pnpm patches/, shared
  check/build workflow changes, or subsequent changes to the impact classifier itself.
- Platform deployment input: scripts/erp-admin-002-oidc-setup.sh and the platform
  workflow deployment block. Tenant deployment input: its existing CloudFormation
  template and the tenant workflow deployment block.
- Docs, tests and SQL migrations alone do not mutate Lambda code. Migrations require
  separate approval; they are not applied by this gate.

This is not a broad directory path filter: both old and new dependency graphs are
traced, including literal dynamic imports, renamed/deleted inputs and re-exports.
Unresolved/nonliteral imports, unexpected workflow layout, missing before commit or
zero initial-push SHA abort the check instead of guessing skip/deploy. The source
closure is checked against actual esbuild bundle inputs for BOTH runtimes.
Initial introduction of the exact reviewed gate/output/checkout-depth wiring is
neutral for unchanged artifacts; later classifier changes are shared impact.
Only those exact bootstrap strings are normalized; other check/job changes are
classified or rejected. The computed changed paths, source sets and reasons are
recorded in the workflow summary before any deployment identity is obtained.

For this exact tenant-only candidate the output is platform=false, tenant=true:
platform job is skipped, tenant job runs only after all checks pass. An actual
platform/shared/deployment-input change still triggers its corresponding guarded job.
Retain immutable action pins, main-only immutable OIDC subject and tenant-only role:
repo:Raunakkmrr@48851091/oBizee-ERP-Backend@1328693208:ref:refs/heads/main
Exact Lambda:
arn:aws:lambda:ap-south-1:940482448572:function:obizee-erp-tenant
Retain only lambda:GetFunctionConfiguration/lambda:UpdateFunctionCode on that ARN,
archive SHA/revision/stale-main write gates and post-write stale-main failure recording.
Never expand this role to API Gateway/CloudFormation/platform permissions.

After independent review:
1. Verify main still matches approved bases or rebase/review again; inspect exact patch,
   source hashes, type/tests/build/import/ZIP root and zero migration manifest.
2. Under separately approved provisioning authority, prepare a change set on EXISTING
   obizee-erp-tenant-runtime stack. Accept ONLY three Add AWS::ApiGatewayV2::Route
   resources pointing to existing TenantApi/TenantIntegration. Abort on any other
   replacement/update/deletion. No IAM expansion is part of this change.
3. Release backend code through corrected main CI; confirm platform skipped and tenant
   selected in checked impact evidence; validate deployed artifact hash and
   unauthenticated core401 / excluded route404 / wrong origin403 without credentials.
   Add explicit routes before dependent web cutover. Partial ordering is fail-closed.
4. Release web through existing Asia/Kolkata Next16 Amplify CI. Server-only existing
   ERP_TENANT_API_URL=https://o01mde8q41.execute-api.ap-south-1.amazonaws.com and
   ERP_WEB_ORIGIN=https://main.drfe61b9ed4d2.amplifyapp.com remain unchanged.
5. Human signs in with own company credentials; verify company identity, deep links,
   refresh and real empty/data states; any customer write needs explicit human intent.
   Agents must not create production records or use real credentials for smoke tests.

## Backup, rollback and limitations
No schema/data migration is performed, so no migration restore/replay occurs in
production. Retain existing backup policy; do not call the old runtime004 dump fresh.
Any later schema cohort needs a newly approved secure backup/isolated restore first.
Rollback code: revert to reviewed previous runtime004 tenant/web artifacts and remove
only three new explicit routes through a reviewed change set. Preserve legitimate
customer/site/audit records created after release; never delete them to roll back UI.
Retain the reviewed impact gate when rolling back tenant product code; do NOT restore
the historical unconditional-deployment workflow or run an unrelated platform rollback.
Alternatively revoke central cohort policy in a reviewed release; /account stays usable.
Do not auto-rollback a stale deployment write; record failure and inspect current main.

Local browser checks used the built web configured only for the real HTTPS API and no
credentials: /, /customers, /account, inherited /jobs/42 and query-flag deep links all
reach sign-in; refresh is stable; no auth requests were sent. This is not an authenticated
production canary. Authenticated shell/data tests are non-served unit/SQL tests.
Full-platform acceptance, authenticated real-origin human canary and live independent
review remain outstanding; this candidate does not claim those passed.

## R2 — runner isolation and tenant-only catch-up (review required)
CI 39142453441 failed before deployment because Vitest collected the node:test suite;
178 Vitest tests passed, but neither Lambda deployed. vitest.config.ts now excludes
ONLY scripts/lambda-impact.test.mjs. That suite still runs explicitly with node --test;
its filename, classifier, workflow and all11 tests remain byte-for-byte unchanged.

A test-config-only follow-up would select no runtime, leaving the cohort undeployed.
The existing tenant template therefore has a bounded top-level Metadata release marker:
ERPPlatform005ARelease revision R2-tenant-only-catch-up records the failed run and the
exact reviewed tenant ZIP hash. That file is ALREADY a tenant-only classified deployment
input, so this reviewed correction selects tenant=true/platform=false without changing
classifier semantics. Metadata is non-resource CloudFormation information: every actual
Resources, Parameters, Outputs, IAM, Lambda and API definition equals f029a468 unchanged.
The only live route changes remain the previously approved THREE explicit route Adds.

After independent R2 approval, use existing CI (no direct Lambda update). Confirm the
tenant artifact remains SHA256 6f7df86888718574e002d7fea7af2e9cf4f4bbe84de5c22597062462e57ed8fc,
platform skips and tenant succeeds; inspect the stack change set for only the original
three Add routes, not resource/IAM modifications. No SQL migrations or web changes.
Keep this marker as historical release intent after success. Advance or remove it ONLY
in a separately reviewed tenant release: either change intentionally selects tenant
again. Do not auto-clear it or treat it as evidence deployment succeeded. Source/CI,
stack execution and the human authenticated canary remain separate release gates.
