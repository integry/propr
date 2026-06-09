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
    src: join(repoRoot, ".env.example"),
    dests: [
      join(cliDir, "src", "assets", ".env.example"),
      join(cliDir, "dist", "assets", ".env.example"),
    ],
  },
];

let copied = 0;
for (const asset of assets) {
  if (!existsSync(asset.src)) {
    console.warn(`copy-assets: source not found, skipping: ${asset.src}`);
    continue;
  }
  for (const dest of asset.dests) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(asset.src, dest);
    copied += 1;
  }
}

console.log(`copy-assets: copied ${copied} file(s) into the CLI package.`);
