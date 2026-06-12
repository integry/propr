#!/usr/bin/env node
// Bundle the shared, dependency-free assets into the CLI package so it works as
// a standalone global install (no source tree present at runtime):
//
//   docker/launcher/orchestrator.mjs  → src/orchestrator/ + dist/orchestrator/
//   docker/launcher/manifest.json     → src/orchestrator/ + dist/orchestrator/
//   .env.example                      → src/assets/ + dist/assets/
//
// orchestrator.mjs sits next to its manifest.json so the orchestrator's default
// `resolve(__dirname, 'manifest.json')` resolves correctly. The src/ copies let
// `tsx` (dev) resolve them too; the dist/ copies serve the built CLI.
//
// docker/launcher/manifest.json remains the single source of truth (written by
// scripts/build-images.sh); these copies are derived at CLI-build time.

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, "..");
const repoRoot = resolve(cliDir, "..", "..");

const launcherDir = join(repoRoot, "docker", "launcher");

const assets = [
  {
    src: join(launcherDir, "orchestrator.mjs"),
    dests: [
      join(cliDir, "src", "orchestrator", "orchestrator.mjs"),
      join(cliDir, "dist", "orchestrator", "orchestrator.mjs"),
    ],
  },
  {
    src: join(launcherDir, "manifest.json"),
    dests: [
      join(cliDir, "src", "orchestrator", "manifest.json"),
      join(cliDir, "dist", "orchestrator", "manifest.json"),
    ],
  },
  {
    // Renamed to avoid npm's default exclusion of .env* files from tarballs.
    src: join(repoRoot, ".env.example"),
    dests: [
      join(cliDir, "src", "assets", "env.example.txt"),
      join(cliDir, "dist", "assets", "env.example.txt"),
    ],
  },
];

const isPack = process.env.npm_lifecycle_event === "prepack";
let copied = 0;
const missing = [];
for (const asset of assets) {
  if (!existsSync(asset.src)) {
    missing.push(asset.src);
    console.warn(`copy-assets: source not found, skipping: ${asset.src}`);
    continue;
  }
  for (const dest of asset.dests) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(asset.src, dest);
    copied += 1;
  }
}

if (isPack && missing.length > 0) {
  console.error(`copy-assets: aborting pack — ${missing.length} required source(s) missing:`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

console.log(`copy-assets: copied ${copied} file(s) into the CLI package.`);
