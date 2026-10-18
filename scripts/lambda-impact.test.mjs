import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { classify, importClosure, gitReader, ENTRIES, SHARED_INPUTS, GATE_OUTPUTS, GATE_STEP, CHECKOUT_DEPTH } from "./lambda-impact.mjs";

const files = {
  "src/platform-lambda.ts": 'import "./routes/platform.ts";',
  "src/routes/platform.ts": 'import "../db/shared.ts";',
  "src/tenant-lambda.ts": 'import "./tenant/app.ts";',
  "src/tenant/app.ts": 'import "../db/shared.ts";',
  "src/db/shared.ts": "export const schema = 1;",
};
const reader = map => file => map[file] ?? null;
function impact(changed,before=files,after=before) { return classify({changed,before:reader(before),after:reader(after)}); }
function only(result,platform,tenant) { assert.equal(result.platform,platform); assert.equal(result.tenant,tenant); }

test("exact source closures distinguish tenant, platform and shared dependencies", () => {
  only(impact(["src/tenant/app.ts"]),false,true);
  only(impact(["src/routes/platform.ts"]),true,false);
  only(impact(["src/db/shared.ts"]),true,true);
  only(impact(["docs/guide.md","src/tenant/new.test.ts","drizzle/1000_later.sql"]),false,false);
});
test("every shared package/build input and pnpm patch affects BOTH runtimes", () => {
  for (const file of [...SHARED_INPUTS,"patches/provider.patch"]) only(impact([file]),true,true);
});
test("deployment inputs remain target-specific", () => {
  only(impact(["scripts/erp-admin-002-oidc-setup.sh"]),true,false);
  only(impact(["deploy/erp-runtime-004-tenant-stack.json"]),false,true);
});
test("before/after union catches removed, newly imported and renamed dependencies", () => {
  const after = {...files,"src/tenant/app.ts":'import "./new.ts";',"src/tenant/new.ts":"export const x = 1;"};
  only(impact(["src/tenant/new.ts"],files,after),false,true);
  only(impact(["src/tenant/app.ts","src/db/shared.ts"],files,after),true,true);
  const removed = {...files,"src/routes/platform.ts":"export {};"};
  only(impact(["src/db/shared.ts"],files,removed),true,true);
  const renamed = {...files,"src/platform-lambda.ts":'import "./routes/renamed.ts";',
    "src/routes/renamed.ts":files["src/routes/platform.ts"]};
  delete renamed["src/routes/platform.ts"];
  only(impact(["src/routes/platform.ts","src/routes/renamed.ts"],files,renamed),true,false);
});
test("unresolvable or nonliteral runtime import aborts; never defaults to skip", () => {
  assert.throws(() => importClosure("src/tenant/app.ts",reader({...files,"src/tenant/app.ts":'import("./missing.ts")'})));
  assert.throws(() => importClosure("src/tenant/app.ts",reader({...files,"src/tenant/app.ts":'import(process.env.PATH)'})));
});
test("only the exact reviewed gate bootstrap is neutral; later classifier changes affect both", () => {
  only(impact(["scripts/lambda-impact.mjs"],files,{...files,"scripts/lambda-impact.mjs":"new"}),false,false);
  only(impact(["scripts/lambda-impact.mjs"],{...files,"scripts/lambda-impact.mjs":"old"},{...files,"scripts/lambda-impact.mjs":"new"}),true,true);
});
const ci = readFileSync(".github/workflows/ci.yml","utf8");
const oldCi = ci.replace(GATE_OUTPUTS+"\n","").replace(GATE_STEP+"\n","").replace(CHECKOUT_DEPTH,"")
  .replace(" && needs.check.outputs.platform == 'true'","").replace(" && needs.check.outputs.tenant == 'true'","");
function workflowImpact(old,next) {
  return impact([".github/workflows/ci.yml"],{...files,".github/workflows/ci.yml":old},{...files,".github/workflows/ci.yml":next});
}
test("workflow gate introduction alone cannot deploy either unchanged runtime", () => only(workflowImpact(oldCi,ci),false,false));
test("shared build/pin/env changes affect both; deploy steps affect their exact target", () => {
  only(workflowImpact(ci,ci.replace("pnpm run build:lambda","pnpm run build:lambda --changed")),true,true);
  only(workflowImpact(ci,ci.replace("node-version-file: .nvmrc","node-version: 24")),true,true);
  only(workflowImpact(ci,ci.replace("PLATFORM_FUNCTION_ARN: arn:","PLATFORM_FUNCTION_ARN: changed:")),true,false);
  only(workflowImpact(ci,ci.replace("TENANT_FUNCTION_ARN: arn:","TENANT_FUNCTION_ARN: changed:")),false,true);
});
test("unexpected workflow/gate layouts abort classification", () => {
  assert.throws(() => workflowImpact(ci,ci.replace("id: impact","id: impact_changed")));
  assert.throws(() => workflowImpact(ci,ci+"\n  surprise:\n    runs-on: ubuntu-latest\n"));
});
test("workflow outputs guard both deploys without modifying write-gate protections", () => {
  for (const target of ["platform","tenant"]) {
    assert.ok(ci.includes("&& needs.check.outputs."+target+" == 'true'"));
    const job = ci.split("  deploy-"+target+":")[1].split(/\n  [a-z].*:/)[0];
    assert.ok(job.includes("--revision-id"));
    assert.ok(job.includes('test "$latest" = "$GITHUB_SHA"'));
    assert.ok(job.includes('test "$latest_after" != "$GITHUB_SHA"'));
    assert.ok(job.includes(".CodeSha256 == $expected"));
    assert.ok(job.includes("id-token: write"));
    assert.ok(job.includes("allowed-account-ids: \"940482448572\""));
  }
  for (const match of ci.matchAll(/uses: [^\s]+@([^\s]+)/g)) assert.match(match[1],/^[a-f0-9]{40}$/);
});
test("source impact sets include EVERY local input esbuild actually bundles", async () => {
  for (const [target,entry] of Object.entries(ENTRIES)) {
    const closure = new Set(importClosure(entry,gitReader("WORKTREE")));
    const bundle = await build({entryPoints:[entry],bundle:true,platform:"node",target:"node22",format:"esm",
      write:false,metafile:true,outfile:"dist/impact-proof-"+target+".mjs",logLevel:"silent"});
    const inputs = Object.keys(bundle.metafile.inputs).filter(file => file.startsWith("src/"));
    for (const input of inputs) assert.ok(closure.has(input),target+" missed "+input);
  }
});
