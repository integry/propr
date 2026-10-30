import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createGitHubUserGrants } from '../../core/src/db/migrations/20260908000000_create_github_user_grants.js';
import { up as addGitHubOAuthGrantRevision } from '../../core/src/db/migrations/20260908010000_add_github_oauth_grant_revision.js';
import { up as addRelayRenewal, down as dropRelayRenewal } from '../../core/src/db/migrations/20261029180000_add_github_user_grant_relay_renewal.js';
import type { GitHubUser } from '../authTypes.js';
import { redeemConnectAuthorizationCode } from '../connectAuth.js';
import { ConnectGrantRenewer } from '../connectGrantRenewer.js';
import { grantIdHash, renewalBackoffMs, renewalDueAt } from '../connectGrantRenewal.js';
import { GitHubMetadataAuthorizationError, resolveGitHubMetadataToken } from '../githubMetadataAuth.js';
import { GitHubUserGrantService } from '../githubUserGrantService.js';
import type { Request } from 'express';

const RELAY = 'https://relay.example.test/v1';
const RENEW_URL = `${RELAY}/instance-auth/renew`;
const environment = { SESSION_SECRET: 'test-secret', PROPR_GH_RELAY_URL: RELAY, PROPR_GH_RELAY_TOKEN: 'prt_relay_secret' };
const user: GitHubUser = {
  id: '583231', login: 'octocat', username: 'octocat', displayName: 'octocat', email: null, avatarUrl: null,
};

let database: Knex;
let logs: string[];
const originalInfo = console.info;
const originalWarn = console.warn;

beforeEach(async () => {
  database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await createGitHubUserGrants(database);
  await addGitHubOAuthGrantRevision(database);
  await addRelayRenewal(database);
  logs = [];
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
});

afterEach(async () => {
  console.info = originalInfo;
  console.warn = originalWarn;
  // Every renewal log is sanitized: no access tokens, relay tokens or raw user ids.
  assert.doesNotMatch(logs.join('\n'), /ghu_|prt_relay_secret|583231/);
  await database.destroy();
});
after(async () => closeConnection());

interface RelayCall { url: string; authorization: string | null; body: unknown }

