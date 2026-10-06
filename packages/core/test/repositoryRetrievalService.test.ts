import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

type IndexRow = { indexing_status: string; last_indexed_at: string | null; last_indexed_hash: string | null } | undefined;

let indexRow: IndexRow;
const dbWhereCalls: unknown[] = [];

const db = mock.fn((table: string) => {
  assert.equal(table, 'repositories');
  const builder = {
    where(criteria: unknown) { dbWhereCalls.push(criteria); return builder; },
    select() { return builder; },
    first: async () => indexRow,
  };
  return builder;
});

type RelevanceOptions = {
  useSummaryScoring?: boolean; agent?: unknown; branch?: string; repoName?: string; commit?: string; maxResults?: number;
};
let relevanceFiles: Array<{ path: string; score: number; reason: string; signals?: string[] }> = [];
let summaryScoringSucceeds = true;
const findRelevantFiles = mock.fn(async (_repoPath: string, _prompt: string, options: RelevanceOptions) => {
  return {
    files: relevanceFiles,
    keywordsDetected: ['auth'],
    usedSummaryScoring: Boolean(options.useSummaryScoring) && summaryScoringSucceeds,
  };
});

const clonesBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-retrieval-clones-'));
process.env.GIT_CLONES_BASE_PATH = clonesBasePath;

let defaultAgent: unknown = { config: { alias: 'claude', defaultModel: 'test-model' } };
const ensureRepoCloned = mock.fn(async () => { throw new Error('ensureRepoCloned should not be called'); });

await mock.module('../src/db/connection.js', { namedExports: { db } });
await mock.module('../src/services/relevanceService.js', { namedExports: { findRelevantFiles } });
await mock.module('../src/agents/AgentRegistry.js', {
  namedExports: {
    getAgentRegistry: () => ({ ensureInitialized: async () => {}, getDefaultAgent: () => defaultAgent }),
  },
});
await mock.module('../src/auth/githubAuth.js', {
  namedExports: {
    getGitHubInstallationToken: async () => 'token',
    getAuthenticatedOctokit: async () => { throw new Error('getAuthenticatedOctokit should not be called'); },
  },
});
await mock.module('../src/git/repoManager.js', { namedExports: { ensureRepoCloned } });
const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
await mock.module('../src/utils/logger.js', {
  defaultExport: { ...silentLogger, withCorrelation: () => silentLogger },
});

const {
  searchRepositoryFiles,
  readRepositoryFileContent,
  parseGitGrepOutput,
  RepositoryRetrievalError,
} = await import('../src/services/repositoryRetrievalService.js');

// --- Fixture repository ---

const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-retrieval-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
const write = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
  fs.writeFileSync(path.join(repoPath, file), content);
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
git('config', 'commit.gpgsign', 'false');
write('src/auth/login.ts', 'export function login() {\n  return validateToken();\n}\n// validateToken again\n');
write('src/auth/token.ts', 'export function validateToken() {\n  return true;\n}\n');
write('src/util.ts', 'export const VALIDATETOKEN_FLAG = 1;\n');
write('docs/guide.md', 'Call validateToken before login.\n');
write('weird:name.txt', 'validateToken in a colon path\n');
write('nl\nname.txt', 'newlineNeedle\nnewlineNeedle again\n');
write('name.txt', 'newlineNeedle once\n');
write('assets/logo.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
write('big.txt', Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
git('add', '-A');
git('commit', '-q', '-m', 'initial');
const firstCommit = git('rev-parse', 'HEAD');

write('src/auth/token.ts', 'export function validateToken() {\n  return false;\n}\nexport const changed = true;\n');
git('commit', '-q', '-am', 'second');
const headCommit = git('rev-parse', 'HEAD');

// Refs that a shallow single-branch clone of main does not contain.
git('checkout', '-q', '-b', 'feature');
write('src/feature.ts', 'export const featureOnlyNeedle = true;\n');
git('add', '-A');
git('commit', '-q', '-m', 'feature work');
const featureCommit = git('rev-parse', 'HEAD');
git('tag', 'v-feature');
git('checkout', '-q', 'main');

after(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
  fs.rmSync(clonesBasePath, { recursive: true, force: true });
});

beforeEach(() => {
  indexRow = { indexing_status: 'completed', last_indexed_at: '2026-10-01T00:00:00.000Z', last_indexed_hash: headCommit };
  relevanceFiles = [];
  summaryScoringSucceeds = true;
  defaultAgent = { config: { alias: 'claude', defaultModel: 'test-model' } };
  dbWhereCalls.length = 0;
  findRelevantFiles.mock.resetCalls();
});

const base = { repository: 'owner/repo', repoPath };

async function expectRetrievalError(promise: Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryRetrievalError);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

// --- Semantic search ---

test('semantic search ranks files with summary scoring when the index is fresh', async () => {
  relevanceFiles = [
    { path: 'src/auth/login.ts', score: 91.234, reason: 'combined', signals: ['semantic', 'path-match'] },
    { path: 'src/auth/token.ts', score: 70, reason: 'git-history', signals: ['git-history'] },
    { path: 'docs/guide.md', score: 40, reason: 'llm-semantic' },
  ];

  const result = await searchRepositoryFiles({ ...base, query: 'how does login work', branch: 'main' });

  assert.equal(result.mode, 'semantic');
  assert.equal(result.commit, headCommit);
  const options = findRelevantFiles.mock.calls[0].arguments[2];
  assert.equal(options.useSummaryScoring, true);
  assert.equal(options.agent, defaultAgent);
  assert.equal(options.branch, 'main');
  assert.equal(options.repoName, 'owner/repo');
  assert.equal(options.commit, headCommit);
  assert.equal(options.maxResults, Number.POSITIVE_INFINITY);
  assert.deepEqual(dbWhereCalls[0], { full_name: 'owner/repo', branch: 'main' });

  assert.deepEqual(result.matches, [
    { path: 'src/auth/login.ts', score: 91.23, reasons: ['semantic', 'path-match'] },
    { path: 'src/auth/token.ts', score: 70, reasons: ['git-history'] },
    { path: 'docs/guide.md', score: 40, reasons: ['semantic'] },
  ]);
  assert.equal(result.freshness?.usedIndex, true);
  assert.equal(result.freshness?.stale, false);
  assert.equal(result.freshness?.caveat, undefined);
  assert.equal(result.freshness?.lastIndexedHash, headCommit);
  assert.deepEqual(result.pagination, { offset: 0, limit: 20, nextOffset: null, totalMatches: 3 });
});

test('semantic search falls back to heuristics with a caveat when the repository is not indexed', async () => {
  indexRow = undefined;
  relevanceFiles = [{ path: 'src/auth/login.ts', score: 50, reason: 'path-match' }];

  const result = await searchRepositoryFiles({ ...base, query: 'login' });

  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].useSummaryScoring, false);
  assert.deepEqual(dbWhereCalls[0], { full_name: 'owner/repo', branch: 'HEAD' });
  assert.equal(result.freshness?.usedIndex, false);
  assert.equal(result.freshness?.stale, true);
  assert.equal(result.freshness?.indexingStatus, null);
  assert.match(result.freshness?.caveat ?? '', /not been indexed/);
  assert.equal(result.matches.length, 1);
});

