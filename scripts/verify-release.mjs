#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRelease } from "./lib/release-validation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const packagePaths = [
  "package.json",
  "packages/api/package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/shared/package.json",
];

const packages = packagePaths.map((path) => {
  const pkg = readJson(path);
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
  launcherManifest: readJson("docker/launcher/manifest.json"),
  changelog: readFileSync(join(root, "CHANGELOG.md"), "utf8"),
});

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Release metadata is consistent for v${packages[0].version}`);
