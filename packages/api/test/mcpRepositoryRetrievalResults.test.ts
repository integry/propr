import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import type { McpTool } from '../mcp/tools.js';

// Unit coverage for how the repository retrieval tools shape results and map
// service failures, with the retrieval service itself faked.

const repository = 'acme/repo';
let readFailure: Error | null = null;
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
    readRepositoryFileContent: async () => { throw readFailure; },
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
  });
  assert.deepEqual([result.path, result.ref, result.content], ['[redacted]/file.txt', '[redacted]', 'one\ntwo']);
});