test('semantic search falls back with a caveat while indexing is in progress', async () => {
  indexRow = { indexing_status: 'indexing', last_indexed_at: null, last_indexed_hash: null };

  const result = await searchRepositoryFiles({ ...base, query: 'login' });

  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].useSummaryScoring, false);
  assert.equal(result.freshness?.indexingStatus, 'indexing');
  assert.match(result.freshness?.caveat ?? '', /in progress/);
});

test('semantic search flags an index built from an older commit as stale', async () => {
  indexRow = { indexing_status: 'completed', last_indexed_at: '2026-10-01T00:00:00Z', last_indexed_hash: firstCommit };

  const result = await searchRepositoryFiles({ ...base, query: 'login' });

  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].useSummaryScoring, true);
  assert.equal(result.freshness?.usedIndex, true);
  assert.equal(result.freshness?.stale, true);
  assert.match(result.freshness?.caveat ?? '', new RegExp(firstCommit.slice(0, 12)));
});

test('semantic search scores the resolved commit of a non-checked-out ref', async () => {
  await searchRepositoryFiles({ ...base, query: 'login', ref: firstCommit });
  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].commit, firstCommit);
});

test('semantic search reports heuristic fallback when summary scoring does not contribute', async () => {
  summaryScoringSucceeds = false;
  relevanceFiles = [{ path: 'src/auth/login.ts', score: 50, reason: 'path-match' }];

  const result = await searchRepositoryFiles({ ...base, query: 'login' });

  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].useSummaryScoring, true);
  assert.equal(result.freshness?.usedIndex, false);
  assert.equal(result.freshness?.stale, true);
  assert.match(result.freshness?.caveat ?? '', /summaries did not contribute/);
});

test('semantic search falls back when no default agent is configured', async () => {
  defaultAgent = undefined;

  const result = await searchRepositoryFiles({ ...base, query: 'login' });

  assert.equal(findRelevantFiles.mock.calls[0].arguments[2].useSummaryScoring, false);
  assert.match(result.freshness?.caveat ?? '', /No default agent/);
});

