import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildDocsManifest, sidebarOrder } from '../scripts/build-docs-manifest.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'propr-docs-manifest-'));
after(() => rm(scratch, { recursive: true, force: true }));

async function fixture(name, sidebars) {
  const root = join(scratch, name);
  await mkdir(join(root, 'docs', 'docs', 'features'), { recursive: true });
  await mkdir(join(root, 'docs', 'docs', 'tutorials'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '4.5.6' }));
  await writeFile(join(root, 'docs', 'docs', 'features', 'overview.md'), '# Overview\n');
  await writeFile(join(root, 'docs', 'docs', 'features', 'later.mdx'), '# Later\n');
  await writeFile(join(root, 'docs', 'docs', 'tutorials', 'setup.md'), '# Setup\n');
  if (sidebars !== null) await writeFile(join(root, 'docs', 'sidebars.ts'), sidebars);
  return root;
}

test('buildDocsManifest records release identity, page count and sidebar order without executing TypeScript', async () => {
  const root = await fixture('ordered', `
    throw new Error('sidebars.ts must never execute');
    const sidebars = [{ label: 'features/overview label', items: [
      'tutorials/setup',
      { type: 'doc', id: "features/overview", label: 'Overview' },
      'features/later',
    ] }];
  `);
  const generatedAt = new Date('2026-09-29T20:59:00.000Z');
  const manifest = await buildDocsManifest({
    root, env: { GIT_SHA: 'revision-from-build' }, now: generatedAt,
    resolveRevision: async () => assert.fail('GIT_SHA must take precedence over git'),
  });

  assert.deepEqual(manifest, {
    schemaVersion: 1,
    version: '4.5.6',
    sourceRevision: 'revision-from-build',
    generatedAt: generatedAt.toISOString(),
    order: ['tutorials/setup', 'features/overview', 'features/later'],
    pageCount: 3,
  });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'docs', 'docs-manifest.json'), 'utf8')), manifest);
});

test('buildDocsManifest falls back to alphabetical order and a null revision', async () => {
  const root = await fixture('fallback', null);
  const manifest = await buildDocsManifest({
    root, env: {}, resolveRevision: async () => null,
  });
  assert.deepEqual(manifest.order, ['features/later', 'features/overview', 'tutorials/setup']);
  assert.equal(manifest.sourceRevision, null);
  assert.equal(manifest.pageCount, 3);
});

test('sidebarOrder ignores non-doc string literals and appends omitted pages alphabetically', () => {
  assert.deepEqual(
    sidebarOrder(`import x from 'features/not-a-doc'; const x = ['b', { label: 'Page A', id: 'c' }];`, ['a', 'b', 'c']),
    ['b', 'c', 'a'],
  );
});
