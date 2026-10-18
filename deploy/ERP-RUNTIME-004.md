# ERP-RUNTIME-004: review candidate, not a production release

Base: backend `063713c262148b002ba8c7f2732843fbbed90d34`.
Current production schema boundary is the accepted `0079` release record. No production
database credentials were retrieved, no database was queried, and nothing was deployed.

## Inventory and decision

Read-only AWS inventory in account `940482448572`, region `ap-south-1`, found only
`obizee-erp-platform` and HTTP API `gdvfsqkrx5` for ERP. That API is the operator
control plane and is not reused. Existing Amplify apps serve marketing, admin, orders,
and star; none serves the tenant ERP. The account already has the GitHub OIDC provider
`token.actions.githubusercontent.com` with audience `sts.amazonaws.com`.

Clean backend main builds the old tenant bundle but retains/deploys only the platform
archive. Its password and `/api/me` contracts are structurally compatible with `0079`
and the current login, but its sessions lack the newer immediate revocation/current-user
guards. The dirty working copy imports A–Z routes and workforce access functions from
`0198`, plus session objects from `0421`/`0423`; it must not be published wholesale.

This candidate adds a separate entrypoint, `src/tenant-lambda.ts`. It exposes exactly:

- `GET /health`
- `POST /auth/password`
- `POST /auth/refresh`
- `POST /auth/sign-out`
- `GET /api/me`

No business, platform, OTP, invitation, scheduler, webhook or later offline-workflow
route is exposed. This is an authentication/runtime checkpoint, NOT a usable full
A–Z ERP release. Inherited business screens remain unavailable until their own
separately reviewed runtime is released; they must never show demo data as a substitute.
The frontend instead lands at `/account`, a real-identity
checkpoint with no business shell/metrics. Its server boundary redirects inherited
business routes, including `/today`, before they render any fixture-derived state.

## Bounded account authority

Password lookup compares all matching email identities; zero or multiple valid matches
produce the same generic refusal. Active-user proof is re-read, then rechecked under
the password/session row lock. Every identity read and refresh checks a current server
session, `users.active`, and tenant lifecycle/subscription state under tenant RLS.
The tenant is taken from a verified tenant-realm token, never from a query parameter.
Tokens require issuer `obizee-erp-tenant`, audience `service-erp`, HS256 and `sid`.

The reviewed `0079`-bounded replacement for undeployed workforce access is strict:
the lifecycle must exist and be ACTIVE; a plan/subscription must exist; subscription
must be ACTIVE or an unexpired TRIAL. Missing state, PAST_DUE, EXPIRED, CLOSED, PAUSED,
unknown states and database failures grant no access. There is no always-true workforce
stub, no absent-table catch-and-allow path, and no migration of workforce data.
This deliberately denies legacy tenants without platform state instead of guessing.

Refresh tokens remain hashed in the database and rotate once under row locks. The
browser receives only a Secure, HttpOnly, SameSite=Lax host-only cookie at `/auth`;
`COOKIE_DOMAIN` must remain unset. Native explicit body-token delivery is preserved in
the API, but the browser proxy never forwards that request header. Sign-out revokes
the server session immediately. Password-reset locking helpers are retained, but a
password-change API is not exposed in this bounded release; a must-change account
remains restricted and needs its separately reviewed password-change surface.

## Exact infrastructure / IAM boundary

`erp-runtime-004-tenant-stack.json` is an unexecuted bootstrap template. Review its
change set before creation with CAPABILITY_NAMED_IAM. It creates only:

- Lambda `arn:aws:lambda:ap-south-1:940482448572:function:obizee-erp-tenant`, Node22,
  `index.handler`, 512MB, 30s; initial infrastructure placeholder always returns503.
  Actual application source is uploaded only by the checked GitHub Actions archive.
- execution role `obizee-erp-tenant-lambda-exec`, Lambda-only trust, stream/write access
  only to `/aws/lambda/obizee-erp-tenant`; log group retained, 30-day retention.
- new HTTP API `obizee-erp-tenant`, payload2.0, `$default` stage, five explicit routes,
  no catch-all; invoke permission is restricted to that generated API/account.
- role `github-obizee-erp-tenant-deploy`, only GetFunctionConfiguration and
  UpdateFunctionCode on the exact tenant Lambda ARN. No IAM, API, config, secrets,
  database, Amplify, platform or other Lambda write permissions.

OIDC trust is exact StringEquals (no wildcard and no environment-subject mismatch):

```
aud = sts.amazonaws.com
sub = repo:Raunakkmrr@48851091/oBizee-ERP-Backend@1328693208:ref:refs/heads/main
```

The existing platform deploy role/job remain unchanged. API Gateway app auth is public
at the transport layer because password sign-in is public; bearer/session validation
remains in the tenant app. No wildcard CORS is configured in API Gateway. The app allows
only the exact `WEB_ORIGINS` origin and refuses other supplied origins. API Gateway sees
SSR egress, not a trustworthy viewer IP. The R1 correction removes persisted IP lockout
keys entirely: password guessing remains limited to five failures per normalized account
per15minutes; refresh failures are limited per SHA256 of the presented unguessable token
(30 per15minutes), with successful refresh refunded. Missing refresh tokens return401
without spending any limiter bucket. Raw refresh tokens never enter rate-limit keys.
One stranger cannot exhaust a persisted app-wide15-minute budget. No forwarded-header
IP is accepted or signed on faith; the frontend continues stripping those headers.
Gateway's bounded burst/rate settings protect capacity and may transiently return429
under saturation, but do not create a shared15-minute authentication lockout. Account
targeting still has the existing account-scoped lockout; wider bot/capacity protection
is not presented as solved by trusting proxy egress or spoofable viewer headers.

