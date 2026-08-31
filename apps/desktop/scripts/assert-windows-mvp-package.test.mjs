import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createPackage, extractFile, listPackage } from '@electron/asar';
import { canonicalMainBundleEntry } from './assert-windows-mvp-package.mjs';

const fixtures = [];
after(async () => Promise.all(fixtures.map(path => rm(path, { recursive: true, force: true }))));

describe('Windows MVP ASAR main entry', () => {
  test('uses the rooted listPackage representation accepted by extractFile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-windows-mvp-asar-'));
    fixtures.push(root);
    const source = join(root, 'source');
    const archive = join(root, 'app.asar');
    await mkdir(join(source, '.vite', 'build'), { recursive: true });
    await writeFile(join(source, '.vite', 'build', 'main.cjs'), 'module.exports = "main fixture";\n');
    await writeFile(join(source, 'package.json'), '{"main":".vite/build/main.cjs"}\n');
    await createPackage(source, archive);

    const entries = listPackage(archive);
    const listedMain = entries.find(entry => entry.replaceAll('\\', '/') === '/.vite/build/main.cjs');
    assert.ok(listedMain?.startsWith('/') || listedMain?.startsWith('\\'));
    const extractionEntry = canonicalMainBundleEntry(entries);
    assert.equal(extractionEntry, listedMain.slice(1));
    assert.equal(extractFile(archive, extractionEntry).toString('utf8'), 'module.exports = "main fixture";\n');
  });

  test('preserves the Windows separator after removing the one archive root', () => {
    assert.equal(canonicalMainBundleEntry([
      '\\.vite',
      '\\.vite\\build',
      '\\.vite\\build\\main.cjs',
    ]), '.vite\\build\\main.cjs');
  });

  test('rejects traversal, duplicate entries, and case-colliding main paths', () => {
    assert.throws(
      () => canonicalMainBundleEntry(['/.vite', '/.vite/../build', '/.vite/build/main.cjs']),
      /traversal or ambiguity/,
    );
    assert.throws(
      () => canonicalMainBundleEntry(['/.vite/build/main.cjs', '/.vite/build/main.cjs']),
      /duplicate or case-colliding/,
    );
    assert.throws(
      () => canonicalMainBundleEntry(['/.vite/build/main.cjs', '/.VITE/build/main.cjs']),
      /duplicate or case-colliding/,
    );
    assert.throws(
      () => canonicalMainBundleEntry(['/.VITE/build/main.cjs']),
      /non-canonical casing/,
    );
  });
});
