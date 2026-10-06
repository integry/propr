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
  namedExports: { getGitHubInstallationToken: async () => 'token' },
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

after(() => fs.rmSync(repoPath, { recursive: true, force: true }));

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