Bootstrap inputs, selected securely by the authorized release operator:

1. Exact newly assigned `https://main.<app-id>.amplifyapp.com` web origin, not a guessed
   hostname; create hosting canary first so this is known.
2. A new approved Secrets Manager secret ARN matching the template constraint, with
   DATABASE_URL (privileged auth handle), APP_DATABASE_URL (existing restricted
   app_runtime handle), and a distinct >=32-character JWT_SECRET. Secrets are resolved
   by CloudFormation, not printed, committed or exposed to GitHub jobs. No platform
   control secret or admin cookie secret is copied. Creation/access to this exact
   secret is a one-time operator authority, NOT a deployment-role permission.
3. Existing OIDC provider ARN from inventory. Do not create a second provider.

After resource creation, record actual API ID/URL, stack ARN and role ARNs before any
release. Do not update the CloudFormation stack after CI uploads code without reviewing
its code diff: a changed placeholder Code property would overwrite the runtime.

## Migration gate: only 0421 then 0423, never the full directory

These are proposed additive migrations, not executed ones. `0421` needs only existing
users composite identity and refresh-token unique hash; `0423` needs those session tables
and existing credential columns. Neither needs `0420`, `0422`, workforce, A–Z tables,
or any new company data. Do not run the repository-wide migration command: it would
apply unrelated migrations between0079 and0442 from the dirty workspace.

Before release authorization:

1. Take a fresh custom-format production backup securely; record only its path/hash,
   never its connection string. Verify `pg_restore --list` and rehearse a restore to an
   isolated database. The prior0079 release backup is historical, not a fresh fallback.
2. Reconcile the accepted0079 baseline/schema tracker and exact file SHA256 values on
   the restore. Verify users(tenant_id,id), refresh_tokens(token_hash), app_runtime role,
   credential columns and privileges; reject pre-existing conflicting session objects.
3. Apply only the exact reviewed0421 and0423 SQL to the restore, split at documented
   statement breakpoints, transactionally. Record their exact filenames/hashes in the
   existing tracker only after successful DDL. Verify session FKs/indexes, app_runtime
   denial, PUBLIC/app_runtime function EXECUTE denial, and privileged auth execution.
4. Rehearse synthetic isolated sign-in/refresh/replay/revocation/concurrent password
   reset and tenant-denial tests. They are not a production credential test. Preserve
   replay/rollback evidence and obtain independent approval before production DDL.
5. Production execution is a separate, explicit approval. No company/user/session
   mutation is a deployment probe. Only the human later enters a real password.

Rollback leaves additive session objects in place. Disable the tenant API routes/proxy
or revert its CI commit and redeploy a retained known-good archive with a fresh revision
guard. First deployment has no older tenant runtime: the fail-closed503 bootstrap is
the fallback. Never drop session tables, replay older insecure auth for convenience,
or auto-rollback when main advances. A database incident requires stop-writes, a fresh
incident backup, restore to a replacement database, and separately approved repointing.

## CI release and verification

All actions are full immutable SHA pins. Types/tests/build/import precede archive
upload; archive contains only root index.mjs and package.json. The deploy job uses the
same-run artifact and checks its SHA256, runtime/handler/package/last-update status and
Lambda RevisionId. It rechecks main immediately before the write and immediately
afterward; superseded writes fail with a manual-review record, never automatic rollback.
After completion, CodeSha256 and status must match the checked archive. No environment
values are queried or printed. Record commit/run/artifact/hash/revision before sign-off.

Verification still required after independent approval and CI release:

- HTTPS health200 identifying tenant-auth; missing/forged bearer `/api/me`401;
  platform/OTP/business routes404; denied-origin request/preflight has no credentialed
  CORS grant. Use non-mutating requests only; password attempts spend rate-limit rows.
- Web `/api/health` reaches this exact API; missing config503 never fallback/localhost.
- A human enters real company credentials; browser observes same-origin auth request,
  Secure HttpOnly Lax /auth cookie without Domain, identity tenant and expected user.
- Human refresh/reload/sign-out proves continuity/revocation. Do not log/capture token,
  cookie value, password or request body. Rehearsal proves replay/role/tenant isolation.
- Regression: send >20 wrong attempts on distinct test accounts and >30 bad refreshes
  on one test token through one egress in an isolated rehearsal. Another identity/token
  must remain usable; spoofed forwarded headers must not affect buckets. Unit tests
  cover these cases in-process without a served synthetic backend or real credentials.
- Confirm `/today`, root and other inherited business URLs redirect to `/account` even
  with cookies, query flags or forwarded headers. Only confirmed `/api/me` identity is
  visible; no fixture roles, ratings, overdue counters or business links are rendered.
- Frontend hosting's Next16 compatibility, SSR env persistence, cookie forwarding and
  clean cache behavior are canary gates. A passing local build is not hosting acceptance.

Official references: https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html
currently documents native Next12–15 support; existing admin Next16 is useful precedent,
not proof for16.2.12. Same-origin route handlers avoid relying on external rewrite-cookie
behavior. Provider-generated HTTPS endpoints are viable without DNS after these gates.
