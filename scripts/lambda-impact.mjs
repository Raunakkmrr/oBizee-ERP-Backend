import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Runtime impact is the UNION of each entrypoint's before/after local import
// closure, not a directory filter. Removing/moving a dependency cannot hide it.
export const ENTRIES = { platform: "src/platform-lambda.ts", tenant: "src/tenant-lambda.ts" };
export const SHARED_INPUTS = [".nvmrc", ".node-version", ".npmrc", ".pnpmfile.cjs",
  "pnpm-workspace.yaml", "package.json", "pnpm-lock.yaml", "tsconfig.json", "scripts/build-lambda.mjs"];
export const DEPLOY_INPUTS = {
  platform: ["scripts/erp-admin-002-oidc-setup.sh"],
  tenant: ["deploy/erp-runtime-004-tenant-stack.json"],
};
export const GATE_OUTPUTS = [
  "    outputs:",
  "      platform: ${{ steps.impact.outputs.platform }}",
  "      tenant: ${{ steps.impact.outputs.tenant }}",
  "",
].join("\n");
export const CHECKOUT_DEPTH = "        with:\n          fetch-depth: 0\n";
export const GATE_STEP = [
  "      - name: Determine reviewed Lambda deployment impact",
  "        id: impact",
  "        env:",
  "          PUSH_BEFORE: ${{ github.event.before }}",
  "          PUSH_AFTER: ${{ github.sha }}",
  "        run: |",
  "          set -euo pipefail",
  "          node --test scripts/lambda-impact.test.mjs",
  '          if test "$GITHUB_EVENT_NAME" = push; then',
  '            node scripts/lambda-impact.mjs "$PUSH_BEFORE" "$PUSH_AFTER"',
  "          fi",
  "",
].join("\n");
const GATE_FILE = "scripts/lambda-impact.mjs";
const CI_FILE = ".github/workflows/ci.yml";

export function importClosure(entry, read) {
  const found = new Set();
  function visit(file) {
    if (found.has(file)) return;
    const source = read(file);
    if (source === null) throw new Error("Unresolvable runtime input: " + file);
    found.add(file);
    if (!/\.[cm]?[jt]sx?$/.test(file)) return;
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function dependency(specifier) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return; // package -> lock/manifest
      const resolved = specifier.startsWith("@/") ? "src/" + specifier.slice(2) :
        path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) throw new Error("Input outside repository");
      const candidates = [resolved, ...[".ts",".mjs",".js",".json","/index.ts","/index.js"].map(ext => resolved+ext)];
      const next = candidates.find(candidate => read(candidate) !== null);
      if (!next) throw new Error("Unresolved import: " + file + " -> " + specifier);
      visit(next);
    }
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error("Nonliteral import");
        dependency(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const arg = node.arguments[0];
        if (!arg || !ts.isStringLiteralLike(arg)) throw new Error("Dynamic runtime dependency needs reviewed classifier support");
        dependency(arg.text);
      }
      ts.forEachChild(node,walk);
    }
    walk(ast);
  }
  visit(entry);
  return [...found].sort();
}

function splitWorkflow(source) {
  if (source === null) throw new Error("Missing CI workflow");
  const jobsAt = source.indexOf("\njobs:\n");
  if (jobsAt < 0) throw new Error("Unsupported CI layout");
  const body = source.slice(jobsAt+7);
  const matches = [...body.matchAll(/^  ([a-z][a-z0-9-]*):\s*$/gm)];
  if (matches.map(match => match[1]).join(",") !== "check,deploy-platform,deploy-tenant")
    throw new Error("Unexpected CI jobs require explicit deployment-impact review");
  return { header:source.slice(0,jobsAt), jobs:Object.fromEntries(matches.map((match,index) =>
    [match[1], body.slice(match.index,matches[index+1]?.index ?? body.length)])) };
}
function normalizeCheck(check) {
  // Allow ONLY the exact reviewed gate bootstrap, not arbitrary ignored YAML.
  if (check.includes("steps.impact.outputs.")) {
    if (!check.includes(GATE_OUTPUTS+"\n")) throw new Error("Unsupported gate outputs");
    check = check.replace(GATE_OUTPUTS+"\n","");
  }
  if (check.includes("id: impact")) {
    if (!check.includes(GATE_STEP+"\n")) throw new Error("Unsupported impact step");
    check = check.replace(GATE_STEP+"\n","");
  }
  return check.replace(CHECKOUT_DEPTH,"").trimEnd();
}
function normalizeDeploy(job, target) {
  return job.replace(" && needs.check.outputs." + target + " == 'true'","").trimEnd();
}
export function classify({ changed, before, after }) {
  const result = { platform:false, tenant:false, reasons:{platform:[],tenant:[]}, sets:{} };
  const hit = (target,file) => { result[target]=true; result.reasons[target].push(file); };
  for (const target of Object.keys(ENTRIES)) {
    const closure = [...new Set([...importClosure(ENTRIES[target],before),
      ...importClosure(ENTRIES[target],after)])].sort();
    result.sets[target] = closure;
    for (const file of changed) {
      if (closure.includes(file) || SHARED_INPUTS.includes(file) || file.startsWith("patches/") ||
          DEPLOY_INPUTS[target].includes(file) || (file === GATE_FILE && before(GATE_FILE) !== null)) hit(target,file);
    }
  }
  if (changed.includes(CI_FILE)) {
    const old = splitWorkflow(before(CI_FILE)), next = splitWorkflow(after(CI_FILE));
    if (old.header !== next.header || normalizeCheck(old.jobs.check) !== normalizeCheck(next.jobs.check)) {
      hit("platform",CI_FILE+":shared-check"); hit("tenant",CI_FILE+":shared-check");
    }
    for (const target of Object.keys(ENTRIES))
      if (normalizeDeploy(old.jobs["deploy-"+target],target) !== normalizeDeploy(next.jobs["deploy-"+target],target))
        hit(target,CI_FILE+":deploy-"+target);
  }
  return result;
}
function git(args) { return execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:20*1024*1024}); }
export function gitReader(revision) {
  return file => {
    if (revision === "WORKTREE") { try { return readFileSync(file,"utf8"); } catch { return null; } }
    try { return git(["show",revision+":"+file]); } catch { return null; }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base,head] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base) ||
      !/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("Explicit existing before/after commits required; refusing deployment");
  git(["cat-file","-e",base+"^{commit}"]); git(["cat-file","-e",head+"^{commit}"]);
  const changed = git(["diff","--name-only","--no-renames","-z",base,head]).split("\0").filter(Boolean);
  const impact = classify({changed,before:gitReader(base),after:gitReader(head)});
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing workflow output file");
  appendFileSync(process.env.GITHUB_OUTPUT,"platform="+impact.platform+"\ntenant="+impact.tenant+"\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### Checked Lambda impact\n\nBase: `"+base+"`\nHead: `"+head+"`\n\n```json\n"+JSON.stringify({changed,...impact},null,2)+"\n```\n");
  console.log(JSON.stringify({changed,...impact},null,2));
}
