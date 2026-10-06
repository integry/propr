import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';

// Integration coverage for search_repository_files and read_repository_file:
// the tools run through the MCP catalog, the real executor and an MCP client,
// against the real retrieval service, a real git clone and the test database.
// Only the instance repository list and the LLM behind summary scoring are faked.

const root = mkdtempSync(join(tmpdir(), 'mcp-repository-retrieval-'));
// The retrieval service reads its managed clone root at import time.
process.env.GIT_CLONES_BASE_PATH = join(root, 'clones');

const repository = 'acme/repo';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// --- Fixture: an origin repository and the managed clone the service reads from ---

const work = join(root, 'work');
const origin = join(root, 'origin.git');
const clone = join(root, 'clones', 'acme', 'repo');
const write = (file: string, content: string | Buffer) => {
  mkdirSync(dirname(join(work, file)), { recursive: true });
  writeFileSync(join(work, file), content);
};

mkdirSync(work, { recursive: true });
git(work, 'init', '-q', '-b', 'main');
git(work, 'config', 'user.email', 'test@example.com');
git(work, 'config', 'user.name', 'Test');
git(work, 'config', 'commit.gpgsign', 'false');
write('src/auth/token.ts', 'export function validateToken(token: string) {\n  return token.length > 0;\n}\n');
write('src/auth/login.ts', 'import { validateToken } from \'./token\';\n\nexport function login(token: string) {\n  if (!validateToken(token)) throw new Error(\'denied\');\n  return validateToken(token);\n}\n');
write('src/util.ts', 'export const VALIDATETOKEN_ENABLED = true;\n');
write('src/billing/invoice.ts', 'export function totalInvoice(lines: number[]) {\n  return lines.reduce((sum, line) => sum + line, 0);\n}\n');
write('docs/auth.md', '# Authentication\n\nCall validateToken before login.\n');
write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x00]));
write('notes/long.txt', Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n');
// Source text the result redactor must treat as opaque: pretty-printed JSON
// with redactor-looking keys and a 201-entry array, a JSON-looking line, and
// a credential-shaped string that must still be masked in place.
const configJson = `${JSON.stringify({ name: 'x', password: 'not-a-secret', credentials: { user: 'u' }, list: Array.from({ length: 201 }, (_, index) => index), ci: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, null, 2)}\n`;
write('data/config.json', configJson);
write('data/matrix.ts', 'export const matrix =\n  [1, 2, 3]\n;\n');
// 3000 lines of 100 bytes: larger than any single page.
write('data/large.txt', Array.from({ length: 3000 }, (_, index) => `${String(index + 1).padStart(6, '0')} ${'x'.repeat(92)}`).join('\n') + '\n');
// One line within maxBytes whose JSON encoding (every quote escaped) is larger than a response.
write('data/quotes.txt', `${'"'.repeat(150_000)}\n`);
// 100 files whose five previews each JSON-encode to ~1000 bytes: a full page would exceed the response limit.
for (let index = 0; index < 100; index++) write(`wide/f${String(index).padStart(3, '0')}.txt`, Array.from({ length: 5 }, () => `wideNeedle ${'"'.repeat(480)}`).join('\n') + '\n');
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'initial');
const head = git(work, 'rev-parse', 'HEAD');
git(root, 'clone', '-q', '--bare', work, origin);
mkdirSync(dirname(clone), { recursive: true });
git(root, 'clone', '-q', origin, clone);

// --- Fakes: instance repository list and the summary-scoring LLM ---

const monitored = [{ name: repository, enabled: true, baseBranch: 'main' }, { name: 'acme/other', enabled: true, baseBranch: 'main' }];
const rankingPrompts: string[] = [];
const summaryAgent = {
  config: { alias: 'default', defaultModel: 'test-model' },
  analyze: async (prompt: string) => {
    rankingPrompts.push(prompt);
    return { success: true, modelUsed: 'test-model', response: JSON.stringify({ files: [
      { path: 'src/auth/token.ts', score: 95, reason: 'Defines token validation' },
      { path: 'src/auth/login.ts', score: 70, reason: 'Calls token validation during login' },
    ] }) };
  },
};

