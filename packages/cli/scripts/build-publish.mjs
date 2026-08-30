#!/usr/bin/env node
// Build a standalone, publishable npm package for the CLI.
//
// The in-repo package is the scoped workspace package `@propr/cli`, which depends
// on the workspace packages `@propr/shared` and `@propr/local-setup`. These scoped
// packages are not published to npm, so we ship the CLI under the unscoped public
// name `propr-cli` with both packages vendored into `dist/vendor/` and their imports
// rewritten to relative paths. The result has no scoped dependencies and installs
// cleanly from the public registry.
//
// Usage:
//   node scripts/build-publish.mjs            # build the staging package + npm pack --dry-run
//   node scripts/build-publish.mjs --publish  # ...then `npm publish --access public`
//
// Pass an npm 2FA code through with: PROPR_NPM_OTP=123456 node scripts/build-publish.mjs --publish
//
// The staging package is written to <repoRoot>/dist-publish/propr-cli.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
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
const localSetupDir = join(repoRoot, "packages", "local-setup");
const stageDir = join(repoRoot, "dist-publish", "propr-cli");
const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2024.12.2";
const WINDOWS_AUTHORITY_MANIFEST_PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABGK5YqTyhB9t0ItFKrMe9jiZ1two1naR/H1jqb6lRYU=
-----END PUBLIC KEY-----`);

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const run = (cmd, cmdArgs, cwd = repoRoot) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit" });

const readGitSha = () => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "nogit";
  }
};

const buildLauncherManifest = (version) => {
  const registry = process.env.MANIFEST_NS || process.env.DOCKERHUB_NS || "propr";
  const imagePrefix = process.env.MANIFEST_PREFIX || "";
  const image = (name) => `${registry}/${imagePrefix}${name}:${version}`;

  return {
    version,
    git_sha: readGitSha(),
    registry,
    images: {
      app: image("app"),
      ui: image("ui"),
      docs: image("docs"),
      agent: image("agent"),
      redis: "redis:7-alpine",
      cloudflared: CLOUDFLARED_IMAGE,
    },
  };
};

// 1. Build the workspace packages we depend on.
run("npm", ["run", "build", "-w", "@propr/shared"]);
run("npm", ["run", "build", "-w", "@propr/local-setup"]);
run("npm", ["run", "build", "-w", "@propr/cli"]);

// 2. Stage the CLI dist + README.
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(join(cliDir, "dist"), join(stageDir, "dist"), { recursive: true });
cpSync(join(cliDir, "README.md"), join(stageDir, "README.md"));
for (const requiredSkillFile of ["SKILL.md", join("agents", "openai.yaml")]) {
  const bundled = join(stageDir, "dist", "skill", "propr", requiredSkillFile);
  if (!existsSync(bundled)) throw new Error(`Bundled ProPR Agent Skill file is missing: ${bundled}`);
}
const nativeArtifacts = {
  "darwin-arm64": "88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615",
  "darwin-x64": "62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53",
  "linux-arm64": "29b28b76ed8781f2567897ad9ba576798bbb669937048218e0416601788e0f1c",
  "linux-x64": "7199378f1c7b443a05c596eae7c66f9a77cc01b4a493c07748df0df1083950f6",
};
for (const [platformArch, expected] of Object.entries(nativeArtifacts)) {
  const artifact = join(stageDir, "dist", "native", "prebuilds", platformArch, "directory-operations.node");
  if (!existsSync(artifact)) throw new Error(`Native directory-operations artifact is missing: ${artifact}`);
  const actual = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (actual !== expected) throw new Error(`${platformArch} directory-operations artifact failed integrity verification`);
}
const authorityArtifacts = {
  "darwin-arm64/connect-authority-broker": "75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0",
  "darwin-x64/connect-authority-broker": "e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b",
};
for (const [relativeArtifact, expected] of Object.entries(authorityArtifacts)) {
  const artifact = join(stageDir, "dist", "native", "prebuilds", relativeArtifact);
  if (!existsSync(artifact)) throw new Error(`Native authority broker is missing: ${artifact}`);
  const actual = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (actual !== expected) throw new Error(`${relativeArtifact} failed integrity verification`);
}
const windowsSupervisorDirectory = join(stageDir, "dist", "native", "prebuilds", "win32-anycpu");
const windowsSupervisor = join(windowsSupervisorDirectory, "connect-authority-supervisor.exe");
const windowsSupervisorManifest = join(windowsSupervisorDirectory, "connect-authority-supervisor.manifest.json");
const windowsSupervisorSignature = join(windowsSupervisorDirectory, "connect-authority-supervisor.manifest.sig");
for (const artifact of [windowsSupervisor, windowsSupervisorManifest, windowsSupervisorSignature]) {
  if (!existsSync(artifact)) throw new Error(`Prebuilt Windows authority helper artifact is missing: ${artifact}`);
}
const supervisorManifestBytes = readFileSync(windowsSupervisorManifest);
const supervisorManifest = JSON.parse(supervisorManifestBytes.toString("utf8"));
if (supervisorManifestBytes.at(-1) !== 0x0a
  || `${canonicalJson(supervisorManifest)}\n` !== supervisorManifestBytes.toString("utf8")
  || supervisorManifest.format !== "propr-windows-authority-helper-v2"
  || supervisorManifest.protocolVersion !== 2
  || supervisorManifest.pe?.architecture !== "anycpu"
  || supervisorManifest.pe?.managed !== true
  || supervisorManifest.pe?.deterministic !== true
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.sourceSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.launcherSourceSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.helperSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.launcherSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.build?.compilerSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.build?.launcherCompilerSha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(supervisorManifest.build?.launcherLinkerSha256 ?? "")
  || !Array.isArray(supervisorManifest.build?.nativeInputs)
  || supervisorManifest.build.nativeInputs.length !== 7
  || !supervisorManifest.build.nativeInputs.every((input) => input
    && typeof input.name === "string"
    && /^[0-9a-f]{64}$/.test(input.sha256 ?? "")
    && Number.isInteger(input.files) && input.files > 0
    && /^(?:0|[1-9]\d{0,12})$/.test(String(input.bytes)))
  || createHash("sha256").update(readFileSync(join(stageDir, "dist", "native", "windows-authority-supervisor.cs"))).digest("hex") !== supervisorManifest.sourceSha256
  || createHash("sha256").update(readFileSync(join(stageDir, "dist", "native", "windows-authority-broker.c"))).digest("hex") !== supervisorManifest.launcherSourceSha256
  || createHash("sha256").update(readFileSync(windowsSupervisor)).digest("hex") !== supervisorManifest.helperSha256) {
  throw new Error("Prebuilt Windows authority helper manifest failed integrity verification");
}
const windowsLauncher = join(stageDir, "dist", "native", "prebuilds", "win32-x64", "connect-authority-broker.exe");
if (!existsSync(windowsLauncher)
  || createHash("sha256").update(readFileSync(windowsLauncher)).digest("hex") !== supervisorManifest.launcherSha256) {
  throw new Error("Prebuilt Windows authority launcher failed integrity verification");
}
if (supervisorManifest.trust?.mode !== "production-signed"
  && !(supervisorManifest.trust?.mode === "unsigned-validation"
    && process.env.PROPR_WINDOWS_AUTHORITY_PACKAGE_VALIDATION === "1")) {
  throw new Error("Unsigned Windows authority helper cannot enter a production npm artifact");
}
if (supervisorManifest.trust?.mode === "production-signed"
  && (!/^[0-9a-f]{64}$/.test(supervisorManifest.trust.authenticodeLeafSha256 ?? "")
    || !/^[0-9a-f]{64}$/.test(supervisorManifest.trust.authenticodeSpkiSha256 ?? ""))) {
  throw new Error("Production Windows authority helper signing pins are missing");
}
const supervisorSignatureText = readFileSync(windowsSupervisorSignature, "ascii");
if (supervisorManifest.trust?.mode === "production-signed"
  && (supervisorSignatureText.at(-1) !== "\n"
    || !/^[A-Za-z0-9+/]{86}==\n$/.test(supervisorSignatureText)
    || !verify(null, supervisorManifestBytes, WINDOWS_AUTHORITY_MANIFEST_PUBLIC_KEY,
      Buffer.from(supervisorSignatureText.trimEnd(), "base64")))) {
  throw new Error("Production Windows authority manifest signature is invalid");
}
if (supervisorManifest.trust?.mode === "unsigned-validation"
  && (supervisorManifest.trust.authenticodeLeafSha256 !== null
    || supervisorManifest.trust.authenticodeSpkiSha256 !== null
    || supervisorSignatureText !== "UNSIGNED-VALIDATION\n")) {
  throw new Error("Unsigned Windows authority validation metadata contains signer claims");
}
const expectedSupervisorFiles = [
  "connect-authority-supervisor.exe",
  "connect-authority-supervisor.manifest.json",
  "connect-authority-supervisor.manifest.sig",
];
if (readdirSync(windowsSupervisorDirectory).sort().join("\0") !== expectedSupervisorFiles.sort().join("\0")) {
  throw new Error("Windows authority helper target contains an unexpected artifact");
}
for (const auditedFile of [
  "directory-operations.c",
  "darwin-authority-broker.c",
  "windows-authority-broker.c",
  "windows-authority-supervisor.cs",
  "README.md",
]) {
  const bundled = join(stageDir, "dist", "native", auditedFile);
  if (!existsSync(bundled)) throw new Error(`Audited native helper file is missing: ${bundled}`);
}

// 3. Vendor the compiled workspace packages into dist/vendor.
const vendorRoot = join(stageDir, "dist", "vendor");
const vendorPackages = [
  { source: sharedDir, destination: join(vendorRoot, "shared") },
  { source: localSetupDir, destination: join(vendorRoot, "local-setup") },
];
for (const { source, destination } of vendorPackages) {
  mkdirSync(destination, { recursive: true });
  for (const file of readdirSync(join(source, "dist"))) {
    if (file.endsWith(".js")) {
      cpSync(join(source, "dist", file), join(destination, file));
    }
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

// 5. Rewrite private workspace imports to their vendored relative paths.
const vendoredImports = new Map([
  ["@propr/shared", join(vendorRoot, "shared", "index.js")],
  ["@propr/local-setup", join(vendorRoot, "local-setup", "index.js")],
]);
const rewriteVendoredImports = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteVendoredImports(full);
    } else if (entry.name.endsWith(".js")) {
      let src = readFileSync(full, "utf8");
      for (const [specifier, target] of vendoredImports) {
        if (!src.includes(`"${specifier}"`)) continue;
        let vendorPath = relative(dirname(full), target).split(sep).join("/");
        if (!vendorPath.startsWith(".")) vendorPath = `./${vendorPath}`;
        src = src.replaceAll(`"${specifier}"`, `"${vendorPath}"`);
      }
      writeFileSync(full, src);
    }
  }
};
rewriteVendoredImports(join(stageDir, "dist"));

// 6. Write the unscoped package.json (no scoped deps, no build scripts).
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
// copy-assets copies docker/launcher/manifest.json into dist during the CLI
// workspace build. That checked-in manifest is refreshed by image releases, but
// npm publishing must not depend on an image build having just dirtied the
// worktree. Regenerate the staged package manifest from the current commit so
// `npm run cli:publish` always ships a launcher manifest that matches the
// commit being published.
writeFileSync(
  join(stageDir, "dist", "orchestrator", "manifest.json"),
  JSON.stringify(buildLauncherManifest(cliPkg.version), null, 2) + "\n"
);

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
  repository: rootPkg.repository,
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
