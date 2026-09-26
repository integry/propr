import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfilePath = join(repoRoot, 'propr-ui', 'Dockerfile');
const packageJsonPath = join(repoRoot, 'propr-ui', 'package.json');
const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

const productionUiSources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return productionUiSources(path);
  if (!sourceExtensions.includes(extname(entry.name))
    || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(entry.name)) return [];
  return [path];
});

const runtimeRelativeImports = (path) => {
  const contents = readFileSync(path, 'utf8');
  const specifiers = [];
  const statements = /\b(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of contents.matchAll(statements)) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith('.')) specifiers.push(specifier);
  }
  return specifiers;
};

const resolveSourceImport = (importer, specifier) => {
  const target = resolve(dirname(importer), specifier);
  const candidates = [target, ...sourceExtensions.map(extension => `${target}${extension}`),
    ...sourceExtensions.map(extension => join(target, `index${extension}`))];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
};

const dockerCopySources = () => readFileSync(dockerfilePath, 'utf8').split('\n').flatMap(line => {
  const match = line.match(/^COPY\s+(?!--from=)(\S+)\s+\S+\s*$/);
  return match ? [resolve(repoRoot, match[1])] : [];
});

const isCopied = (path, copiedSources) => copiedSources.some(source => (
  path === source || path.startsWith(`${source}${sep}`)
));

test('focused UI selectors are forwarded only to Vitest', () => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  assert.equal(manifest.scripts.test, 'vitest run');
  assert.equal(manifest.scripts.posttest, 'npm run test:docker-context');
  assert.equal(manifest.scripts['test:docker-context'],
    'node --test scripts/docker-context-inputs.test.mjs');
});

test('the UI Docker context contains its complete non-type external source import closure', () => {
  const queue = productionUiSources(join(repoRoot, 'propr-ui', 'src'));
  const visited = new Set();
  const externalSources = new Set();
  while (queue.length > 0) {
    const source = queue.pop();
    if (!source || visited.has(source)) continue;
    visited.add(source);
    for (const specifier of runtimeRelativeImports(source)) {
      const imported = resolveSourceImport(source, specifier);
      if (!imported) continue;
      if (!imported.startsWith(`${join(repoRoot, 'propr-ui')}${sep}`)) externalSources.add(imported);
      queue.push(imported);
    }
  }

  assert.deepEqual([...externalSources].map(path => relative(repoRoot, path)).sort(), [
    'apps/desktop/src/security.ts',
    'apps/desktop/src/shared/contract.ts',
  ]);
  const copiedSources = dockerCopySources();
  for (const source of externalSources) {
    assert.equal(isCopied(source, copiedSources), true,
      `${relative(repoRoot, source)} is in the production UI import closure but absent from Docker COPY inputs`);
  }
  for (const workspace of ['packages/client', 'packages/shared']) {
    assert.equal(isCopied(join(repoRoot, workspace), copiedSources), true,
      `${workspace} must remain available to the clean UI Docker build`);
  }
});
