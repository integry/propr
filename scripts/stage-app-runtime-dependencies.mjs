#!/usr/bin/env node
// Stages the production dependencies that npm keeps nested inside workspace
// packages (packages/<name>/node_modules) for the app runtime image.
//
// npm hoists most dependencies to the root node_modules, but a workspace whose
// declared range conflicts with the root tree keeps its own copy, for example
// packages/core/node_modules/sharp. The runtime stage of
// docker/Dockerfile.app.prod copies the root node_modules plus workspace
// manifests and build output only, so nested copies must be carried over
// explicitly or Node fails with ERR_MODULE_NOT_FOUND.
//
// Workspace code runs from two places in the image:
//   packages/<name>/dist      — the workspace's own build (@propr/<name>)
//   dist/packages/<name>      — the root tsc build, used through relative
//                               imports and by the API server entrypoint
// The nested tree is copied once to packages/<name>/node_modules, and
// dist/packages/<name>/node_modules is a relative symlink to it so both
// locations resolve the same pruned closure without duplicating native files.
//
// Run after `npm prune --omit=dev`. The package-lock is the source of truth:
// every nested non-dev, non-optional package of a shipped workspace must be
// present, and nothing staged may be a dev-only or unknown package.
//
// Usage:
//   node scripts/stage-app-runtime-dependencies.mjs --root <dir> --out <dir> <workspace>...

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function nestedLockEntries(lock, workspace) {
  const prefix = `packages/${workspace}/node_modules/`;
  const entries = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    // Only direct children of the workspace's node_modules; deeper nesting is
    // copied with its parent package.
    if (name.includes('/node_modules/')) continue;
    entries.push({ name, key, meta });
  }
  return entries;
}

export function requiredNestedPackages(lock, workspace) {
  return nestedLockEntries(lock, workspace)
    .filter(({ meta }) => !meta.dev && !meta.optional && !meta.devOptional)
    .map(({ name }) => name)
    .sort();
}

function installedPackageNames(nodeModulesDir) {
  const names = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
        if (!scoped.name.startsWith('.')) names.push(`${entry.name}/${scoped.name}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names.sort();
}

export function stageAppRuntimeDependencies({ root, out, workspaces, lock }) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error('at least one shipped workspace is required');
  }
  const lockfile = lock ?? JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  fs.mkdirSync(out, { recursive: true });

  const staged = [];
  for (const workspace of workspaces) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(workspace)) {
      throw new Error(`invalid workspace name: ${workspace}`);
    }
    const sourceDir = path.join(root, 'packages', workspace, 'node_modules');
    const required = requiredNestedPackages(lockfile, workspace);
    const lockEntries = new Map(nestedLockEntries(lockfile, workspace).map((entry) => [entry.name, entry.meta]));

    if (!fs.existsSync(sourceDir)) {
      if (required.length > 0) {
        throw new Error(
          `packages/${workspace}/node_modules is missing but package-lock.json requires: ${required.join(', ')}`
        );
      }
      staged.push({ workspace, packages: [] });
      continue;
    }

    const installed = installedPackageNames(sourceDir);
    const missing = required.filter((name) => !installed.includes(name));
    if (missing.length > 0) {
      throw new Error(`packages/${workspace}/node_modules is missing production packages: ${missing.join(', ')}`);
    }
    for (const name of installed) {
      const meta = lockEntries.get(name);
      if (!meta) {
        throw new Error(`packages/${workspace}/node_modules/${name} is not in package-lock.json`);
      }
      if (meta.dev) {
        throw new Error(`packages/${workspace}/node_modules/${name} is a development dependency; prune before staging`);
      }
    }
    if (installed.length === 0) {
      staged.push({ workspace, packages: [] });
      continue;
    }

    const targetDir = path.join(out, 'packages', workspace, 'node_modules');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });

    const rootBuildDir = path.join(root, 'dist', 'packages', workspace);
    if (fs.existsSync(rootBuildDir)) {
      const linkPath = path.join(out, 'dist', 'packages', workspace, 'node_modules');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(linkPath), targetDir), linkPath, 'dir');
    }
    staged.push({ workspace, packages: installed });
  }
  return staged;
}

function parseArgs(argv) {
  const options = { workspaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = path.resolve(value);
      i += 1;
    } else {
      options.workspaces.push(arg);
    }
  }
  if (!options.root || !options.out) throw new Error('--root and --out are required');
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = stageAppRuntimeDependencies(parseArgs(process.argv.slice(2)));
    for (const { workspace, packages } of result) {
      console.log(`packages/${workspace}: ${packages.length ? packages.join(', ') : '(no nested production dependencies)'}`);
    }
  } catch (error) {
    console.error(`stage-app-runtime-dependencies: ${error.message}`);
    process.exit(1);
  }
}