function relay(respond: (call: RelayCall, index: number) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: RelayCall[] } {
  const calls: RelayCall[] = [];
  const fetchImpl = (async (input, init) => {
    const request = new Request(input, init);
    const call = { url: request.url, authorization: request.headers.get('authorization'), body: JSON.parse(await request.text()) };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function renewed(token: string, expiresAt = Date.now() + 8 * 60 * 60_000): Response {
  return Response.json({ access_token: token, access_token_expires_at: new Date(expiresAt).toISOString() });
}

async function captureRenewable(service: GitHubUserGrantService, expiresInMs: number, token = 'ghu_initial-access'): Promise<void> {
  await service.capture({
    ...user, accessToken: token, tokenExpiresAt: Date.now() + expiresInMs, oauthSource: 'connect', connectRenewal: 'relay',
  });
}

async function storedGrant() {
  return database('github_user_grants').where({ github_user_id: user.id }).first();
}

test('redemption reads the renewal fields and capture stores them on the durable grant', async () => {
  const expiresAt = Date.parse('2026-10-30T02:00:00.000Z');
  const redeemed = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: RELAY,
    relayToken: 'prt_relay_secret',
    fetchImpl: (async input => String(input) === 'https://api.github.com/user'
      ? Response.json({ id: 583231, login: 'octocat' })
      : Response.json({
          username: 'octocat', avatar_url: null, access_token: 'ghu_redeemed-access',
          access_token_expires_at: '2026-10-30T02:00:00.000Z', renewal: 'relay',
        })) as typeof fetch,
  });
  assert.equal(redeemed.tokenExpiresAt, expiresAt);
  assert.equal(redeemed.connectRenewal, 'relay');
  assert.equal(redeemed.refreshToken, undefined);

  await new GitHubUserGrantService(database, environment).capture(redeemed);
  const row = await storedGrant();
  assert.equal(row.renewal, 'relay');
  assert.equal(Number(row.access_token_expires_at_ms), expiresAt);
  assert.equal(row.refresh_token_encrypted, null);
});

test('a non-expiring renewable grant stores a null expiry and is not renewed proactively', async () => {
  const redeemed = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: RELAY,
    relayToken: 'prt_relay_secret',
    fetchImpl: (async input => String(input) === 'https://api.github.com/user'
      ? Response.json({ id: 583231, login: 'octocat' })
      : Response.json({
          username: 'octocat', avatar_url: null, access_token: 'ghu_forever', access_token_expires_at: null, renewal: 'relay',
        })) as typeof fetch,
  });
  assert.equal(redeemed.tokenExpiresAt, undefined);
  const { fetchImpl, calls } = relay(() => renewed('ghu_unused'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await service.capture(redeemed);
  const resolved = await service.resolve(user.id);
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_forever');
  assert.equal(calls.length, 0);
});

test('an explicit null expiry wins over a legacy expires_in in the same redemption', async () => {
  const redeemed = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: RELAY,
    relayToken: 'prt_relay_secret',
    fetchImpl: (async input => String(input) === 'https://api.github.com/user'
      ? Response.json({ id: 583231, login: 'octocat' })
      : Response.json({
          username: 'octocat', avatar_url: null, access_token: 'ghu_forever', expires_in: 300,
          access_token_expires_at: null, renewal: 'relay',
        })) as typeof fetch,
  });
  assert.equal(redeemed.tokenExpiresAt, undefined);
  const { fetchImpl, calls } = relay(() => renewed('ghu_unused'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await service.capture(redeemed);
  assert.equal((await storedGrant()).access_token_expires_at_ms, null);
  const resolved = await service.resolve(user.id);
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_forever');
  assert.equal(calls.length, 0);
});

test('an older relay without renewal fields keeps today\'s behaviour', async () => {
  const redeemed = await redeemConnectAuthorizationCode({
    code: 'pia_code',
    relayUrl: RELAY,
    relayToken: 'prt_relay_secret',
    fetchImpl: (async input => String(input) === 'https://api.github.com/user'
      ? Response.json({ id: 583231, login: 'octocat' })
      : Response.json({ username: 'octocat', avatar_url: null, access_token: 'ghu_legacy-access' })) as typeof fetch,
  });
  assert.equal(redeemed.connectRenewal, undefined);
  assert.equal(redeemed.tokenExpiresAt, undefined);

  const { fetchImpl, calls } = relay(() => renewed('ghu_unused'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await service.capture(redeemed);
  assert.equal((await storedGrant()).renewal, null);
  const resolved = await service.resolve(user.id);
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_legacy-access');
  // A rejected token is detected as missing refresh material before any relay request.
  assert.deepEqual(await service.resolve(user.id, true), { status: 'reauth_required', reason: 'missing_refresh_token' });
  assert.equal(calls.length, 0);
});

test('a database without the renewal migration still captures and resolves grants', async () => {
  await dropRelayRenewal(database);
  const service = new GitHubUserGrantService(database, environment);
  await captureRenewable(service, 60 * 60_000, 'ghu_unmigrated');
  const resolved = await service.resolve(user.id);
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_unmigrated');
});

test('renews proactively about ten minutes before expiry and replaces the stored credential', async () => {
  const { fetchImpl, calls } = relay(() => renewed('ghu_renewed-access'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);

  await captureRenewable(service, 30 * 60_000);
  const early = await service.resolve(user.id);
  assert.equal(early.status === 'active' && early.accessToken, 'ghu_initial-access');
  assert.equal(calls.length, 0);

  await captureRenewable(service, 9 * 60_000);
  const before = await storedGrant();
  const resolved = await service.resolve(user.id);
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_renewed-access');
  assert.ok(resolved.status === 'active' && (resolved.tokenExpiresAt ?? 0) > Date.now() + 7 * 60 * 60_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RENEW_URL);
  assert.equal(calls[0].authorization, 'Bearer prt_relay_secret');
  assert.deepEqual(calls[0].body, { github_user_id: user.id });

  const after = await storedGrant();
  assert.equal(after.renewal, 'relay');
  assert.equal(after.status, 'active');
  assert.equal(after.renewal_lease_owner, null);
  assert.ok(Number(after.grant_revision) > Number(before.grant_revision));
  assert.doesNotMatch(JSON.stringify(after), /renewed-access/);
  assert.match(logs.join('\n'), new RegExp(`"grant":"${grantIdHash(user.id)}","outcome":"renewed"`));
});

test('the renewal moment includes a stable jitter of at most two minutes', () => {
  const expiresAt = Date.now() + 60 * 60_000;
  const due = renewalDueAt('grant-key', expiresAt);
  assert.equal(renewalDueAt('grant-key', expiresAt), due);
  assert.ok(due <= expiresAt - 10 * 60_000 && due > expiresAt - 12 * 60_000);
});

test('one renewal is in flight across concurrent callers and processes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fetchImpl, calls } = relay(async () => { await gate; return renewed('ghu_single-flight'); });
  // Two services stand in for separate processes (API, daemon) sharing the database.
  const api = new GitHubUserGrantService(database, environment, fetchImpl);
  const daemon = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(api, 5 * 60_000);

  const pending = [api.resolve(user.id), api.resolve(user.id), daemon.resolve(user.id), daemon.resolve(user.id, true)];
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  const results = await Promise.all(pending);

  assert.equal(calls.length, 1);
  for (const result of results) assert.equal(result.status === 'active' && result.accessToken, 'ghu_single-flight');
});

test('a GitHub 401 triggers one renewal and one retry', async () => {
  const { fetchImpl, calls } = relay(() => renewed('ghu_after-401'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  // Not due for proactive renewal: GitHub rejected the token before its stated expiry.
  await captureRenewable(service, 2 * 60 * 60_000, 'ghu_rejected');
  const github: string[] = [];
  const callGitHub = async (token: string) => {
    github.push(token);
    if (token === 'ghu_rejected') throw Object.assign(new Error('Bad credentials'), { status: 401 });
    return 'ok';
  };
  const request = { user, authenticationMethod: 'instance_token' } as Request;

  let token = await resolveGitHubMetadataToken(request, service);
  let result: string;
  try {
    result = await callGitHub(token);
  } catch (error) {
    assert.equal((error as { status?: number }).status, 401);
    token = await resolveGitHubMetadataToken(request, service, true);
    result = await callGitHub(token);
  }

  assert.equal(result, 'ok');
  assert.deepEqual(github, ['ghu_rejected', 'ghu_after-401']);
  assert.equal(calls.length, 1);
});

for (const [code, message] of [
  ['renewal_revoked', /authorization for Connect was revoked/],
  ['renewal_expired', /expired after the refresh window/],
  ['reauth_required', /sign in to GitHub again/],
] as const) {
  test(`relay ${code} marks the grant reauth_required with a precise reason`, async () => {
    const { fetchImpl, calls } = relay(() => Response.json({ error: code }, { status: 401 }));
    const service = new GitHubUserGrantService(database, environment, fetchImpl);
    await captureRenewable(service, 5 * 60_000);

    assert.deepEqual(await service.resolve(user.id), { status: 'reauth_required', reason: code });
    const row = await storedGrant();
    assert.equal(row.status, 'reauth_required');
    assert.equal(row.last_error_code, code);
    await assert.rejects(
      resolveGitHubMetadataToken({ user, authenticationMethod: 'instance_token' } as Request, service),
      (error: unknown) => error instanceof GitHubMetadataAuthorizationError
        && error.code === 'GITHUB_REAUTH_REQUIRED' && error.reason === code && message.test(error.message),
    );
    assert.equal(calls.length, 1);
    assert.match(logs.join('\n'), new RegExp(`"outcome":"reauth_required".*"error_code":"${code}"`));
  });
}

test('renewal_unavailable keeps a valid token, then asks for one more sign-in', async () => {
  const { fetchImpl, calls } = relay(() => Response.json({ error: 'renewal_unavailable' }, { status: 409 }));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(service, 9 * 60_000);

  const proactive = await service.resolve(user.id);
  assert.equal(proactive.status === 'active' && proactive.accessToken, 'ghu_initial-access');
  assert.equal((await storedGrant()).renewal, null);
  assert.equal(calls.length, 1);

  // The grant now follows today's path: the rejected token needs a new sign-in.
  assert.deepEqual(await service.resolve(user.id, true), { status: 'reauth_required', reason: 'missing_refresh_token' });
  await assert.rejects(
    resolveGitHubMetadataToken({ user, authenticationMethod: 'instance_token' } as Request, service),
    (error: unknown) => error instanceof GitHubMetadataAuthorizationError
      && error.reason === 'missing_refresh_token' && /once to get a renewable authorization/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test('renewal_unavailable after a 401 marks missing_refresh_token immediately', async () => {
  const { fetchImpl } = relay(() => Response.json({ error: 'renewal_unavailable' }, { status: 409 }));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(service, 2 * 60 * 60_000);
  assert.deepEqual(await service.resolve(user.id, true), { status: 'reauth_required', reason: 'missing_refresh_token' });
});

for (const [label, respond] of [
  ['a 5xx', () => new Response('unavailable', { status: 503 })],
  ['a 429', () => Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '120' } })],
  ['a network failure', () => { throw new TypeError('fetch failed'); }],
  ['a success response missing access_token_expires_at', () => Response.json({ access_token: 'ghu_renewed-no-expiry' })],
] as const) {
  test(`${label} backs off without marking the grant reauth_required`, async () => {
    const { fetchImpl, calls } = relay(respond);
    const service = new GitHubUserGrantService(database, environment, fetchImpl);
    await captureRenewable(service, 5 * 60_000);
    const originalExpiry = Number((await storedGrant()).access_token_expires_at_ms);

    const first = await service.resolve(user.id);
    assert.equal(first.status === 'active' && first.accessToken, 'ghu_initial-access');
    const row = await storedGrant();
    assert.equal(row.status, 'active');
    assert.equal(Number(row.access_token_expires_at_ms), originalExpiry);
    assert.equal(Number(row.renewal_failures), 1);
    assert.ok(Number(row.renewal_retry_after_ms) > Date.now());

    // Backing off: no second relay call; the unexpired token stays usable.
    const second = await service.resolve(user.id);
    assert.equal(second.status === 'active' && second.accessToken, 'ghu_initial-access');
    assert.deepEqual(await service.resolve(user.id, true), { status: 'temporarily_unavailable' });
    assert.equal(calls.length, 1);
    assert.equal((await storedGrant()).status, 'active');
  });
}

test('a Retry-After longer than the local backoff cap is honoured in full', async () => {
  assert.ok(renewalBackoffMs(1, 30 * 60_000) >= 30 * 60_000);
  assert.ok(renewalBackoffMs(20) <= 10 * 60_000);

  const { fetchImpl, calls } = relay(() => Response.json(
    { error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '1800' } },
  ));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(service, 5 * 60_000);
  const before = Date.now();
  await service.resolve(user.id);
  assert.ok(Number((await storedGrant()).renewal_retry_after_ms) >= before + 1800 * 1000);
  assert.equal(calls.length, 1);
});

test('a backoff persisted by another process blocks a caller holding a stale due row', async () => {
  const { fetchImpl, calls } = relay(() => Response.json(
    { error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '1800' } },
  ));
  const api = new GitHubUserGrantService(database, environment, fetchImpl);
  const daemon = new ConnectGrantRenewer(database, environment, fetchImpl, token => token);
  await captureRenewable(api, 5 * 60_000);
  // The daemon read the due grant before the API persisted the relay's 429 backoff and released its lease.
  const stale = await storedGrant();
  await api.resolve(user.id);
  const persisted = await storedGrant();
  assert.equal(persisted.renewal_lease_owner, null);

  const resolved = await daemon.renewIfDue(stale, false);
  assert.equal(resolved !== 'missing' && resolved !== 'temporarily_unavailable' && resolved.access_token_encrypted,
    persisted.access_token_encrypted);
  assert.equal(calls.length, 1);
  const after = await storedGrant();
  assert.equal(Number(after.renewal_retry_after_ms), Number(persisted.renewal_retry_after_ms));
  assert.equal(Number(after.renewal_failures), 1);
});

test('failure counting after an elapsed backoff uses the leased row, not a stale read', async () => {
  const { fetchImpl, calls } = relay(() => new Response('unavailable', { status: 503 }));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  const renewer = new ConnectGrantRenewer(database, environment, fetchImpl, token => token);
  await captureRenewable(service, 5 * 60_000);
  const stale = await storedGrant();
  await database('github_user_grants').update({ renewal_failures: 3, renewal_retry_after_ms: Date.now() - 1 });

  await renewer.renewIfDue(stale, false);
  assert.equal(calls.length, 1);
  const row = await storedGrant();
  assert.equal(Number(row.renewal_failures), 4);
  assert.ok(Number(row.renewal_retry_after_ms) > Date.now());
});

test('an expired token with a transient relay failure is temporarily unavailable, not reauth_required', async () => {
  const { fetchImpl, calls } = relay((_call, index) => index === 0
    ? new Response('bad gateway', { status: 502 })
    : renewed('ghu_recovered'));
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(service, -60_000);

  assert.deepEqual(await service.resolve(user.id), { status: 'temporarily_unavailable' });
  assert.equal((await storedGrant()).status, 'active');

  // Once the backoff has elapsed the next caller renews and recovers.
  await database('github_user_grants').update({ renewal_retry_after_ms: Date.now() - 1 });
  const recovered = await service.resolve(user.id);
  assert.equal(recovered.status === 'active' && recovered.accessToken, 'ghu_recovered');
  assert.equal(Number((await storedGrant()).renewal_failures), 0);
  assert.equal(calls.length, 2);
});

test('a new sign-in during renewal wins over the renewed credential', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { fetchImpl } = relay(async () => { await gate; return renewed('ghu_stale-renewal'); });
  const service = new GitHubUserGrantService(database, environment, fetchImpl);
  await captureRenewable(service, 5 * 60_000);

  const pending = service.resolve(user.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  await captureRenewable(service, 8 * 60 * 60_000, 'ghu_fresh-sign-in');
  release();

  const resolved = await pending;
  assert.equal(resolved.status === 'active' && resolved.accessToken, 'ghu_fresh-sign-in');
  const current = await service.resolve(user.id);
  assert.equal(current.status === 'active' && current.accessToken, 'ghu_fresh-sign-in');
});
