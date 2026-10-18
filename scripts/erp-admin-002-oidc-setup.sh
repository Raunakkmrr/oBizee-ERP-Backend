#!/usr/bin/env bash
# ERP-ADMIN-002 R3: one-time IAM preparation for the reviewed platform-only CI job.
# Run without arguments to inspect policies/commands locally. No AWS call in plan mode.
# The release orchestrator may run --apply using an authorized short-lived admin session.
# It creates no access keys and never calls a Lambda mutation.
set -euo pipefail

mode=${1:---plan}
if [[ "$mode" != --plan && "$mode" != --apply ]]; then
  printf 'Usage: bash scripts/erp-admin-002-oidc-setup.sh [--plan|--apply]\n' >&2
  exit 2
fi
task_dir=$(mktemp -d "${TMPDIR:-/tmp}/erp-platform-oidc.XXXXXX")
role_name=github-obizee-erp-platform-deploy
policy_name=UpdateOnlyObizeeErpPlatformCode

cat > "$task_dir/trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "arn:aws:iam::940482448572:oidc-provider/token.actions.githubusercontent.com"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {"StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:Raunakkmrr@48851091/oBizee-ERP-Backend@1328693208:ref:refs/heads/main"
    }}
  }]
}
JSON
cat > "$task_dir/permissions.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode"],
    "Resource": "arn:aws:lambda:ap-south-1:940482448572:function:obizee-erp-platform"
  }]
}
JSON

printf 'Policy files retained for review at %s\n' "$task_dir"
shasum -a 256 "$task_dir/trust.json" "$task_dir/permissions.json"
if [[ "$mode" == --plan ]]; then
  jq . "$task_dir/trust.json" "$task_dir/permissions.json"
  printf '\nAfter independent review, an authorized operator runs:\n'
  printf '  bash scripts/erp-admin-002-oidc-setup.sh --apply\n'
  printf 'Then push the reviewed runtime/workflow commit to main; no GitHub AWS secrets are needed.\n'
  exit 0
fi

# Wrong account, an existing provider, or an existing role aborts before replacement.
# Inspect an existing resource separately rather than silently broadening its trust.
test "$(aws sts get-caller-identity --query Account --output text)" = 940482448572
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com \
  --query OpenIDConnectProviderArn --output text
aws iam create-role --role-name "$role_name" --max-session-duration 3600 \
  --description 'GitHub main deployment of only obizee-erp-platform code' \
  --assume-role-policy-document "file://$task_dir/trust.json" \
  --query Role.Arn --output text
aws iam put-role-policy --role-name "$role_name" --policy-name "$policy_name" \
  --policy-document "file://$task_dir/permissions.json"
printf 'IAM preparation complete. Push the reviewed main commit to trigger CI/CD.\n'

# Release gates and rollback plan (operator actions, not executed by this script):
# 1. The orchestrator verified use_default=true and use_immutable_subject=true on
#    2026-10-18. Trust names owner ID 48851091, repo ID 1328693208, and only main.
#    Recheck before creation; do not substitute wildcard or environment trust.
# 2. Preserve the prior approved platform archive and its Lambda CodeSha256 before
#    the first rollout; the deployment role intentionally cannot download old code.
#    An authorized read-only recovery identity may use GetFunction to download the
#    signed Code.Location privately. Do not print that URL or function environment.
# 3. Protect main and require CI review/checks. Do not add environment: to the deploy
#    job without reviewing the resulting OIDC subject change.
# 4. After CI, compare the step summary's CodeSha256/LastModified with the retained
#    ZIP and AWS metadata. Verify /plans/bootstrap with the named admin session;
#    unauthenticated 401 is not route evidence because wildcard auth runs first.
#    Do not create a company, invitation or charge as a verification step.
# 5. Roll back through CI: review/revert only platform source to the previous approved
#    revision, retaining this workflow and frozen lockfile; push to main. The stable
#    ZIP metadata permits comparing the rebuilt archive with the retained target.
#    If it cannot reproduce the approved archive hash, stop and prepare a reviewed
#    main-branch rollback workflow selecting the retained artifact from its original
#    run (download-artifact run-id + github-token, actions:read), verify its SHA256,
#    and pass that exact ZIP to the same restricted deploy job. Do not bypass CI with
#    a direct Lambda update or broaden IAM to change configuration/aliases.
# 6. Disabling this workflow stops future releases but does not restore deployed code.
#    Keep previous archives outside Actions retention limits if longer recovery is needed.
# Sources:
# https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws
# https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateOpenIDConnectProvider.html
# https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionCode.html
# https://docs.aws.amazon.com/cli/latest/reference/lambda/wait/function-updated.html