test('semantic search applies path prefix filtering and pagination', async () => {
  relevanceFiles = [
    { path: 'src/a.ts', score: 90, reason: 'semantic' },
    { path: 'docs/x.md', score: 85, reason: 'semantic' },
    { path: 'src/b.ts', score: 80, reason: 'semantic' },
    { path: 'src/c.ts', score: 70, reason: 'semantic' },
  ];

  const first = await searchRepositoryFiles({ ...base, query: 'q', path: 'src/', limit: 2 });
  assert.deepEqual(first.matches.map(m => m.path), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(first.pagination, { offset: 0, limit: 2, nextOffset: 2, totalMatches: 3 });

  const second = await searchRepositoryFiles({ ...base, query: 'q', path: 'src/', limit: 2, offset: 2 });
  assert.deepEqual(second.matches.map(m => m.path), ['src/c.ts']);
  assert.equal(second.pagination.nextOffset, null);
});

// --- Literal search ---

test('literal search greps case-insensitively by default and returns counts and line matches', async () => {
  const result = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal' });

  assert.equal(findRelevantFiles.mock.callCount(), 0);
  assert.equal(result.commit, headCommit);
  const byPath = Object.fromEntries(result.matches.map(m => [m.path, m]));
  assert.deepEqual(Object.keys(byPath).sort(), ['docs/guide.md', 'src/auth/login.ts', 'src/auth/token.ts', 'src/util.ts', 'weird:name.txt']);
  assert.equal(byPath['src/auth/login.ts'].matchCount, 2);
  assert.deepEqual(byPath['src/auth/login.ts'].lineMatches, [
    { lineNumber: 2, text: '  return validateToken();' },
    { lineNumber: 4, text: '// validateToken again' },
  ]);
  assert.equal(byPath['src/util.ts'].matchCount, 1);
  assert.equal(result.pagination.totalMatches, 5);
});

test('literal search ignores a configured grep.column', async () => {
  const query = { ...base, query: 'validateToken', mode: 'literal' as const };
  const expected = await searchRepositoryFiles(query);
  git('config', 'grep.column', 'true');
  try {
    const withColumn = await searchRepositoryFiles(query);
    assert.deepEqual(withColumn.matches, expected.matches);
    const login = withColumn.matches.find(m => m.path === 'src/auth/login.ts');
    assert.deepEqual(login?.lineMatches[0], { lineNumber: 2, text: '  return validateToken();' });
  } finally {
    git('config', '--unset', 'grep.column');
  }
});

test('literal search honours caseSensitive', async () => {
  const result = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal', caseSensitive: true });
  assert.ok(!result.matches.some(m => m.path === 'src/util.ts'));
  assert.equal(result.pagination.totalMatches, 4);
});

test('literal search filters by path prefix, including partial names', async () => {
  const dir = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal', path: 'src/auth/' });
  assert.deepEqual(dir.matches.map(m => m.path).sort(), ['src/auth/login.ts', 'src/auth/token.ts']);

  const partial = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal', path: 'src/auth/to' });
  assert.deepEqual(partial.matches.map(m => m.path), ['src/auth/token.ts']);

  const topLevel = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal', path: 'doc' });
  assert.deepEqual(topLevel.matches.map(m => m.path), ['docs/guide.md']);
});

test('literal search runs at the requested ref', async () => {
  const atHead = await searchRepositoryFiles({ ...base, query: 'changed = true', mode: 'literal' });
  assert.equal(atHead.pagination.totalMatches, 1);

  const atFirst = await searchRepositoryFiles({ ...base, query: 'changed = true', mode: 'literal', ref: firstCommit });
  assert.equal(atFirst.commit, firstCommit);
  assert.deepEqual(atFirst.matches, []);
});

test('literal search returns empty results instead of an error when nothing matches', async () => {
  const result = await searchRepositoryFiles({ ...base, query: 'definitely-not-present-anywhere', mode: 'literal' });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.pagination, { offset: 0, limit: 20, nextOffset: null, totalMatches: 0 });
});

test('literal search treats regex metacharacters literally and paginates', async () => {
  const regexy = await searchRepositoryFiles({ ...base, query: 'validateToken()', mode: 'literal' });
  assert.deepEqual(regexy.matches.map(m => m.path).sort(), ['src/auth/login.ts', 'src/auth/token.ts']);

  const page = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal', limit: 2, offset: 2 });
  assert.equal(page.matches.length, 2);
  assert.deepEqual(page.pagination, { offset: 2, limit: 2, nextOffset: 4, totalMatches: 5 });
});

test('parseGitGrepOutput groups records by file and caps line matches', () => {
  const sha = 'a'.repeat(40);
  const output = [
    `${sha}:src/a.ts\x001\x00one`,
    `${sha}:src/a.ts\x003\x00two`,
    `${sha}:src/a.ts\x009\x00three`,
    `${sha}:dir:with:colons.txt\x002\x00x`,
    '',
  ].join('\n');

  assert.deepEqual(parseGitGrepOutput(output, sha, 2), [
    { path: 'src/a.ts', matchCount: 3, lineMatches: [{ lineNumber: 1, text: 'one' }, { lineNumber: 3, text: 'two' }] },
    { path: 'dir:with:colons.txt', matchCount: 1, lineMatches: [{ lineNumber: 2, text: 'x' }] },
  ]);
  assert.deepEqual(parseGitGrepOutput('', sha, 5), []);
});

test('literal search keeps filenames containing newlines separate from similar names', async () => {
  const result = await searchRepositoryFiles({ ...base, query: 'newlineNeedle', mode: 'literal' });
  const byPath = Object.fromEntries(result.matches.map(m => [m.path, m.matchCount]));
  assert.deepEqual(byPath, { 'nl\nname.txt': 2, 'name.txt': 1 });
});

