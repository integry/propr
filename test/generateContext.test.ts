import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  filterExplicitFilesBySafePaths,
  generateContext,
} from '../packages/core/src/services/context/generateContext.ts';
import { ContextTokenLimitError } from '../packages/core/src/services/context/types.ts';

const REPOMIX_TEMP_PREFIX = 'propr-repomix-';
const LEGACY_REPOMIX_TEMP_ROOT_NAME = 'propr-repomix';
const OWNERSHIP_MARKER_NAME = '.owner.json';

async function createRepository(files: Record<string, string>): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'propr-context-test-'));
  await Promise.all(
    Object.entries(files).map(([filePath, content]) => writeFile(path.join(repoPath, filePath), content)),
  );
  return repoPath;
}

async function createOutputRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'propr-context-output-test-'));
}

async function listRepomixOutputDirectories(temporaryRoot: string): Promise<string[]> {
  const entries = await readdir(temporaryRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(REPOMIX_TEMP_PREFIX))
    .map(entry => entry.name);
}

async function assertNoOutputDirectories(temporaryRoot: string): Promise<void> {
  assert.deepEqual(await listRepomixOutputDirectories(temporaryRoot), []);
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
  const temporaryRoot = await createOutputRoot();
  t.after(() => Promise.all([
    rm(repoPath, { recursive: true, force: true }),
    rm(temporaryRoot, { recursive: true, force: true }),
  ]));

  const result = await generateContext({
    repoPath,
    filesToInclude: ['a-safe.ts', 'm-suspicious.ts', 'z-large.ts'],
    tokenLimit: 3_000,
    modelId: 'gpt-5.6',
    temporaryRoot,
  });

  assert.ok(result.totalTokens <= 3_000);
  assert.equal(result.context.length, result.totalCharacters);
  assert.match(result.context, new RegExp(safeMarker));
  assert.doesNotMatch(result.context, new RegExp(largeMarker));
  assert.doesNotMatch(result.context, new RegExp(fakeGitHubToken));
  assert.deepEqual(result.includedFiles, Object.keys(result.fileTokenCounts));
  assert.deepEqual(result.skippedSecurityFiles?.map(file => file.filePath), ['m-suspicious.ts']);
  await assertNoOutputDirectories(temporaryRoot);
});

test('isolates concurrent output and cleans both temporary directories', async t => {
  const temporaryRoot = await createOutputRoot();
  const firstRepo = await createRepository({ 'first.ts': 'export const value = "FIRST_REPOSITORY_MARKER";\n' });
  const secondRepo = await createRepository({ 'second.ts': 'export const value = "SECOND_REPOSITORY_MARKER";\n' });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(firstRepo, { recursive: true, force: true }),
    rm(secondRepo, { recursive: true, force: true }),
  ]));

  const [first, second] = await Promise.all([
    generateContext({ repoPath: firstRepo, tokenLimit: 20_000, modelId: 'gpt-5.6', temporaryRoot }),
    generateContext({ repoPath: secondRepo, tokenLimit: 20_000, modelId: 'gpt-5.6', temporaryRoot }),
  ]);

  assert.match(first.context, /FIRST_REPOSITORY_MARKER/);
  assert.doesNotMatch(first.context, /SECOND_REPOSITORY_MARKER/);
  assert.match(second.context, /SECOND_REPOSITORY_MARKER/);
  assert.doesNotMatch(second.context, /FIRST_REPOSITORY_MARKER/);
  await assertNoOutputDirectories(temporaryRoot);
});

test('cleans temporary output when a single file cannot fit the hard token limit', async t => {
  const temporaryRoot = await createOutputRoot();
  const repoPath = await createRepository({
    'oversized.ts': 'export const oversized = "OVERSIZED_MARKER";\n'.repeat(2_000),
  });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  await assert.rejects(
    generateContext({ repoPath, tokenLimit: 50, modelId: 'gpt-5.6', temporaryRoot }),
    (error: unknown) => error instanceof ContextTokenLimitError && error.totalTokens > error.tiktokenLimit,
  );

  await assertNoOutputDirectories(temporaryRoot);
});

test('does not delete pre-existing directories with unverified ownership', async t => {
  const temporaryRoot = await createOutputRoot();
  const unrelatedDirectory = path.join(temporaryRoot, `${REPOMIX_TEMP_PREFIX}unrelated`);
  await mkdir(unrelatedDirectory);
  await writeFile(path.join(unrelatedDirectory, OWNERSHIP_MARKER_NAME), '{"not":"a valid owner"}');
  const repoPath = await createRepository({ 'index.ts': 'export const value = 1;\n' });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  await generateContext({ repoPath, tokenLimit: 20_000, modelId: 'gpt-5.6', temporaryRoot });

  assert.ok((await stat(unrelatedDirectory)).isDirectory());
  assert.deepEqual(await listRepomixOutputDirectories(temporaryRoot), [path.basename(unrelatedDirectory)]);
});

