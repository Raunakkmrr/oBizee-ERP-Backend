/**
 * Bundle the API into one file for Lambda.
 *
 *   npm run build:lambda   →  dist/lambda/index.mjs
 *
 * **Why a build at all, when the app runs from `.ts` locally.** Development
 * uses `--experimental-strip-types`, which needs the flag on Node 22.6–22.17
 * and is on by default only from 22.18. Lambda's `nodejs22.x` runtime patch
 * version is AWS's to change, not ours, and a deploy that stops booting because
 * the runtime moved underneath it is not a failure anybody wants to debug at
 * the time it happens. Types are stripped here instead, once, where the version
 * is pinned.
 *
 * Bundled rather than shipped with `node_modules`: nothing in the dependency
 * tree is native — Neon speaks HTTP, `jose` uses WebCrypto — so one file is
 * possible, and one file is a smaller artefact and a shorter cold start than a
 * directory of thousands.
 *
 * `aws-sdk` is not bundled because nothing imports it. If secret fetching moves
 * into the function, add `@aws-sdk/*` to `external` — the runtime provides it,
 * and bundling a copy would add megabytes to no purpose.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";

import * as esbuild from "esbuild";

const OUT = "dist/lambda";

await rm(OUT, { recursive: true, force: true });

const result = await esbuild.build({
  entryPoints: ["src/lambda.ts"],
  outfile: `${OUT}/index.mjs`,
  bundle: true,
  platform: "node",
  /*
    Matches the runtime this is deployed to. Lower and esbuild down-levels
    syntax the runtime already has; higher and it emits syntax the runtime does
    not, which fails at import time rather than at build time.
  */
  target: "node22",
  format: "esm",
  /*
    `.ts` import specifiers, which `rewriteRelativeImportExtensions` handles for
    the type-checker and esbuild needs told about separately.
  */
  resolveExtensions: [".ts", ".mjs", ".js", ".json"],
  minify: true,
  // Kept, and worth the bytes: a stack trace from a minified bundle with no map
  // names a column in a single 900 KB line.
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  banner: {
    /*
      Some transitive dependency still reaches for `require` or `__dirname` in a
      branch it never takes; an ESM bundle has neither and fails at import.
      Shimmed rather than switching the bundle to CJS, which would cost
      top-level await — used by `db/migrate.ts` and the seeds.
    */
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
});

/*
  Without this the runtime reads the bundle as CommonJS and fails on the first
  `import` — a deploy that builds cleanly and dies at cold start. Written rather
  than documented, because a step in a README is a step somebody skips.
*/
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/package.json`, JSON.stringify({ type: "module" }, null, 2) + "\n");

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`\n${OUT}/index.mjs — ${(bytes / 1024).toFixed(0)} KB including the source map`);

/*
  Named because it is silent when it is wrong: `handler` is what the function's
  Handler setting points at, and a mismatch is a 502 with nothing in the log.
*/
console.log("\nDeploy with:");
console.log("  Handler: index.handler");
console.log("  Runtime: nodejs22.x   Memory: 512 MB or more (scrypt scales with CPU)");