test('parseGitGrepOutput keeps filenames that contain newlines intact', () => {
  const sha = 'b'.repeat(40);
  const output = `${sha}:dir\nname.txt\x004\x00hit\n${sha}:name.txt\x001\x00other\n`;

  assert.deepEqual(parseGitGrepOutput(output, sha, 5), [
    { path: 'dir\nname.txt', matchCount: 1, lineMatches: [{ lineNumber: 4, text: 'hit' }] },
    { path: 'name.txt', matchCount: 1, lineMatches: [{ lineNumber: 1, text: 'other' }] },
  ]);
});

test('search validates its input', async () => {
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: '  ' }), 400, /query is required/);
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'x', mode: 'fuzzy' as never }), 400, /Unsupported search mode/);
  await expectRetrievalError(searchRepositoryFiles({ ...base, repository: 'not-a-repo', query: 'x' }), 400, /owner\/repo/);
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'x', mode: 'literal', path: '../etc' }), 400, /\.\./);
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'x', mode: 'literal', ref: '--output=/tmp/x' }), 400, /Invalid ref/);
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'x', mode: 'literal', ref: 'no-such-branch' }), 404, /not found/);
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'x', limit: 0 }), 400, /limit/);
});

// --- File reading ---

test('reads a whole small file at HEAD', async () => {
  const result = await readRepositoryFileContent({ ...base, path: 'src/auth/token.ts' });
  assert.equal(result.content, 'export function validateToken() {\n  return false;\n}\nexport const changed = true;');
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 4);
  assert.equal(result.totalLines, 4);
  assert.equal(result.truncated, false);
  assert.equal(result.nextStartLine, null);
  assert.equal(result.commit, headCommit);
  assert.equal(result.totalBytes, Buffer.byteLength(fs.readFileSync(path.join(repoPath, 'src/auth/token.ts'))));
});

test('reads file content at an older ref from the object database', async () => {
  const result = await readRepositoryFileContent({ ...base, path: 'src/auth/token.ts', ref: firstCommit });
  assert.equal(result.content, 'export function validateToken() {\n  return true;\n}');
  assert.equal(result.commit, firstCommit);
});

test('reads an explicit line range without truncation', async () => {
  const result = await readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 10, endLine: 12 });
  assert.equal(result.content, 'line 10\nline 11\nline 12');
  assert.equal(result.startLine, 10);
  assert.equal(result.endLine, 12);
  assert.equal(result.totalLines, 1000);
  assert.equal(result.truncated, false);
  assert.equal(result.nextStartLine, null);
});

test('caps output at the default maxLines of 800 and reports truncation', async () => {
  const result = await readRepositoryFileContent({ ...base, path: 'big.txt' });
  assert.equal(result.endLine, 800);
  assert.equal(result.content.split('\n').length, 800);
  assert.equal(result.truncated, true);
  assert.equal(result.nextStartLine, 801);

  const rest = await readRepositoryFileContent({ ...base, path: 'big.txt', startLine: result.nextStartLine ?? 0 });
  assert.equal(rest.startLine, 801);
  assert.equal(rest.endLine, 1000);
  assert.equal(rest.truncated, false);
});

test('caps output at maxLines and maxBytes', async () => {
  const byLines = await readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 5, endLine: 50, maxLines: 3 });
  assert.equal(byLines.content, 'line 5\nline 6\nline 7');
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.nextStartLine, 8);

  // "line 1\nline 2" is 13 bytes; a third line would need 20, so 19 stops at two.
  const byBytes = await readRepositoryFileContent({ ...base, path: 'big.txt', maxBytes: 19 });
  assert.equal(byBytes.content, 'line 1\nline 2');
  assert.equal(byBytes.returnedBytes, 13);
  assert.equal(byBytes.truncated, true);
  assert.equal(byBytes.nextStartLine, 3);

});

test('rejects a first line that does not fit in maxBytes instead of returning part of it', async () => {
  await expectRetrievalError(
    readRepositoryFileContent({ ...base, path: 'big.txt', maxBytes: 4 }),
    413,
    /Line 1 of "big\.txt" is 6 bytes .* maxBytes of at least 6/,
  );

  // A later oversized line ends the page before it, so the cursor points at it.
  const beforeOversized = await readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 9, maxBytes: 7 });
  assert.equal(beforeOversized.content, 'line 9');
  assert.equal(beforeOversized.truncated, true);
  assert.equal(beforeOversized.nextStartLine, 10);
  await expectRetrievalError(
    readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 10, maxBytes: 6 }),
    413,
    /Line 10 .* 7 bytes/,
  );
});

test('returns empty content when startLine is past the end of the file', async () => {
  const result = await readRepositoryFileContent({ ...base, path: 'src/util.ts', startLine: 50 });
  assert.equal(result.content, '');
  assert.equal(result.totalLines, 1);
  assert.equal(result.truncated, false);
});

test('rejects traversal and malformed paths', async () => {
  for (const bad of ['../secret', 'src/../../etc/passwd', '/etc/passwd', 'src\\auth\\token.ts', 'src/a\0.ts']) {
    await expectRetrievalError(readRepositoryFileContent({ ...base, path: bad }), 400, /path/);
  }
});

