import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import type { McpTool } from '../mcp/tools.js';

// Unit coverage for how the repository retrieval tools shape results and map
// service failures, with the retrieval service itself faked.

const repository = 'acme/repo';
let readFailure: Error | null = null;
let readResult: unknown = null;
let moduleMock: ReturnType<typeof mock.module>;
let read: McpTool;
let McpError: typeof import('../mcp/config.js').McpError;
let RepositoryRetrievalError: typeof import('@propr/core').RepositoryRetrievalError;

before(async () => {
  const actual = await import('@propr/core');
  RepositoryRetrievalError = actual.RepositoryRetrievalError;
  moduleMock = mock.module('@propr/core', { namedExports: {
    ...actual,
    loadMonitoredReposRaw: async () => [{ name: repository, enabled: true, baseBranch: 'main' }],
    readRepositoryFileContent: async () => { if (readFailure) throw readFailure; return readResult; },
  } });
  ({ McpError } = await import('../mcp/config.js'));
  const { addContextTools } = await import('../mcp/toolsContext.js');
  const tools: McpTool[] = [];
  addContextTools(tools, { db: {} as never, policy: {} as never } as never);
  read = tools.find(tool => tool.name === 'read_repository_file')!;
});

after(async () => {
  moduleMock.restore();
  await (await import('@propr/core')).closeConnection();
});

async function readError(failure: Error) {
  readFailure = failure;
  const principal = { user: { accessToken: null } };
  return read.run({ principal, args: read.schema.parse({ repository, path: 'binary file' }) } as never).then(
    () => assert.fail('expected the read to fail'),
    (error: unknown) => {
      assert.ok(error instanceof McpError);
      return { code: error.code, status: error.status };
    },
  );
}

test('retrieval failures map onto MCP codes by their typed kind, not their wording', async () => {
  // A directory literally named "binary file" is an invalid path, not a binary file.
  assert.deepEqual(await readError(new RepositoryRetrievalError('"binary file" is a directory, not a file', 400, 'invalid_path')), { code: 'INVALID_PATH', status: 400 });
  assert.deepEqual(await readError(new RepositoryRetrievalError('reworded', 400, 'binary_file')), { code: 'BINARY_FILE', status: 400 });
  assert.deepEqual(await readError(new RepositoryRetrievalError('reworded', 400, 'invalid_ref')), { code: 'INVALID_REF', status: 400 });
  assert.deepEqual(await readError(new RepositoryRetrievalError('reworded', 404, 'ref_not_found')), { code: 'REF_NOT_FOUND', status: 404 });
  assert.deepEqual(await readError(new RepositoryRetrievalError('Ref-like wording', 404, 'file_not_found')), { code: 'FILE_NOT_FOUND', status: 404 });
  // Without a kind, the status alone decides; message wording is never parsed.
  assert.deepEqual(await readError(new RepositoryRetrievalError('Invalid ref-looking binary file message', 400)), { code: 'INVALID_INPUT', status: 400 });
});

test('a fitted search page is measured with every text field already masked', async () => {
  const { fitSearchResult } = await import('../mcp/toolsContext.js');
  const { MAX_TOOL_RESULT_BYTES } = await import('../mcp/config.js');
  const { redactText } = await import('../mcp/adapter.js');
  const page = fitSearchResult({
    repository, mode: 'semantic', query: 'ghp_a', ref: 'main', commit: 'a'.repeat(40), pathPrefix: null,
    matches: Array.from({ length: 100 }, (_, index) => ({ path: `ghp_${index}/${'x'.repeat(2400)}`, score: 1, reasons: ['path-match' as const] })),
    pagination: { offset: 0, limit: 100, nextOffset: null, totalMatches: 100 },
    keywordsDetected: Array.from({ length: 2000 }, () => 'ghp_a'),
    refCaveat: 'ghp_b',
  });
  const json = JSON.stringify(page);
  assert.equal(json, redactText(json), 'masking at the executor cannot grow the page');
  assert.ok(Buffer.byteLength(json) <= MAX_TOOL_RESULT_BYTES);
  assert.ok(page.matches.length < 100);
  assert.equal(page.pagination.nextOffset, page.matches.length);
});

test('a fitted read is measured with its path and ref already masked', async () => {
  const { fitReadResult } = await import('../mcp/toolsContext.js');
  const result = fitReadResult({
    repository, path: 'ghp_x/file.txt', ref: 'ghp_y', commit: 'a'.repeat(40), content: 'one\ntwo', startLine: 1, endLine: 2,
    totalLines: 2, totalBytes: 7, returnedBytes: 7, truncated: false, nextStartLine: null,
  }, 120000);
  assert.deepEqual([result.path, result.ref, result.content], ['[redacted]/file.txt', '[redacted]', 'one\ntwo']);
});

test('a fitted read keeps the requested maxBytes after masking lengthens its lines', async () => {
  const { fitReadResult } = await import('../mcp/toolsContext.js');
  const base = { repository, path: 'secrets.txt', ref: 'main', commit: 'a'.repeat(40), totalLines: 3, totalBytes: 18, truncated: false, nextStartLine: null };

  // 'ghp_a\nbc' is 8 bytes but masks to 13; only the masked first line fits in 12.
  const dropped = fitReadResult({ ...base, content: 'ghp_a\nbc', startLine: 1, endLine: 2, returnedBytes: 8 }, 12);
  assert.deepEqual({ content: dropped.content, endLine: dropped.endLine, returnedBytes: dropped.returnedBytes, truncated: dropped.truncated, nextStartLine: dropped.nextStartLine },
    { content: '[redacted]', endLine: 1, returnedBytes: 10, truncated: true, nextStartLine: 2 });

  // A service-truncated page keeps its continuation when masking still fits.
  const fits = fitReadResult({ ...base, content: 'ghp_a', startLine: 2, endLine: 2, returnedBytes: 5, truncated: true, nextStartLine: 3 }, 10);
  assert.deepEqual([fits.content, fits.returnedBytes, fits.truncated, fits.nextStartLine], ['[redacted]', 10, true, 3]);

  // The first masked line alone exceeds maxBytes, so there is nothing to return.
  assert.throws(() => fitReadResult({ ...base, content: 'ghp_a', startLine: 1, endLine: 1, returnedBytes: 5 }, 5),
    (error: unknown) => error instanceof McpError && error.code === 'FILE_TOO_LARGE' && error.status === 413 && /maxBytes of at least 10/.test(error.message));
});

test('read_repository_file holds a masked read to the requested maxBytes', async () => {
  readFailure = null;
  readResult = { repository, path: 'secrets.txt', ref: 'main', commit: 'a'.repeat(40), content: 'ghp_a\nb', startLine: 1, endLine: 2,
    totalLines: 2, totalBytes: 8, returnedBytes: 7, truncated: false, nextStartLine: null };
  const principal = { user: { accessToken: null } };
  const { data: result } = await read.run({ principal, args: read.schema.parse({ repository, path: 'secrets.txt', maxBytes: 10 }) } as never) as { data: Record<string, unknown> };
  assert.deepEqual([result.content, result.returnedBytes, result.endLine, result.truncated, result.nextStartLine], ['[redacted]', 10, 1, true, 2]);
});
