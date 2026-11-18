import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import {
  ALL_REPOSITORIES,
  RepositoryNotAccessibleError,
  RepositoryScopeInputError,
  createRepositoryScopeResolver,
  findConfiguredRepository,
  repositoryScopeOrRespond,
} from '../repositoryScope.js';

after(async () => { await closeConnection(); });

const configured = [
  { name: 'integry/propr', enabled: true },
  { name: 'Acme/Legacy-App', enabled: false },
];

const request = (id = '7') => ({ user: { id } }) as unknown as Request;

function response() {
  const sent: { status: number; body?: Record<string, unknown> } = { status: 200 };
  const res = {
    status(code: number) { sent.status = code; return res; },
    json(value: Record<string, unknown>) { sent.body = value; return res; },
  } as unknown as Response;
  return { res, sent };
}

function resolver(options: { verified?: string[]; denied?: string[]; now?: () => number; ttl?: number } = {}) {
  const verified = options.verified ?? [];
  return createRepositoryScopeResolver({
    configuredRepositories: async () => configured,
    verifyAccess: async (_req, repository) => {
      verified.push(repository);
      if (options.denied?.includes(repository)) throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    checksGitHubAccess: () => true,
    ...(options.now ? { now: options.now } : {}),
    ...(options.ttl !== undefined ? { accessCacheTtlMs: options.ttl } : {}),
  });
}

test('a repository filter resolves case-insensitively to the configured spelling', async () => {
  const verified: string[] = [];
  const resolve = resolver({ verified });
  assert.equal(await resolve(request(), 'INTEGRY/PROPR'), 'integry/propr');
  assert.equal(await resolve(request(), ' integry/PROPR '), 'integry/propr');
  assert.equal(await resolve(request(), 'acme/legacy-app'), 'Acme/Legacy-App');
  // GitHub access is checked for the configured name, not the spelling the caller sent.
  assert.deepEqual(verified, ['integry/propr', 'Acme/Legacy-App']);
});

test('`all` and an absent filter keep meaning every repository unless the route requires one', async () => {
  const verified: string[] = [];
  const resolve = resolver({ verified });
  for (const value of [undefined, '', 'all']) assert.equal(await resolve(request(), value), ALL_REPOSITORIES);
  assert.deepEqual(verified, []);
  await assert.rejects(resolve(request(), 'all', { allowAll: false }), RepositoryScopeInputError);
  await assert.rejects(resolve(request(), undefined, { allowAll: false }), RepositoryScopeInputError);
});

test('an unconfigured repository is not accessible and GitHub is never consulted for it', async () => {
  const verified: string[] = [];
  const resolve = resolver({ verified });
  await assert.rejects(resolve(request(), 'facebook/react'), RepositoryNotAccessibleError);
  assert.deepEqual(verified, []);
});

test('a disabled repository resolves for history reads but not where an enabled one is required', async () => {
  const resolve = resolver();
  assert.equal(await resolve(request(), 'acme/legacy-app'), 'Acme/Legacy-App');
  await assert.rejects(resolve(request(), 'acme/legacy-app', { enabledOnly: true }), RepositoryNotAccessibleError);
});

test('a configured repository the caller cannot read on GitHub is not accessible', async () => {
  const resolve = resolver({ denied: ['integry/propr'] });
  const { res, sent } = response();
  assert.equal(await repositoryScopeOrRespond(request(), res, 'integry/propr', { resolver: resolve }), null);
  assert.equal(sent.status, 404);
  assert.equal(sent.body?.code, 'REPOSITORY_NOT_ACCESSIBLE');
});

test('malformed and repeated filters are invalid input', async () => {
  const resolve = resolver();
  for (const value of ['not a repo', 'owner', ['integry/propr', 'integry/propr'], ['integry/propr'], { owner: 'x' }]) {
    const { res, sent } = response();
    assert.equal(await repositoryScopeOrRespond(request(), res, value, { resolver: resolve }), null);
    assert.equal(sent.status, 400, JSON.stringify(value));
    assert.equal(sent.body?.code, 'INVALID_INPUT');
  }
});

test('proven access is reused per user for the TTL; another user is checked again', async () => {
  let clock = 1_000;
  const verified: string[] = [];
  const resolve = resolver({ verified, now: () => clock, ttl: 60_000 });
  await resolve(request('1'), 'integry/propr');
  await resolve(request('1'), 'INTEGRY/propr');
  assert.equal(verified.length, 1);
  await resolve(request('2'), 'integry/propr');
  assert.equal(verified.length, 2);
  clock += 60_001;
  await resolve(request('1'), 'integry/propr');
  assert.equal(verified.length, 3);
});

test('a GitHub outage while checking access answers 502 GITHUB_UNAVAILABLE', async () => {
  const resolve = createRepositoryScopeResolver({
    configuredRepositories: async () => configured,
    verifyAccess: async () => { throw Object.assign(new Error('Bad Gateway'), { status: 502 }); },
    checksGitHubAccess: () => true,
  });
  const { res, sent } = response();
  assert.equal(await repositoryScopeOrRespond(request(), res, 'integry/propr', { resolver: resolve }), null);
  assert.equal(sent.status, 502);
  assert.equal(sent.body?.code, 'GITHUB_UNAVAILABLE');
});

test('findConfiguredRepository prefers an enabled entry among case variants', () => {
  const entries = [{ name: 'Owner/Repo', enabled: false }, { name: 'owner/repo', enabled: true }];
  assert.equal(findConfiguredRepository(entries, 'OWNER/REPO'), 'owner/repo');
  assert.equal(findConfiguredRepository(entries, 'other/repo'), undefined);
});
