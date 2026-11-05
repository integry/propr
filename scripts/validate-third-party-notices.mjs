#!/usr/bin/env node

// Fail-closed checks for THIRD_PARTY_LICENSES.md, which every Docker image
// bakes. scripts/generate-notices.sh reads full license text from the installed
// root node_modules and inventories it with license-checker; on a clean
// checkout without `npm ci` both silently degrade (the bundled Anthropic
// sections vanish and the inventory collapses to the root package alone).
//
// Usage:
//   node scripts/validate-third-party-notices.mjs installed
//   node scripts/validate-third-party-notices.mjs file <path>

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Packages whose full license text generate-notices.sh embeds verbatim.
export const FULL_TEXT_NOTICES = [
  { name: '@anthropic-ai/claude-code', license: 'LICENSE.md' },
  { name: '@anthropic-ai/sdk', license: 'LICENSE' },
];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Direct production dependencies at the exact versions pinned by package-lock.
export function pinnedProductionDependencies(root = repositoryRoot) {
  const manifest = readJson(join(root, 'package.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  return Object.keys(manifest.dependencies ?? {}).sort().map(name => {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) throw new Error(`package-lock.json has no entry for production dependency ${name}`);
    const workspace = entry.link ? lock.packages?.[entry.resolved] : undefined;
    const version = entry.link ? workspace?.version : entry.version;
    if (!version) throw new Error(`package-lock.json has no pinned version for production dependency ${name}`);
    return { name, version, workspace: Boolean(entry.link) };
  });
}

const pinnedVersion = (dependencies, name) => {
  const found = dependencies.find(dependency => dependency.name === name);
  if (!found) throw new Error(`${name} is not a pinned root production dependency`);
  return found.version;
};

// Proves the root dependency tree was installed from the lockfile before any
// notice is generated, so a clean checkout fails instead of baking a stub.
export function validateInstalledNoticeSources(root = repositoryRoot) {
  const dependencies = pinnedProductionDependencies(root);
  const problems = [];
  for (const { name, version } of dependencies) {
    const path = join(root, 'node_modules', name, 'package.json');
    if (!existsSync(path)) {
      problems.push(`${name}@${version} is not installed`);
      continue;
    }
    const installed = readJson(path).version;
    if (installed !== version) problems.push(`${name} is installed at ${installed}, but package-lock.json pins ${version}`);
  }
  for (const { name, license } of FULL_TEXT_NOTICES) {
    const path = join(root, 'node_modules', name, license);
    if (!existsSync(path) || !readFileSync(path, 'utf8').trim()) {
      problems.push(`${name} license text ${license} is missing from node_modules`);
    }
  }
  if (problems.length) {
    throw new Error([
      'Refusing to generate third-party notices from an incomplete dependency tree:',
      ...problems.map(problem => `  - ${problem}`),
      'Install the pinned root dependencies first (npm ci).',
    ].join('\n'));
  }
  return dependencies;
}

// Proves a generated notice file carries every bundled full-text section and a
// complete production inventory at the pinned versions.
export function validateNoticeText(text, root = repositoryRoot) {
  const dependencies = pinnedProductionDependencies(root);
  const problems = [];
  for (const { name } of FULL_TEXT_NOTICES) {
    const version = pinnedVersion(dependencies, name);
    const section = new RegExp(`^## ${escape(name)}@${escape(version)}\\n\\n\`\`\`\\n([\\s\\S]*?)\`\`\`$`, 'm').exec(text);
    if (!section || !section[1].trim()) problems.push(`missing full license text section for ${name}@${version}`);
  }
  if (/license-checker failed|full list generation failed/.test(text)) {
    problems.push('the npm production dependency inventory failed to generate');
  }
  const inventory = /^### Full per-package list\n\n```\n([\s\S]*?)```/m.exec(text)?.[1] ?? '';
  const rows = inventory.split('\n').filter(line => line.startsWith('"') && !line.startsWith('"module name"'));
  for (const { name, version } of dependencies) {
    if (!rows.some(row => row.startsWith(`"${name}@${version}",`))) {
      problems.push(`npm production inventory is missing ${name}@${version}`);
    }
  }
  if (rows.length <= dependencies.length) {
    problems.push(`npm production inventory lists only ${rows.length} packages for ${dependencies.length} direct dependencies`);
  }
  if (problems.length) {
    throw new Error([
      'Third-party notices are incomplete and must not be baked into an image:',
      ...problems.map(problem => `  - ${problem}`),
    ].join('\n'));
  }
  return { packages: rows.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, path] = process.argv.slice(2);
  try {
    if (mode === 'installed') {
      validateInstalledNoticeSources();
    } else if (mode === 'file' && path) {
      const { packages } = validateNoticeText(readFileSync(path, 'utf8'));
      console.log(`✓ ${path} covers bundled license texts and ${packages} npm production packages`);
    } else {
      throw new Error('Usage: validate-third-party-notices.mjs installed | file <path>');
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
