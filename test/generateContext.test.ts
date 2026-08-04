import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { generateContext } from '../packages/core/src/services/context/generateContext.ts';
import { ContextTokenLimitError } from '../packages/core/src/services/context/types.ts';

const REPOMIX_TEMP_PREFIX = 'propr-repomix-';

async function createRepository(files: Record<string, string>): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'propr-context-test-'));
  await Promise.all(
    Object.entries(files).map(([filePath, content]) => writeFile(path.join(repoPath, filePath), content)),
  );
  return repoPath;
}

async function listRepomixOutputDirectories(): Promise<Set<string>> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(REPOMIX_TEMP_PREFIX))
      .map(entry => entry.name),
  );
}

function assertNoNewOutputDirectories(before: Set<string>, after: Set<string>): void {
  assert.deepEqual([...after].filter(directory => !before.has(directory)), []);
}

test('keeps security exclusions through optimization and returns aligned final output', async t => {
  const safeMarker = 'SAFE_PRIORITY_MARKER';
  const largeMarker = 'LOW_PRIORITY_LARGE_MARKER';
  const fakeGitHubToken = ['ghp_', 'a'.repeat(36)].join('');
  const repoPath = await createRepository({
    'a-safe.ts': `export const safe = '${safeMarker}';\n`,
    'm-suspicious.ts': `export const credential = '${fakeGitHubToken}';\n`,
    'z-large.ts': `export const payload = '${largeMarker}';\n`.repeat(8_000),
  });
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  const result = await generateContext({
    repoPath,
    filesToInclude: ['a-safe.ts', 'm-suspicious.ts', 'z-large.ts'],
    tokenLimit: 3_000,
    modelId: 'gpt-5.6',
  });

  assert.ok(result.totalTokens <= 3_000);
  assert.equal(result.context.length, result.totalCharacters);
  assert.match(result.context, new RegExp(safeMarker));
  assert.doesNotMatch(result.context, new RegExp(largeMarker));
  assert.doesNotMatch(result.context, new RegExp(fakeGitHubToken));
  assert.deepEqual(result.includedFiles, Object.keys(result.fileTokenCounts));
  assert.deepEqual(result.skippedSecurityFiles?.map(file => file.filePath), ['m-suspicious.ts']);
});

test('isolates concurrent output and cleans both temporary directories', async t => {
  const before = await listRepomixOutputDirectories();
  const firstRepo = await createRepository({ 'first.ts': 'export const value = "FIRST_REPOSITORY_MARKER";\n' });
  const secondRepo = await createRepository({ 'second.ts': 'export const value = "SECOND_REPOSITORY_MARKER";\n' });
  t.after(() => Promise.all([
    rm(firstRepo, { recursive: true, force: true }),
    rm(secondRepo, { recursive: true, force: true }),
  ]));

  const [first, second] = await Promise.all([
    generateContext({ repoPath: firstRepo, tokenLimit: 20_000, modelId: 'gpt-5.6' }),
    generateContext({ repoPath: secondRepo, tokenLimit: 20_000, modelId: 'gpt-5.6' }),
  ]);

  assert.match(first.context, /FIRST_REPOSITORY_MARKER/);
  assert.doesNotMatch(first.context, /SECOND_REPOSITORY_MARKER/);
  assert.match(second.context, /SECOND_REPOSITORY_MARKER/);
  assert.doesNotMatch(second.context, /FIRST_REPOSITORY_MARKER/);
  assertNoNewOutputDirectories(before, await listRepomixOutputDirectories());
});

test('cleans temporary output when a single file cannot fit the hard token limit', async t => {
  const before = await listRepomixOutputDirectories();
  const repoPath = await createRepository({
    'oversized.ts': 'export const oversized = "OVERSIZED_MARKER";\n'.repeat(2_000),
  });
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  await assert.rejects(
    generateContext({ repoPath, tokenLimit: 50, modelId: 'gpt-5.6' }),
    (error: unknown) => error instanceof ContextTokenLimitError && error.totalTokens > error.tokenLimit,
  );

  assertNoNewOutputDirectories(before, await listRepomixOutputDirectories());
});

test('removes stale repository output left by an interrupted process', async t => {
  const staleDirectory = await mkdtemp(path.join(tmpdir(), REPOMIX_TEMP_PREFIX));
  const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  await utimes(staleDirectory, oldTimestamp, oldTimestamp);
  t.after(() => rm(staleDirectory, { recursive: true, force: true }));

  const repoPath = await createRepository({ 'index.ts': 'export const value = 1;\n' });
  t.after(() => rm(repoPath, { recursive: true, force: true }));

  await generateContext({ repoPath, tokenLimit: 20_000, modelId: 'gpt-5.6' });

  await assert.rejects(stat(staleDirectory), { code: 'ENOENT' });
});