test('rejects binary files, directories, missing files and bad ranges with clear errors', async () => {
  await expectRetrievalError(readRepositoryFileContent({ ...base, path: 'assets/logo.bin' }), 400, /binary/);
  await expectRetrievalError(readRepositoryFileContent({ ...base, path: 'src/auth' }), 400, /directory/);
  await expectRetrievalError(readRepositoryFileContent({ ...base, path: 'src/missing.ts' }), 404, /not found/);
  await expectRetrievalError(readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 5, endLine: 2 }), 400, /endLine/);
  await expectRetrievalError(readRepositoryFileContent({ ...base, path: 'big.txt', startLine: 0 }), 400, /startLine/);
  assert.equal(ensureRepoCloned.mock.callCount(), 0);
});

// --- Managed clones ---

test('fetches requested branches, tags and commits missing from a shallow single-branch managed clone', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-repo');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  // Mirrors the real refresh, which only fetches the clone's configured refspec.
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  const managed = { repository: 'owner/managed-repo' };
  try {
    assert.equal(managedGit('rev-parse', '--is-shallow-repository'), 'true');
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'origin/feature'));

    const search = await searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', ref: 'feature' });
    assert.equal(search.commit, featureCommit);
    assert.deepEqual(search.matches.map(match => match.path), ['src/feature.ts']);

    const tagged = await readRepositoryFileContent({ ...managed, path: 'src/feature.ts', ref: 'v-feature' });
    assert.equal(tagged.commit, featureCommit);

    // The first commit lies outside the depth-1 history.
    const older = await readRepositoryFileContent({ ...managed, path: 'src/auth/token.ts', ref: firstCommit });
    assert.equal(older.commit, firstCommit);
    assert.match(older.content, /return true;/);

    // The main branch's shallow boundary is left alone.
    assert.equal(managedGit('rev-list', '--count', 'origin/main'), '1');

    await expectRetrievalError(
      readRepositoryFileContent({ ...managed, path: 'src/util.ts', ref: 'no-such-branch' }),
      404,
      /not found/,
    );
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

