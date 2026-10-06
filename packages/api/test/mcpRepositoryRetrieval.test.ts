import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { McpPrincipal } from '../mcp/policy.js';
import type { ReadRepositoryFileOptions, SearchRepositoryFilesOptions } from '@propr/core';

after(async () => closeConnection());

const repository = 'acme/repo';

function actor(repositories = [repository], allowGitHub = true): McpPrincipal {
  return {
    user: { id: '123', login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'caller-token' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    grant: { id: 'grant', ownerId: '123', clientId: 'client', clientName: 'Test', instanceId: 'test-instance',
      resource: 'https://instance.example/api/mcp', scopes: ['read'], repositories, createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local' },
    scopes: ['read'],
    github: { request: async () => { if (!allowGitHub) throw new Error('Not Found'); return { data: { permissions: { pull: true } } }; } },
  } as unknown as McpPrincipal;
}

test('repository search and read tools authorize, validate and map retrieval failures', async () => {
  const core = await import('@propr/core');
  const searches: SearchRepositoryFilesOptions[] = [];
  const reads: ReadRepositoryFileOptions[] = [];
  const moduleMock = mock.module('@propr/core', { namedExports: { ...core,
    loadMonitoredReposRaw: async () => [{ name: repository, enabled: true, baseBranch: 'main' }, { name: 'acme/off', enabled: false, baseBranch: 'main' }],
    searchRepositoryFiles: async (options: SearchRepositoryFilesOptions) => {
      searches.push(options);
      return { repository, mode: options.mode, query: options.query, ref: options.ref || options.branch, commit: 'abc', pathPrefix: options.path ?? null,
        matches: [{ path: 'src/auth.ts', matchCount: 2, lineMatches: [{ lineNumber: 4, text: 'validateToken()' }] }],
        pagination: { offset: options.offset, limit: options.limit, nextOffset: null, totalMatches: 1 } };
    },
    readRepositoryFileContent: async (options: ReadRepositoryFileOptions) => {
      reads.push(options);
      if (options.path === 'image.png') throw new core.RepositoryRetrievalError('"image.png" appears to be a binary file and cannot be read as text', 400);
      if (options.path === 'missing.ts') throw new core.RepositoryRetrievalError('File "missing.ts" not found in acme/repo at abc', 404);
      if (options.path === 'src') throw new core.RepositoryRetrievalError('"src" is a directory, not a file', 400);
      if (options.ref === 'nope') throw new core.RepositoryRetrievalError('Ref "nope" not found in acme/repo', 404);
      return { repository, path: options.path, ref: options.ref || options.branch, commit: 'abc', content: 'line 2\n', startLine: options.startLine, endLine: 2,
        totalLines: 10, totalBytes: 70, returnedBytes: 7, truncated: true, nextStartLine: 3 };
    },
  } });
  try {
    const { McpPolicy } = await import('../mcp/policy.js');
    const { createToolCatalog, executeTool } = await import('../mcp/tools.js');
    const { McpError } = await import('../mcp/config.js');
    const { classifyError, toToolErrorResult } = await import('../mcp/errorEnvelope.js');
    // The real policy methods, without constructing OAuth/JWKS state they never touch.
    const policy = Object.create(McpPolicy.prototype) as InstanceType<typeof McpPolicy>;
    const deps = { db: {} as never, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never };
    const catalog = createToolCatalog(deps);
    const search = catalog.find(tool => tool.name === 'search_repository_files')!;
    const read = catalog.find(tool => tool.name === 'read_repository_file')!;
    for (const tool of [search, read]) { assert.equal(tool.scope, 'read'); assert.equal(tool.readOnly, true); }
    const run = (tool: typeof search, args: Record<string, unknown>, principal = actor()) => tool.run({ principal, args: tool.schema.parse(args) });
    const rejects = (promise: Promise<unknown>, code: string, status: number) => assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof McpError); assert.equal(error.code, code); assert.equal(error.status, status); return true;
    });

    const semantic = await run(search, { repository, query: 'token validation' });
    assert.equal(semantic.isError, undefined);
    assert.deepEqual({ mode: searches[0].mode, branch: searches[0].branch, authToken: searches[0].authToken, offset: searches[0].offset, limit: searches[0].limit },
      { mode: 'semantic', branch: 'main', authToken: 'caller-token', offset: 0, limit: 20 });
    await run(search, { repository, query: 'validateToken()', mode: 'literal', ref: 'v1.2.0', path: 'src', caseSensitive: true, limit: 5 });
    assert.deepEqual({ mode: searches[1].mode, ref: searches[1].ref, path: searches[1].path, caseSensitive: searches[1].caseSensitive, limit: searches[1].limit },
      { mode: 'literal', ref: 'v1.2.0', path: 'src', caseSensitive: true, limit: 5 });
    assert.throws(() => search.schema.parse({ repository, query: 'x', mode: 'regex' }));
    assert.throws(() => search.schema.parse({ repository, query: '' }));

    const result = await run(read, { repository, path: 'src/auth.ts', startLine: 2 });
    assert.equal(reads[0].maxLines, 800);
    assert.equal(reads[0].maxBytes, 120000);
    assert.equal(reads[0].authToken, 'caller-token');
    assert.match(JSON.stringify(result), /nextStartLine/);
    assert.throws(() => read.schema.parse({ repository, path: 'a.ts', maxLines: 1001 }));

    const before = reads.length;
    for (const path of ['../etc/passwd', '/etc/passwd', 'src\\auth.ts', 'src/../../x']) await rejects(run(read, { repository, path }), 'INVALID_PATH', 400);
    await rejects(run(search, { repository, query: 'x', path: '../outside' }), 'INVALID_PATH', 400);
    assert.equal(reads.length, before, 'unsafe paths never reach git');
    await rejects(run(read, { repository, path: 'image.png' }), 'BINARY_FILE', 400);
    await rejects(run(read, { repository, path: 'missing.ts' }), 'FILE_NOT_FOUND', 404);
    await rejects(run(read, { repository, path: 'src' }), 'INVALID_PATH', 400);
    await rejects(run(read, { repository, path: 'a.ts', ref: 'nope' }), 'REF_NOT_FOUND', 404);

    // Ungranted, disabled and GitHub-inaccessible repositories are rejected before any retrieval.
    const calls = searches.length + reads.length;
    await rejects(run(search, { repository: 'acme/other', query: 'x' }), 'REPOSITORY_FORBIDDEN', 403);
    await rejects(run(read, { repository: 'acme/off', path: 'a.ts' }, actor(['acme/off'])), 'REPOSITORY_FORBIDDEN', 403);
    await rejects(run(read, { repository, path: 'a.ts' }, actor([repository], false)), 'REPOSITORY_FORBIDDEN', 403);
    assert.equal(searches.length + reads.length, calls);

    // Through the real executor (scope and repository policy included), failures
    // surface as the standard error envelope the MCP server returns.
    const envelope = (args: Record<string, unknown>, principal = actor()) => executeTool(read, args, principal, deps)
      .then(() => assert.fail('expected the executor to reject'), (error: unknown) => toToolErrorResult(classifyError(error, { sideEffectsPossible: false })));
    const traversal = await envelope({ repository, path: '../x' });
    assert.equal(traversal.isError, true);
    assert.deepEqual({ code: traversal.structuredContent.error.code, status: traversal.structuredContent.error.status }, { code: 'INVALID_PATH', status: 400 });
    const unscoped = await envelope({ repository, path: 'a.ts' }, { ...actor(), scopes: [] } as McpPrincipal);
    assert.equal(unscoped.structuredContent.error.code, 'INSUFFICIENT_SCOPE');
    assert.equal(reads.length, before + 4, 'executor rejections never reach git');
  } finally {
    moduleMock.restore();
  }
});
