import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { McpScope } from '../../mcp/config.js';
import type { McpOAuthProvider } from '../../mcp/oauth.js';

/**
 * The production MCP HTTP path for tests: Express with `mountMcp` (its own body
 * parser, OAuth bearer authentication, `serveMcpRequest`) over a migrated
 * database. Bearer tokens are issued by the real OAuth provider; only GitHub
 * and the monitored-repository configuration are fixtures.
 */
export interface HarnessPrincipal { id: string; login: string; token: string; grantId: string; scopes: McpScope[]; repositories: string[] }
export interface McpHttpHarness {
  origin: string; db: Knex; oauth: McpOAuthProvider; config: { instanceId: string; resource: string };
  alpha: HarnessPrincipal; beta: HarnessPrincipal;
  /** GitHub `/user` lookups, one per authenticated request. */
  githubUserCalls: () => number;
  /** Hold every GitHub `/user` answer until `count` requests are waiting, then release them together. */
  holdAuthentication: (count: number) => Promise<void>;
  /** POST one JSON-RPC message and return every JSON-RPC message in the response. */
  post: (token: string | null, body: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; messages: Json[]; text: string }>;
  close: () => Promise<void>;
}
export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ENV_KEYS = ['DATA_DIR', 'DB_FILENAME', 'MCP_ENABLED', 'MCP_PUBLIC_ORIGIN', 'MCP_INSTANCE_ID', 'MCP_ENCRYPTION_KEY', 'GITHUB_USER_WHITELIST'] as const;

/** Every JSON-RPC message in a JSON or SSE response body. */
export function rpcMessages(text: string, contentType: string | null): Json[] {
  if (!text) return [];
  if (!contentType?.includes('text/event-stream')) return [].concat(JSON.parse(text));
  return text.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim()).map(line => JSON.parse(line.slice(5)));
}

/**
 * Start one harness per test file, before importing any MCP module: the
 * `@propr/core` module mock only reaches modules loaded after it.
 */
export async function startMcpHttpHarness(options: { upstream?: (request: Request) => Promise<Response> | undefined } = {}): Promise<McpHttpHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'propr-mcp-http-'));
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATA_DIR: root, DB_FILENAME: path.join(root, 'propr.sqlite'), NODE_ENV: 'test',
    MCP_ENABLED: 'true', MCP_PUBLIC_ORIGIN: 'https://instance.example', MCP_INSTANCE_ID: 'http-harness-instance',
    MCP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), GITHUB_USER_WHITELIST: 'alpha-user,beta-user',
  });
  const core = await import('@propr/core');
  const configured = ['acme/alpha', 'acme/beta'].map(name => ({ name, enabled: true, baseBranch: 'main' }));
  const boundary = mock.module('@propr/core', { namedExports: { ...core, loadMonitoredReposRaw: async () => configured } });
  const { mountMcp } = await import('../../mcp/server.js');
  const { loadMcpConfig } = await import('../../mcp/config.js');
  const { McpStore } = await import('../../mcp/store.js');
  const { McpOAuthProvider } = await import('../../mcp/oauth.js');
  const express = (await import('express')).default;

  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../../core/src/db/migrations/', import.meta.url)) });
  const config = loadMcpConfig()!;
  const oauth = new McpOAuthProvider(new McpStore(db, config.encryptionKey), config);
  const principal = async (id: string, login: string, scopes: McpScope[], repositories: string[]): Promise<HarnessPrincipal> => {
    await db('instance_members').insert({ github_user_id: id, github_username: login, role: 'member', source: 'local' });
    const credential = { id, login, username: login, displayName: login, email: null, avatarUrl: null, accessToken: `github-${login}` };
    const { grant, accessToken } = await oauth.issueDelegatedGrant({ credential, clientId: `client-${login}`, clientName: login, scopes, repositories, membershipSource: 'local', ttlMs: 600_000 });
    return { id, login, token: accessToken, grantId: grant.id, scopes: grant.scopes, repositories };
  };
  const alpha = await principal('101', 'alpha-user', ['read', 'plan'], ['acme/alpha']);
  const beta = await principal('202', 'beta-user', ['read'], ['acme/beta']);

  let userCalls = 0;
  let hold: { count: number; waiting: Array<() => void>; released: () => void } | null = null;
  const nativeFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'api.github.com') return options.upstream?.(request) ?? nativeFetch(input, init);
    const login = /^token github-(.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const owner = [alpha, beta].find(candidate => candidate.login === login);
    assert.ok(owner, 'Only a stored GitHub credential reaches GitHub');
    if (url.pathname === '/user') {
      userCalls++;
      if (hold) {
        const current = hold;
        await new Promise<void>(resolve => {
          current.waiting.push(resolve);
          if (current.waiting.length === current.count) { hold = null; current.waiting.forEach(release => release()); current.released(); }
        });
      }
      return Response.json({ id: Number(owner.id), login: owner.login });
    }
    const repository = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname)?.[1];
    if (repository && owner.repositories.includes(repository)) return Response.json({ full_name: repository, permissions: { push: true } });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  });

  const app = express();
  mountMcp(app, { db, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fetchMock.mock.restore();
    boundary.restore();
    await db.destroy();
    for (const key of ENV_KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  };

  return {
    origin, db, oauth, config, alpha, beta, close,
    githubUserCalls: () => userCalls,
    holdAuthentication: count => new Promise<void>(released => { hold = { count, waiting: [], released }; }),
    post: async (token, body, init = {}) => {
      const response = await nativeFetch(`${origin}/api/mcp`, {
        method: 'POST', signal: init.signal, body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
      });
      const text = await response.text();
      return { status: response.status, text, messages: response.ok ? rpcMessages(text, response.headers.get('content-type')) : [] };
    },
  };
}