test('fetches qualified branch and tag refs missing from a shallow single-branch managed clone', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-qualified');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  const managed = { repository: 'owner/managed-qualified' };
  try {
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature'));
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/tags/v-feature'));

    const search = await searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', ref: 'refs/heads/feature' });
    assert.equal(search.commit, featureCommit);
    assert.deepEqual(search.matches.map(match => match.path), ['src/feature.ts']);
    // The branch keeps its namespace instead of becoming refs/heads/refs/heads/feature.
    assert.equal(managedGit('rev-parse', 'refs/remotes/origin/feature'), featureCommit);

    // Resolves locally on the next call without another refresh.
    const callsBefore = ensureRepoCloned.mock.callCount();
    const again = await readRepositoryFileContent({ ...managed, path: 'src/feature.ts', ref: 'refs/heads/feature' });
    assert.equal(again.commit, featureCommit);
    assert.equal(ensureRepoCloned.mock.callCount(), callsBefore);

    const tagged = await readRepositoryFileContent({ ...managed, path: 'src/feature.ts', ref: 'refs/tags/v-feature' });
    assert.equal(tagged.commit, featureCommit);
    assert.equal(managedGit('rev-parse', 'refs/tags/v-feature^{commit}'), featureCommit);

    await expectRetrievalError(
      readRepositoryFileContent({ ...managed, path: 'src/util.ts', ref: 'refs/heads/no-such-branch' }),
      404,
      /not found/,
    );
    await expectRetrievalError(
      readRepositoryFileContent({ ...managed, path: 'src/util.ts', ref: 'refs/tags/no-such-tag' }),
      404,
      /not found/,
    );
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

test('fetches origin/<branch> shorthand missing from a shallow single-branch managed clone', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-shorthand');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  const managed = { repository: 'owner/managed-shorthand' };
  try {
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature'));

    const search = await searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', ref: 'origin/feature' });
    assert.equal(search.commit, featureCommit);
    assert.deepEqual(search.matches.map(match => match.path), ['src/feature.ts']);
    // Fetched as branch `feature`, not as a branch literally named `origin/feature`.
    assert.equal(managedGit('rev-parse', 'refs/remotes/origin/feature'), featureCommit);
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/origin/feature'));

    // Resolves directly on the next call without another refresh.
    const callsBefore = ensureRepoCloned.mock.callCount();
    const read = await readRepositoryFileContent({ ...managed, path: 'src/feature.ts', ref: 'origin/feature' });
    assert.equal(read.commit, featureCommit);
    assert.equal(ensureRepoCloned.mock.callCount(), callsBefore);

    await expectRetrievalError(
      readRepositoryFileContent({ ...managed, path: 'src/util.ts', ref: 'origin/no-such-branch' }),
      404,
      /not found/,
    );
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

test('reads origin/<branch> shorthand freshly from a shallow managed clone', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-shorthand-read');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  try {
    const read = await readRepositoryFileContent({ repository: 'owner/managed-shorthand-read', path: 'src/feature.ts', ref: 'origin/feature' });
    assert.equal(read.commit, featureCommit);
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

test('resolves a short name shared by a branch and a tag to the tag whether or not the tag is cached', async () => {
  // Branch `release` and tag `release` point at different commits.
  git('branch', 'release', 'feature');
  git('tag', 'release', firstCommit);
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-ambiguous');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  const managed = { repository: 'owner/managed-ambiguous', path: 'src/util.ts' };
  try {
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/tags/release'));
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/release'));

    // Neither ref is cached: the explicit fetch picks the tag, as git would.
    const uncached = await readRepositoryFileContent({ ...managed, ref: 'release' });
    assert.equal(uncached.commit, firstCommit);

    // Explicitly requesting the tag and the branch does not change the answer.
    const tagged = await readRepositoryFileContent({ ...managed, ref: 'refs/tags/release' });
    assert.equal(tagged.commit, firstCommit);
    const branched = await readRepositoryFileContent({ ...managed, ref: 'refs/heads/release' });
    assert.equal(branched.commit, featureCommit);
    const cached = await readRepositoryFileContent({ ...managed, ref: 'release' });
    assert.equal(cached.commit, firstCommit);
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
    git('tag', '-d', 'release');
    git('branch', '-D', 'release');
  }
});

test('clones without the index branch when an explicit ref is given and no managed clone exists', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-fresh');
  assert.equal(fs.existsSync(managedPath), false);
  // Mirrors cloneNewRepo: a shallow clone that passes --branch when a base branch is given.
  ensureRepoCloned.mock.mockImplementation(async (opts: { baseBranch?: string }) => {
    if (!fs.existsSync(managedPath)) {
      const branchArgs = opts.baseBranch && opts.baseBranch !== 'HEAD' ? [`--branch=${opts.baseBranch}`] : [];
      execFileSync('git', ['clone', '-q', '--depth=1', ...branchArgs, `file://${repoPath}`, managedPath], { stdio: 'pipe' });
    }
    return managedPath;
  });
  const managed = { repository: 'owner/managed-fresh', branch: 'deleted-branch' };
  try {
    const search = await searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', ref: 'feature' });
    assert.equal(search.commit, featureCommit);
    assert.deepEqual(search.matches.map(match => match.path), ['src/feature.ts']);
    assert.equal(ensureRepoCloned.mock.calls[0].arguments[0].baseBranch, undefined);

    fs.rmSync(managedPath, { recursive: true, force: true });
    const read = await readRepositoryFileContent({ ...managed, path: 'src/util.ts', ref: 'main' });
    assert.equal(read.commit, headCommit);
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

test('resolves a short name to its tag even when only the same-named branch was cached first', async () => {
  // Branch `release` and tag `release` point at different commits.
  git('branch', 'release', 'feature');
  git('tag', 'release', firstCommit);
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-branch-first');
  execFileSync('git', ['clone', '-q', '--depth=1', '--single-branch', '--branch', 'main', `file://${repoPath}`, managedPath]);
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8' }).trim();
  ensureRepoCloned.mock.mockImplementation(async () => {
    managedGit('fetch', '-q', 'origin', '--prune');
    return managedPath;
  });
  const managed = { repository: 'owner/managed-branch-first', path: 'src/util.ts' };
  try {
    const branched = await readRepositoryFileContent({ ...managed, ref: 'refs/heads/release' });
    assert.equal(branched.commit, featureCommit);
    assert.equal(managedGit('rev-parse', 'refs/remotes/origin/release'), featureCommit);
    assert.throws(() => managedGit('rev-parse', '--verify', '--quiet', 'refs/tags/release'));

    // The cached branch must not shadow the tag git would pick.
    const short = await readRepositoryFileContent({ ...managed, ref: 'release' });
    assert.equal(short.commit, firstCommit);
    const searched = await searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', ref: 'release' });
    assert.equal(searched.commit, firstCommit);
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
    git('tag', '-d', 'release');
    git('branch', '-D', 'release');
  }
});

test('reports a nonexistent branch as a 404 when no managed clone exists yet', async () => {
  const managedPath = path.join(clonesBasePath, 'owner', 'managed-cold-branch');
  // Mirrors cloneNewRepo: --branch is passed when a base branch is given and fails for a missing branch.
  ensureRepoCloned.mock.mockImplementation(async (opts: { baseBranch?: string }) => {
    if (!fs.existsSync(managedPath)) {
      const branchArgs = opts.baseBranch && opts.baseBranch !== 'HEAD' ? [`--branch=${opts.baseBranch}`] : [];
      execFileSync('git', ['clone', '-q', '--depth=1', ...branchArgs, `file://${repoPath}`, managedPath], { stdio: 'pipe' });
    }
    return managedPath;
  });
  const managed = { repository: 'owner/managed-cold-branch' };
  try {
    await expectRetrievalError(
      readRepositoryFileContent({ ...managed, path: 'src/util.ts', branch: 'no-such-branch' }),
      404,
      /not found/,
    );
    fs.rmSync(managedPath, { recursive: true, force: true });
    await expectRetrievalError(
      searchRepositoryFiles({ ...managed, query: 'featureOnlyNeedle', mode: 'literal', branch: 'no-such-branch' }),
      404,
      /not found/,
    );
    for (const call of ensureRepoCloned.mock.calls) assert.equal(call.arguments[0].baseBranch, undefined);

    // An existing non-default branch is still fetched and resolved on a cold clone.
    fs.rmSync(managedPath, { recursive: true, force: true });
    const read = await readRepositoryFileContent({ ...managed, path: 'src/feature.ts', branch: 'feature' });
    assert.equal(read.commit, featureCommit);
  } finally {
    ensureRepoCloned.mock.restore();
    ensureRepoCloned.mock.resetCalls();
  }
});

// --- Managed clone freshness ---

/** A bare origin, a work clone that pushes to it, and an existing managed clone of it. */
function managedFixture(name: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `repo-retrieval-${name}-`));
  const originPath = path.join(fixtureRoot, 'origin.git');
  const workPath = path.join(fixtureRoot, 'work');
  const managedPath = path.join(clonesBasePath, 'owner', name);
  execFileSync('git', ['clone', '-q', '--bare', repoPath, originPath]);
  execFileSync('git', ['clone', '-q', originPath, workPath]);
  execFileSync('git', ['clone', '-q', originPath, managedPath]);
  const workGit = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: workPath, encoding: 'utf8' }).trim();
  const managedGit = (...args: string[]) => execFileSync('git', args, { cwd: managedPath, encoding: 'utf8', stdio: 'pipe' }).trim();
  const pushCommit = (file: string, content: string, branch = 'main') => {
    workGit('checkout', '-q', branch);
    fs.mkdirSync(path.dirname(path.join(workPath, file)), { recursive: true });
    fs.writeFileSync(path.join(workPath, file), content);
    workGit('add', '-A');
    workGit('commit', '-q', '-m', `add ${file}`);
    workGit('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    return workGit('rev-parse', 'HEAD');
  };
  return { repository: `owner/${name}`, workGit, managedGit, pushCommit, cleanup: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }) };
}

test('answers the configured branch, origin/<branch> and HEAD from origin, not a stale local branch of the shared clone', async () => {
  const fixture = managedFixture('managed-stale-main');
  try {
    // A worker left the shared clone on another branch; its local main is at the old head.
    fixture.managedGit('checkout', '-q', '-b', 'worker-task');
    const advanced = fixture.pushCommit('src/added.ts', 'export const addedOnOrigin = true;\n');
    assert.equal(fixture.managedGit('rev-parse', 'refs/heads/main'), headCommit);

    const read = await readRepositoryFileContent({ repository: fixture.repository, branch: 'main', path: 'src/added.ts' });
    assert.equal(read.commit, advanced);
    assert.equal(read.content, 'export const addedOnOrigin = true;');
    assert.equal(read.refCaveat, undefined);

    const search = await searchRepositoryFiles({ repository: fixture.repository, branch: 'main', query: 'addedOnOrigin', mode: 'literal' });
    assert.equal(search.commit, advanced);
    assert.deepEqual(search.matches.map(match => match.path), ['src/added.ts']);

    // The semantic caveat compares the index against origin's head, not the stale local branch.
    indexRow = { indexing_status: 'completed', last_indexed_at: '2026-10-01T00:00:00.000Z', last_indexed_hash: advanced };
    const semantic = await searchRepositoryFiles({ repository: fixture.repository, branch: 'main', query: 'added' });
    assert.equal(semantic.commit, advanced);
    assert.equal(semantic.freshness?.stale, false);

    for (const ref of ['origin/main', 'refs/heads/main', 'HEAD']) {
      const pinned = await readRepositoryFileContent({ repository: fixture.repository, ref, path: 'src/added.ts' });
      assert.equal(pinned.commit, advanced, ref);
    }

    // Retrieval never moves the shared clone's checkout or local branches.
    assert.equal(fixture.managedGit('rev-parse', '--abbrev-ref', 'HEAD'), 'worker-task');
    assert.equal(fixture.managedGit('rev-parse', 'refs/heads/main'), headCommit);
    assert.equal(ensureRepoCloned.mock.callCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test('does not answer for a branch deleted on origin from its stale remote-tracking ref', async () => {
  const fixture = managedFixture('managed-deleted-branch');
  try {
    const read = await readRepositoryFileContent({ repository: fixture.repository, ref: 'feature', path: 'src/feature.ts' });
    assert.equal(read.commit, featureCommit);
    fixture.workGit('push', '-q', 'origin', '--delete', 'feature');
    assert.equal(fixture.managedGit('rev-parse', 'refs/remotes/origin/feature'), featureCommit);

    await expectRetrievalError(readRepositoryFileContent({ repository: fixture.repository, ref: 'feature', path: 'src/feature.ts' }), 404, /Ref "feature" not found/);
    // Commit SHAs still resolve from the clone, abbreviated or not.
    const bySha = await readRepositoryFileContent({ repository: fixture.repository, ref: featureCommit.slice(0, 12), path: 'src/feature.ts' });
    assert.equal(bySha.commit, featureCommit);
  } finally {
    fixture.cleanup();
  }
});

test('answers from the cached commit with a caveat when origin cannot be reached', async () => {
  const fixture = managedFixture('managed-offline');
  try {
    fixture.managedGit('remote', 'set-url', 'origin', 'file:///nonexistent/propr-origin.git');

    const read = await readRepositoryFileContent({ repository: fixture.repository, branch: 'main', path: 'src/util.ts' });
    assert.equal(read.commit, headCommit);
    assert.match(read.refCaveat ?? '', /Could not refresh "main" from origin/);
    const search = await searchRepositoryFiles({ repository: fixture.repository, branch: 'main', query: 'VALIDATETOKEN', mode: 'literal' });
    assert.match(search.refCaveat ?? '', /cached copy/);

    // A full SHA already in the clone needs no fetch, so no caveat.
    const pinned = await readRepositoryFileContent({ repository: fixture.repository, ref: headCommit, path: 'src/util.ts' });
    assert.equal(pinned.refCaveat, undefined);

    // A ref with nothing cached cannot be answered and stays a retryable failure.
    await expectRetrievalError(readRepositoryFileContent({ repository: fixture.repository, ref: 'feature-never-fetched', path: 'src/util.ts' }), 502, /Failed to fetch/);
  } finally {
    fixture.cleanup();
  }
});

test('remembers a missing tag briefly instead of probing origin for it on every branch request', async () => {
  const fixture = managedFixture('managed-tag-probe');
  try {
    const first = await readRepositoryFileContent({ repository: fixture.repository, branch: 'main', path: 'src/util.ts' });
    assert.equal(first.commit, headCommit);
    // A same-named tag appearing on origin is not probed again within the cache window...
    fixture.workGit('tag', 'main', firstCommit);
    fixture.workGit('push', '-q', 'origin', 'refs/tags/main');
    const cached = await readRepositoryFileContent({ repository: fixture.repository, branch: 'main', path: 'src/util.ts' });
    assert.equal(cached.commit, headCommit);
    assert.throws(() => fixture.managedGit('rev-parse', '--verify', '--quiet', 'refs/tags/main'));
    // ...while the branch itself is still refreshed on every request.
    const advanced = fixture.pushCommit('src/later.ts', 'later\n');
    const refreshed = await readRepositoryFileContent({ repository: fixture.repository, branch: 'main', path: 'src/later.ts' });
    assert.equal(refreshed.commit, advanced);
  } finally {
    fixture.cleanup();
  }
});

// --- Bounded literal scans, encoded read limits and relevance failures ---

test('the grep aggregator parses records split across chunks and stops at its file budget', async () => {
  const { GrepAggregator } = await import('../src/services/repositoryLiteralGrep.js');
  const sha = 'c'.repeat(40);
  const output = `${sha}:a.ts\x001\x00one\n${sha}:a.ts\x002\x00two\n${sha}:b\nc.ts\x003\x00three\n${sha}:d.ts\x004\x00four\n`;
  for (let size = 1; size <= 7; size++) {
    const aggregator = new GrepAggregator(sha, 5);
    for (let at = 0; at < output.length; at += size) aggregator.push(output.slice(at, at + size));
    assert.deepEqual(aggregator.finish(), parseGitGrepOutput(output, sha, 5), `chunk size ${size}`);
  }

  const bounded = new GrepAggregator(sha, 1, 2);
  bounded.push(output);
  assert.equal(bounded.full, true);
  // Retained files keep complete counts; the file over budget is not partially counted.
  assert.deepEqual(bounded.finish().map(file => [file.path, file.matchCount]), [['a.ts', 2], ['b\nc.ts', 1]]);
});

test('literal search reports an unbounded scan as complete', async () => {
  const result = await searchRepositoryFiles({ ...base, query: 'validateToken', mode: 'literal' });
  assert.equal(result.scanTruncated, false);
  assert.equal(result.pagination.totalMatches, 5);
});

test('an encoded byte limit bounds reads by their JSON size and refuses a line no maxBytes can return', async () => {
  // Encoded, the newline separator takes two bytes: "line 1\nline 2" is 14 bytes, a third line would need 22.
  const quoted = await readRepositoryFileContent({ ...base, path: 'big.txt', maxBytes: 1000, encodedByteLimit: 15 });
  assert.equal(quoted.content, 'line 1\nline 2');
  assert.equal(quoted.truncated, true);
  assert.equal(quoted.nextStartLine, 3);

  await expectRetrievalError(
    readRepositoryFileContent({ ...base, path: 'big.txt', encodedByteLimit: 5 }),
    413,
    /Line 1 of "big\.txt" is 6 bytes once JSON-encoded, more than the 5-byte response limit, so it cannot be read at any maxBytes/,
  );
  // A hint never advises a maxBytes above what the caller accepts.
  await expectRetrievalError(
    readRepositoryFileContent({ ...base, path: 'big.txt', maxBytes: 4, maxBytesLimit: 5 }),
    413,
    /exceeds the 5-byte read limit/,
  );
});

test('semantic search reports relevance engine failures as retrieval errors', async () => {
  findRelevantFiles.mock.mockImplementationOnce(async () => { throw new Error('git ls-tree failed'); });
  await expectRetrievalError(searchRepositoryFiles({ ...base, query: 'auth' }), 500, /Semantic search failed: git ls-tree failed/);
});
