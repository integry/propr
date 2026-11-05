#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function collectDocIds(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const ids = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      ids.push(...await collectDocIds(path, root));
    } else if (entry.isFile() && ['.md', '.mdx'].includes(extname(entry.name).toLowerCase())) {
      ids.push(relative(root, path).split(sep).join('/').replace(/\.mdx?$/i, ''));
    }
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

/**
 * Treat sidebars.ts as text rather than executable code. Every quoted literal
 * that exactly matches a discovered page id is an ordering entry; all other
 * TypeScript strings (labels, types and imports) are ignored.
 */
export function sidebarOrder(source, docIds) {
  const known = new Set(docIds);
  const seen = new Set();
  const ordered = [];
  // Sidebar ids are intentionally plain, single-line strings. Refuse complex
  // escaped literals rather than trying to implement a TypeScript parser.
  const stringLiteral = /(['"])([^'"\\\r\n]*)\1/g;
  for (const match of source.matchAll(stringLiteral)) {
    const value = match[2];
    if (known.has(value) && !seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  }
  return [...ordered, ...docIds.filter(id => !seen.has(id))];
}

async function gitRevision(root) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function buildDocsManifest({
  root = repositoryRoot,
  env = process.env,
  now = new Date(),
  resolveRevision = gitRevision,
} = {}) {
  const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const docIds = await collectDocIds(resolve(root, 'docs', 'docs'));
  let order = docIds;
  try {
    order = sidebarOrder(await readFile(resolve(root, 'docs', 'sidebars.ts'), 'utf8'), docIds);
  } catch {
    // A missing or unreadable sidebar has a deterministic alphabetical fallback.
  }
  const environmentRevision = env.GIT_SHA?.trim();
  const sourceRevision = environmentRevision || await resolveRevision(root);
  const manifest = {
    schemaVersion: 1,
    version: packageInfo.version,
    sourceRevision: sourceRevision || null,
    generatedAt: now.toISOString(),
    order,
    pageCount: docIds.length,
  };
  await writeFile(resolve(root, 'docs', 'docs-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const manifest = await buildDocsManifest();
  console.log(`Wrote docs/docs-manifest.json with ${manifest.pageCount} pages for ${manifest.version}.`);
}
