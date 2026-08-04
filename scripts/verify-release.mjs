#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRelease } from "./lib/release-validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const rootPackage = readJson("package.json");

function expandWorkspacePattern(pattern) {
  if (!pattern.endsWith("/*")) {
    const manifest = join(pattern, "package.json");
    return existsSync(join(root, manifest)) ? [manifest] : [];
  }
  const parent = pattern.slice(0, -2);
  const parentPath = join(root, parent);
  if (!existsSync(parentPath)) return [];
  return readdirSync(parentPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name, "package.json"))
    .filter((manifest) => existsSync(join(root, manifest)));
}

const workspacePatterns = Array.isArray(rootPackage.workspaces)
  ? rootPackage.workspaces
  : rootPackage.workspaces?.packages ?? [];
const excludedWorkspaces = new Set(rootPackage.proprRelease?.excludeWorkspaces ?? []);
const packagePaths = [
  "package.json",
  ...workspacePatterns.flatMap(expandWorkspacePattern).filter((path) => {
    const pkg = readJson(path);
    // Publishable @propr workspaces participate automatically. A deliberately
    // independently-versioned package must be explicitly excluded at the root.
    return pkg.name?.startsWith("@propr/")
      && pkg.private !== true
      && !excludedWorkspaces.has(path)
      && !excludedWorkspaces.has(pkg.name);
  }),
];

const packages = packagePaths.map((path) => {
  const pkg = path === "package.json" ? rootPackage : readJson(path);
  return {
    name: pkg.name,
    version: pkg.version,
    releaseVersioned: path !== "package.json",
    internalDependencies: Object.fromEntries(
      Object.entries({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      }).filter(([name]) => name.startsWith("@propr/")),
    ),
  };
});

const errors = validateRelease({
  tag: process.env.RELEASE_TAG?.trim(),
  expectedVersion: process.env.EXPECTED_VERSION?.trim(),
  releaseCandidate: process.env.RELEASE_CANDIDATE === "true",
  packages,
  externalInternalDependencies: rootPackage.proprRelease?.externalInternalDependencies ?? [],
  launcherManifest: readJson("docker/launcher/manifest.json"),
  changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
});

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release metadata is consistent for v${packages[0].version}`);
