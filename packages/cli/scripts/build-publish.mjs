#!/usr/bin/env node
// Build a standalone, publishable npm package for the CLI.
//
// The in-repo package is the scoped workspace package `@propr/cli`, which depends
// on the workspace package `@propr/shared`. Neither scoped package is published to
// npm, so we ship the CLI under the unscoped public name `propr-cli` with
// `@propr/shared` *vendored* into `dist/vendor/shared/` (it is dependency-free) and
// the two `@propr/shared` imports rewritten to a relative path. The result has no
// scoped dependencies and installs cleanly from the public registry.
//
// Usage:
//   node scripts/build-publish.mjs            # build the staging package + npm pack --dry-run
//   node scripts/build-publish.mjs --publish  # ...then `npm publish --access public`
//
// Pass an npm 2FA code through with: PROPR_NPM_OTP=123456 node scripts/build-publish.mjs --publish
//
// The staging package is written to <repoRoot>/dist-publish/propr-cli.

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const repoRoot = resolve(cliDir, "..", "..");
const sharedDir = join(repoRoot, "packages", "shared");
const stageDir = join(repoRoot, "dist-publish", "propr-cli");

const run = (cmd, cmdArgs, cwd = repoRoot) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });

// 1. Build the workspace packages we depend on.
run("npm", ["run", "build", "-w", "@propr/shared"]);
run("npm", ["run", "build", "-w", "@propr/cli"]);

// 2. Stage the CLI dist + README.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(join(cliDir, "dist"), join(stageDir, "dist"), { recursive: true });
cpSync(join(cliDir, "README.md"), join(stageDir, "README.md"));

// 3. Vendor shared's compiled JS (dependency-free) into dist/vendor/shared.
const vendorDir = join(stageDir, "dist", "vendor", "shared");
mkdirSync(vendorDir, { recursive: true });
for (const file of readdirSync(join(sharedDir, "dist"))) {
  if (file.endsWith(".js")) {
    cpSync(join(sharedDir, "dist", file), join(vendorDir, file));
  }
}

// 4. Strip .d.ts / source maps — this is a CLI binary, not a library.
const stripMaps = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) stripMaps(full);
    else if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".map")) unlinkSync(full);
  }
};
stripMaps(join(stageDir, "dist"));

// 5. Rewrite the `@propr/shared` import specifier to the vendored relative path.
const rewriteSharedImports = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteSharedImports(full);
    } else if (entry.name.endsWith(".js")) {
      const src = readFileSync(full, "utf8");
      if (src.includes('"@propr/shared"')) {
        let sharedPath = relative(dirname(full), join(vendorDir, "index.js")).split(sep).join("/");
        if (!sharedPath.startsWith(".")) sharedPath = `./${sharedPath}`;
        writeFileSync(full, src.replaceAll('"@propr/shared"', `"${sharedPath}"`));
      }
    }
  }
};
rewriteSharedImports(join(stageDir, "dist"));

// 6. Write the unscoped package.json (no scoped deps, no build scripts).
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const stagePkg = {
  name: "propr-cli",
  version: cliPkg.version,
  description: cliPkg.description,
  type: cliPkg.type,
  bin: cliPkg.bin,
  main: cliPkg.main,
  files: ["dist"],
  engines: cliPkg.engines,
  dependencies: {
    commander: cliPkg.dependencies.commander,
    dotenv: cliPkg.dependencies.dotenv,
    ink: cliPkg.dependencies.ink,
    react: cliPkg.dependencies.react,
  },
  keywords: ["propr", "cli", "github", "ai", "code-review", "automation"],
  license: rootPkg.license || "ISC",
};
writeFileSync(join(stageDir, "package.json"), JSON.stringify(stagePkg, null, 2) + "\n");

// 7. Sanity check: no scoped imports may survive in the shipped JS.
const grepScoped = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) grepScoped(full);
    else if (entry.name.endsWith(".js")) {
      // Only flag real import/export statements (line starts with the keyword),
      // not `@propr/*` mentions inside JSDoc comments.
      const offending = readFileSync(full, "utf8")
        .split("\n")
        .find((line) => /^\s*(import|export)\b[^/]*\bfrom\s+["']@propr\//.test(line));
      if (offending) throw new Error(`Unresolved scoped import in ${full}: ${offending.trim()}`);
    }
  }
};
grepScoped(join(stageDir, "dist"));

console.log(`\nStaged propr-cli@${stagePkg.version} at ${stageDir}`);

// 8. Pack (dry-run) or publish.
const publish = process.argv.includes("--publish");
if (publish) {
  const otp = process.env.PROPR_NPM_OTP;
  run("npm", ["publish", "--access", "public", ...(otp ? [`--otp=${otp}`] : [])], stageDir);
} else {
  run("npm", ["pack", "--dry-run"], stageDir);
  console.log("\nDry run only. Re-run with --publish to publish to npm.");
}