test('does not follow a predictable legacy temporary-root symlink', async t => {
  const temporaryRoot = await createOutputRoot();
  const attackTarget = await mkdtemp(path.join(tmpdir(), 'propr-context-symlink-target-'));
  await chmod(attackTarget, 0o755);
  await writeFile(path.join(attackTarget, 'sentinel.txt'), 'must remain isolated');
  await symlink(attackTarget, path.join(temporaryRoot, LEGACY_REPOMIX_TEMP_ROOT_NAME), 'dir');
  const repoPath = await createRepository({ 'index.ts': 'export const value = 1;\n' });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(attackTarget, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  await generateContext({ repoPath, tokenLimit: 20_000, modelId: 'gpt-5.6', temporaryRoot });

  assert.equal((await stat(attackTarget)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(attackTarget), ['sentinel.txt']);
  await assertNoOutputDirectories(temporaryRoot);
});

test('preserves caller priority while filtering safe paths with glob metacharacters', () => {
  const callerOrder = ['z-priority[1].ts', 'm-suspicious.ts', 'a-lower-priority.ts'];
  const repomixSafeOrder = ['a-lower-priority.ts', 'z-priority[1].ts'];

  assert.deepEqual(
    filterExplicitFilesBySafePaths(callerOrder, repomixSafeOrder),
    ['z-priority[1].ts', 'a-lower-priority.ts'],
  );
});

test('normalizes explicit paths to Repomix target-relative paths', () => {
  assert.deepEqual(
    filterExplicitFilesBySafePaths(
      ['./src/first.ts', 'src\\second.ts', 'SRC/THIRD.ts', 'src/first.ts'],
      ['src/third.ts', 'src/second.ts', 'src/first.ts'],
      true,
    ),
    ['src/first.ts', 'src/second.ts', 'src/third.ts'],
  );
});

test('handles an explicit filename containing glob metacharacters', async t => {
  const temporaryRoot = await createOutputRoot();
  const repoPath = await createRepository({
    'literal[1].ts': 'export const marker = "LITERAL_GLOB_MARKER";\n',
    'other.ts': 'export const other = true;\n',
  });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  const result = await generateContext({
    repoPath,
    filesToInclude: ['literal[1].ts'],
    tokenLimit: 20_000,
    modelId: 'gpt-5.6',
    temporaryRoot,
  });

  assert.match(result.context, /LITERAL_GLOB_MARKER/);
  assert.deepEqual(result.includedFiles, ['literal[1].ts']);
});

test('does not turn a suspicious literal filename into an ignore glob', async t => {
  const temporaryRoot = await createOutputRoot();
  const fakeGitHubToken = ['ghp_', 'd'.repeat(36)].join('');
  const repoPath = await createRepository({
    'secret[1].ts': `export const credential = '${fakeGitHubToken}';\n`,
    'secret1.ts': 'export const marker = "SAFE_GLOB_NEIGHBOR_MARKER";\n',
  });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  const result = await generateContext({
    repoPath,
    tokenLimit: 20_000,
    modelId: 'gpt-5.6',
    temporaryRoot,
  });

  assert.match(result.context, /SAFE_GLOB_NEIGHBOR_MARKER/);
  assert.doesNotMatch(result.context, new RegExp(fakeGitHubToken));
  assert.deepEqual(result.includedFiles, ['secret1.ts']);
  assert.deepEqual(result.skippedSecurityFiles?.map(file => file.filePath), ['secret[1].ts']);
});

test('returns an empty safe result when every selected file is suspicious', async t => {
  const temporaryRoot = await createOutputRoot();
  const firstFakeToken = ['ghp_', 'b'.repeat(36)].join('');
  const secondFakeToken = ['github_pat_', 'c'.repeat(82)].join('');
  const repoPath = await createRepository({
    'first-secret.ts': `export const token = '${firstFakeToken}';\n`,
    'second-secret.ts': `export const token = '${secondFakeToken}';\n`,
  });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  const result = await generateContext({
    repoPath,
    filesToInclude: ['first-secret.ts', 'second-secret.ts'],
    tokenLimit: 20_000,
    modelId: 'gpt-5.6',
    temporaryRoot,
  });

  assert.deepEqual(result.includedFiles, []);
  assert.equal(result.totalFiles, 0);
  assert.doesNotMatch(result.context, new RegExp(firstFakeToken));
  assert.doesNotMatch(result.context, new RegExp(secondFakeToken));
  assert.deepEqual(result.skippedSecurityFiles?.map(file => file.filePath).sort(), [
    'first-secret.ts',
    'second-secret.ts',
  ]);
});

test('reports requested and internal token budgets for Claude and Gemini', async t => {
  const temporaryRoot = await createOutputRoot();
  const repoPath = await createRepository({
    'oversized.ts': 'export const oversized = "MODEL_RATIO_MARKER";\n'.repeat(2_000),
  });
  t.after(() => Promise.all([
    rm(temporaryRoot, { recursive: true, force: true }),
    rm(repoPath, { recursive: true, force: true }),
  ]));

  for (const [modelId, expectedTiktokenLimit] of [
    ['claude-sonnet-4-6', 73],
    ['gemini-3-pro', 90],
  ] as const) {
    await assert.rejects(
      generateContext({ repoPath, tokenLimit: 100, modelId, temporaryRoot }),
      (error: unknown) => {
        assert.ok(error instanceof ContextTokenLimitError);
        assert.equal(error.code, 'CONTEXT_TOKEN_LIMIT_EXCEEDED');
        assert.equal(error.requestedTokenLimit, 100);
        assert.equal(error.tokenLimit, 100);
        assert.equal(error.tiktokenLimit, expectedTiktokenLimit);
        assert.equal(error.modelId, modelId);
        assert.ok(error.totalTokens > error.tiktokenLimit);
        assert.match(error.message, /requested 100-token model budget/);
        return true;
      },
    );
  }

  await assertNoOutputDirectories(temporaryRoot);
});