type Core = typeof import('@propr/core');
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let core: Core;
let moduleMock: ReturnType<typeof mock.module>;
let deps: ToolDeps;
let catalog: McpTool[];
let executeTool: typeof import('../mcp/tools.js').executeTool;
let classifyError: typeof import('../mcp/errorEnvelope.js').classifyError;
let toToolErrorResult: typeof import('../mcp/errorEnvelope.js').toToolErrorResult;

function actor({ repositories = [repository], scopes = ['read'], gitHubAccess = true } = {}): McpPrincipal {
  return {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'caller-token' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes, repositories, createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes,
    github: { request: async () => {
      if (!gitHubAccess) throw new Error('Not Found');
      return { data: { permissions: { pull: true } } };
    } },
  } as unknown as McpPrincipal;
}

const tool = (name: string) => {
  const found = catalog.find(candidate => candidate.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
};

/** Dispatches through the catalog and the real executor, returning the tool data. */
async function call(name: string, args: Record<string, unknown>, principal = actor()): Promise<Data> {
  const result = await executeTool(tool(name), args, principal, deps) as Data;
  return result.data;
}

/** Dispatches a call expected to fail and returns the MCP error envelope. */
async function callError(name: string, args: Record<string, unknown>, principal = actor()) {
  return executeTool(tool(name), args, principal, deps).then(
    () => assert.fail(`expected ${name} to fail`),
    (error: unknown) => toToolErrorResult(classifyError(error, { sideEffectsPossible: false })).structuredContent.error,
  );
}

async function setIndexState(row: { indexing_status: string; last_indexed_at?: Date | null; last_indexed_hash?: string | null } | null) {
  await core.db('repositories').where({ full_name: repository }).delete();
  if (row) await core.db('repositories').insert({ full_name: repository, branch: 'main', ...row });
}

before(async () => {
  const actual = await import('@propr/core');
  moduleMock = mock.module('@propr/core', { namedExports: { ...actual, loadMonitoredReposRaw: async () => monitored } });
  core = await import('@propr/core');
  await core.db.migrate.latest();

  const registry = core.getAgentRegistry();
  registry.ensureInitialized = async () => {};
  registry.getDefaultAgent = () => summaryAgent as never;

  const summaries = [
    ['src/auth/token.ts', 'Token validation helper used by login'],
    ['src/auth/login.ts', 'Login flow that validates the caller token'],
    ['src/billing/invoice.ts', 'Invoice total calculation'],
  ];
  await core.db('file_summaries').where('path', 'like', `${repository}/%`).delete();
  await core.db('file_summaries').insert(summaries.map(([path, summary]) => ({ path: `${repository}/${path}`, branch: 'main', summary, commit_hash: head })));

  const { McpPolicy } = await import('../mcp/policy.js');
  const tools = await import('../mcp/tools.js');
  ({ classifyError, toToolErrorResult } = await import('../mcp/errorEnvelope.js'));
  executeTool = tools.executeTool;
  // The real policy methods, without constructing OAuth/JWKS state they never touch.
  const policy = Object.create(McpPolicy.prototype) as InstanceType<typeof McpPolicy>;
  Object.assign(policy, { config: { instanceId: 'test-instance', origin: 'https://instance.example', resource: 'https://instance.example/api/mcp' } });
  deps = { db: core.db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
  catalog = tools.createToolCatalog(deps);
});

beforeEach(() => { rankingPrompts.length = 0; });

after(async () => {
  await core.db('repositories').where({ full_name: repository }).delete();
  await core.db('file_summaries').where('path', 'like', `${repository}/%`).delete();
  moduleMock.restore();
  await core.closeConnection();
  rmSync(root, { recursive: true, force: true });
});

test('both tools are read-only, read-scoped catalog entries', () => {
  for (const name of ['search_repository_files', 'read_repository_file']) {
    assert.equal(tool(name).scope, 'read');
    assert.equal(tool(name).readOnly, true);
  }
});

describe('search_repository_files', () => {
  test('semantic search ranks files from a fresh index with relevance reasons and freshness', async () => {
    const indexedAt = new Date('2026-10-01T00:00:00.000Z');
    await setIndexState({ indexing_status: 'completed', last_indexed_at: indexedAt, last_indexed_hash: head });

    const result = await call('search_repository_files', { repository, query: 'token validation' });

    assert.equal(result.mode, 'semantic');
    assert.equal(result.ref, 'main');
    assert.equal(result.commit, head);
    assert.deepEqual(result.matches.slice(0, 2).map((match: Data) => match.path), ['src/auth/token.ts', 'src/auth/login.ts']);
    assert.ok(result.matches[0].score >= result.matches[1].score);
    assert.ok(result.matches[0].reasons.includes('semantic'), 'summary ranking is reported as a semantic reason');
    assert.ok(result.matches[0].reasons.includes('path-match'), 'path heuristics still contribute');
    assert.ok(!result.matches.some((match: Data) => match.path === 'src/billing/invoice.ts'), 'unrelated files are not ranked');
    assert.deepEqual(result.freshness, {
      indexBranch: 'main', indexingStatus: 'completed', lastIndexedAt: indexedAt.toISOString(), lastIndexedHash: head, usedIndex: true, stale: false,
    });
    assert.equal(rankingPrompts.length, 1);
    assert.match(rankingPrompts[0], /FILE src\/auth\/token\.ts: Token validation helper/, 'the indexed summaries are what gets ranked');
  });

  test('semantic search flags an index built from an older commit as stale', async () => {
    await setIndexState({ indexing_status: 'completed', last_indexed_at: new Date(), last_indexed_hash: 'f'.repeat(40) });

    const result = await call('search_repository_files', { repository, query: 'token validation' });

    assert.equal(result.freshness.usedIndex, true);
    assert.equal(result.freshness.stale, true);
    assert.match(result.freshness.caveat, /outdated summaries/);
  });

  test('semantic search degrades gracefully with a freshness caveat when the repository is not indexed', async () => {
    await setIndexState(null);

    const result = await call('search_repository_files', { repository, query: 'token validation' });

    assert.equal(rankingPrompts.length, 0, 'no summaries are ranked without an index');
    assert.ok(result.matches.length > 0, 'heuristic ranking still returns paths');
    assert.equal(result.matches[0].path, 'src/auth/token.ts');
    for (const match of result.matches) assert.ok(!match.reasons.includes('semantic'));
    assert.equal(result.freshness.indexingStatus, null);
    assert.equal(result.freshness.usedIndex, false);
    assert.equal(result.freshness.stale, true);
    assert.match(result.freshness.caveat, /has not been indexed for branch "main"/);
  });

  test('literal search returns exact matches with counts and line previews', async () => {
    const result = await call('search_repository_files', { repository, query: 'validateToken(', mode: 'literal' });

    assert.equal(result.mode, 'literal');
    assert.equal(result.commit, head);
    assert.equal(result.freshness, undefined, 'literal search reads git directly and needs no index');
    assert.deepEqual(result.matches.map((match: Data) => [match.path, match.matchCount]), [
      ['src/auth/login.ts', 2],
      ['src/auth/token.ts', 1],
    ]);
    assert.deepEqual(result.matches[0].lineMatches, [
      { lineNumber: 4, text: '  if (!validateToken(token)) throw new Error(\'denied\');' },
      { lineNumber: 5, text: '  return validateToken(token);' },
    ]);
    assert.deepEqual(result.pagination, { offset: 0, limit: 20, totalMatches: 2, nextOffset: null });
  });

  test('literal search is case-insensitive by default and honours caseSensitive', async () => {
    const paths = (result: Data) => result.matches.map((match: Data) => match.path);
    const insensitive = await call('search_repository_files', { repository, query: 'validatetoken', mode: 'literal', caseSensitive: false });
    assert.deepEqual(paths(insensitive), ['docs/auth.md', 'src/auth/login.ts', 'src/auth/token.ts', 'src/util.ts']);

    const sensitive = await call('search_repository_files', { repository, query: 'VALIDATETOKEN', mode: 'literal', caseSensitive: true });
    assert.deepEqual(paths(sensitive), ['src/util.ts']);
  });

  test('literal search with no matches returns an empty result, not an error', async () => {
    const result = await call('search_repository_files', { repository, query: 'definitely-not-in-the-repository', mode: 'literal' });

    assert.deepEqual(result.matches, []);
    assert.equal(result.pagination.totalMatches, 0);
    assert.equal(result.pagination.nextOffset, null);
  });

  test('pagination walks every match with offset, limit and nextOffset', async () => {
    const args = { repository, query: 'validatetoken', mode: 'literal', limit: 3 };
    const first = await call('search_repository_files', args);
    assert.deepEqual(first.pagination, { offset: 0, limit: 3, totalMatches: 4, nextOffset: 3 });
    assert.equal(first.matches.length, 3);

    const second = await call('search_repository_files', { ...args, offset: first.pagination.nextOffset });
    assert.deepEqual(second.pagination, { offset: 3, limit: 3, totalMatches: 4, nextOffset: null });
    assert.deepEqual(second.matches.map((match: Data) => match.path), ['src/util.ts']);
  });

  test('a subpath filter restricts results to the given prefix', async () => {
    const literal = await call('search_repository_files', { repository, query: 'validateToken', mode: 'literal', path: 'src/auth' });
    assert.equal(literal.pathPrefix, 'src/auth');
    assert.deepEqual(literal.matches.map((match: Data) => match.path), ['src/auth/login.ts', 'src/auth/token.ts']);

    await setIndexState(null);
    const semantic = await call('search_repository_files', { repository, query: 'token validation', path: 'docs/' });
    for (const match of semantic.matches) assert.ok(match.path.startsWith('docs/'), `${match.path} is inside docs/`);
  });
});

describe('read_repository_file', () => {
  test('reads a whole file', async () => {
    const result = await call('read_repository_file', { repository, path: 'src/auth/token.ts' });

    assert.equal(result.content, 'export function validateToken(token: string) {\n  return token.length > 0;\n}');
    assert.deepEqual({ startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines, truncated: result.truncated, nextStartLine: result.nextStartLine },
      { startLine: 1, endLine: 3, totalLines: 3, truncated: false, nextStartLine: null });
    assert.equal(result.ref, 'main');
    assert.equal(result.commit, head);
  });

  test('reads a line range with startLine and endLine', async () => {
    const result = await call('read_repository_file', { repository, path: 'notes/long.txt', startLine: 10, endLine: 12 });

    assert.equal(result.content, 'line 10\nline 11\nline 12');
    assert.deepEqual({ startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines, truncated: result.truncated },
      { startLine: 10, endLine: 12, totalLines: 40, truncated: false });
  });

  test('maxLines and maxBytes bound the output and report truncation with a continuation line', async () => {
    const byLines = await call('read_repository_file', { repository, path: 'notes/long.txt', maxLines: 5 });
    assert.equal(byLines.content, 'line 1\nline 2\nline 3\nline 4\nline 5');
    assert.equal(byLines.truncated, true);
    assert.equal(byLines.nextStartLine, 6);

    const byBytes = await call('read_repository_file', { repository, path: 'notes/long.txt', startLine: 6, maxBytes: 20 });
    assert.equal(byBytes.content, 'line 6\nline 7\nline 8');
    assert.equal(byBytes.returnedBytes, 20);
    assert.equal(byBytes.truncated, true);
    assert.equal(byBytes.nextStartLine, 9);
  });

  test('maps missing files, binary files and traversal onto stable error codes', async () => {
    assert.deepEqual(pick(await callError('read_repository_file', { repository, path: 'src/missing.ts' })), { code: 'FILE_NOT_FOUND', status: 404 });
    assert.deepEqual(pick(await callError('read_repository_file', { repository, path: 'assets/logo.png' })), { code: 'BINARY_FILE', status: 400 });
    for (const path of ['../etc/passwd', 'src/../../outside', '/etc/passwd']) {
      assert.deepEqual(pick(await callError('read_repository_file', { repository, path })), { code: 'INVALID_PATH', status: 400 }, path);
    }
    assert.deepEqual(pick(await callError('search_repository_files', { repository, query: 'x', path: '../outside' })), { code: 'INVALID_PATH', status: 400 });
  });
});

describe('result fidelity and response bounds', () => {
  test('reads a JSON file byte-for-byte instead of reshaping it through the result redactor', async () => {
    const result = await call('read_repository_file', { repository, path: 'data/config.json' });

    const expected = configJson.replace('ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[redacted]').replace(/\n$/, '');
    assert.equal(result.content, expected, 'line structure, every array entry and redactor-looking keys survive; credentials are still masked');
    assert.equal(result.totalLines, configJson.split('\n').length - 1);
    assert.equal(result.endLine, result.totalLines);
    assert.equal(result.truncated, false);
    assert.equal(result.returnedBytes, Buffer.byteLength(result.content), 'returnedBytes describes the delivered content');
  });

  test('literal line previews and reads of JSON-looking lines agree with the repository', async () => {
    const search = await call('search_repository_files', { repository, query: '[1, 2, 3]', mode: 'literal' });
    assert.equal(search.query, '[1, 2, 3]');
    assert.deepEqual(search.matches.map((match: Data) => [match.path, match.lineMatches]), [['data/matrix.ts', [{ lineNumber: 2, text: '  [1, 2, 3]' }]]]);

    const read = await call('read_repository_file', { repository, path: 'data/matrix.ts', startLine: 2, endLine: 2 });
    assert.equal(read.content, search.matches[0].lineMatches[0].text);
  });

  test('the largest accepted maxBytes returns a page that fits the response and continues from nextStartLine', async () => {
    const page = await call('read_repository_file', { repository, path: 'data/large.txt', maxLines: 1000, maxBytes: 200000 });
    assert.equal(page.endLine, 1000);
    assert.equal(page.truncated, true);
    assert.equal(page.nextStartLine, 1001);

    const wide = await call('read_repository_file', { repository, path: 'data/large.txt', startLine: 1001, maxLines: 1000, maxBytes: 200000 });
    assert.equal(wide.content.split('\n')[0].slice(0, 6), '001001');
    assert.ok(Buffer.byteLength(JSON.stringify(wide)) <= 256 * 1024);

    const tooLarge = await callError('read_repository_file', { repository, path: 'data/large.txt', maxBytes: 300000 });
    assert.equal(tooLarge.code, 'INVALID_INPUT', 'maxBytes beyond what a response can carry is rejected up front');
  });

  test('a line that cannot fit any response is FILE_TOO_LARGE without advice the executor would reject', async () => {
    const error = await callError('read_repository_file', { repository, path: 'data/quotes.txt' });
    assert.deepEqual(pick(error), { code: 'FILE_TOO_LARGE', status: 413 });
    assert.match(error.message, /once JSON-encoded.*cannot be read at any maxBytes/);
    assert.doesNotMatch(error.message, /request it with maxBytes/);
  });

  test('a literal page that would exceed the response limit ends early and continues from nextOffset', async () => {
    const first = await call('search_repository_files', { repository, query: 'wideNeedle', mode: 'literal', limit: 100 });
    assert.ok(first.matches.length > 0 && first.matches.length < 100, `page holds ${first.matches.length} files`);
    assert.equal(first.pagination.totalMatches, 100);
    assert.equal(first.pagination.nextOffset, first.matches.length);
    assert.equal(first.scanTruncated, false);
    for (const match of first.matches) assert.equal(match.lineMatches.length, 5);

    const seen = first.matches.map((match: Data) => match.path);
    let offset = first.pagination.nextOffset;
    while (offset !== null) {
      const next = await call('search_repository_files', { repository, query: 'wideNeedle', mode: 'literal', limit: 100, offset });
      seen.push(...next.matches.map((match: Data) => match.path));
      offset = next.pagination.nextOffset;
    }
    assert.equal(new Set(seen).size, 100, 'continuing from nextOffset reaches every file exactly once');
  });
});

function pick(error: { code: string; status: number }) {
  return { code: error.code, status: error.status };
}

describe('authorization', () => {
  test('both tools reject repositories outside the grant, instance or GitHub access with REPOSITORY_FORBIDDEN', async () => {
    const forbidden = { code: 'REPOSITORY_FORBIDDEN', status: 403 };
    const cases: Array<[Record<string, unknown>, McpPrincipal]> = [
      [{ repository: 'acme/other' }, actor()],
      [{ repository: 'acme/unconfigured' }, actor({ repositories: [repository, 'acme/unconfigured'] })],
      [{ repository }, actor({ gitHubAccess: false })],
    ];
    for (const [target, principal] of cases) {
      assert.deepEqual(pick(await callError('search_repository_files', { ...target, query: 'validateToken', mode: 'literal' }, principal)), forbidden);
      assert.deepEqual(pick(await callError('read_repository_file', { ...target, path: 'src/auth/token.ts' }, principal)), forbidden);
    }
  });

  test('callers without the read scope are rejected before any retrieval', async () => {
    assert.equal((await callError('read_repository_file', { repository, path: 'src/auth/token.ts' }, actor({ scopes: [] }))).code, 'INSUFFICIENT_SCOPE');
  });
});

test('an MCP client can run a search-then-read loop over the protocol', async (t) => {
  const [{ Client, StreamableHTTPClientTransport }, { createMcpHandler }, { toNodeHandler }, { buildMcpServer }, express] = await Promise.all([
    import('@modelcontextprotocol/client'), import('@modelcontextprotocol/server'), import('@modelcontextprotocol/node'), import('../mcp/server.js'), import('express'),
  ]);
  const principal = actor();
  const app = express.default();
  app.use(express.default.json());
  app.all('/api/mcp', async (req, res) => {
    const handler = createMcpHandler(() => buildMcpServer(principal, deps, catalog), { legacy: 'stateless' });
    try { await toNodeHandler(handler)(req, res, req.body); } finally { await handler.close(); }
  });
  const http = createServer(app);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const client = new Client({ name: 'retrieval-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/api/mcp`)) as never);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  for (const name of ['search_repository_files', 'read_repository_file']) {
    assert.equal(tools.find(listed => listed.name === name)?.annotations?.readOnlyHint, true, `${name} is listed as read-only`);
  }

  const search = await client.callTool({ name: 'search_repository_files', arguments: { repository, query: 'validateToken', mode: 'literal', path: 'src/' } });
  assert.notEqual(search.isError, true);
  const [match] = (search.structuredContent as Data).data.matches;
  const line = match.lineMatches[0].lineNumber;

  const read = await client.callTool({ name: 'read_repository_file', arguments: { repository, path: match.path, startLine: line, endLine: line } });
  assert.notEqual(read.isError, true);
  assert.equal((read.structuredContent as Data).data.content, match.lineMatches[0].text);

  const missing = await client.callTool({ name: 'read_repository_file', arguments: { repository, path: 'src/missing.ts' } });
  assert.equal(missing.isError, true);
  assert.equal((missing.structuredContent as Data).error.code, 'FILE_NOT_FOUND');
});

test('reads without a ref follow the configured base branch on origin, not the shared clone\'s stale local branch', async () => {
  // Like a worker run, leave the shared clone checked out on another branch with main behind origin.
  git(clone, 'checkout', '-q', '-b', 'worker-task');
  write('src/added.ts', 'export const addedOnOrigin = true;\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'advance main');
  const advanced = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', origin, 'HEAD:refs/heads/main');
  assert.equal(git(clone, 'rev-parse', 'refs/heads/main'), head);

  const read = await call('read_repository_file', { repository, path: 'src/added.ts' });
  assert.equal(read.ref, 'main');
  assert.equal(read.commit, advanced);
  assert.equal(read.content, 'export const addedOnOrigin = true;');

  const search = await call('search_repository_files', { repository, query: 'addedOnOrigin', mode: 'literal' });
  assert.equal(search.commit, advanced);
  assert.deepEqual(search.matches.map((match: Data) => match.path), ['src/added.ts']);
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'worker-task', 'retrieval leaves the shared checkout alone');
});
