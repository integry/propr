import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { GITHUB_SIGN_IN_REVOKED_MESSAGE, GithubBrowserSignInError, type GithubUserCredential } from '@propr/local-setup';
import { ConfigManager } from '../../config/ConfigManager.js';
import { createDefaultActions } from './hostActions.js';

const HOUR = 3_600_000;

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'propr-github-refresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = new ConfigManager(dir);
  await config.init();
  const seen: string[] = [];
  let rejectToken: string | undefined;
  let beforeRespond: ((token: string, index: number) => Promise<void>) | undefined;
  const server = createServer(async (request: IncomingMessage, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    seen.push(token);
    await beforeRespond?.(token, seen.length - 1);
    response.setHeader('content-type', 'application/json');
    if (token === rejectToken) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { code: 'unauthorized' } }));
      return;
    }
    response.end(JSON.stringify({ username: `user-of-${token}`, avatar_url: null, installations: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { dir, config, seen, relayUrl, rejectWith: (token: string) => { rejectToken = token; },
    holdResponses: (hook: (token: string, index: number) => Promise<void>) => { beforeRespond = hook; } };
}

const expiring = (accessToken: string, refreshToken: string, now: number): GithubUserCredential => ({
  accessToken, expiresAt: now + 8 * HOUR, refreshToken, refreshTokenExpiresAt: now + 4_000 * HOUR,
});

test('non-expiring browser tokens are stored without refresh metadata and never refreshed', async t => {
  const env = await setup(t);
  let refreshed = 0;
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => ({ accessToken: 'gho_static' }),
    refreshGithubCredential: async () => { refreshed++; throw new Error('unused'); },
  });
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', Date.now()));
  assert.equal(await actions.loginWithGithub(), true);
  assert.deepEqual(env.config.getGithubCredential(), { accessToken: 'gho_static' });
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-gho_static');
  assert.equal(refreshed, 0);
});

test('expiring credentials persist across restart and refresh near expiry before relay use', async t => {
  const env = await setup(t);
  let now = 1_000_000_000;
  const login = createDefaultActions(env.config, { githubBrowserLogin: async () => expiring('ghu_first', 'ghr_first', now), now: () => now });
  assert.equal(await login.loginWithGithub(), true);
  const stored = JSON.parse(readFileSync(join(env.dir, 'config.json'), 'utf8'));
  assert.equal(stored.profiles.default.githubRefreshToken, 'ghr_first');

  // A relaunch reads the same private config with a new manager and host.
  const restarted = new ConfigManager(env.dir);
  await restarted.init();
  const refreshCalls: string[] = [];
  const actions = createDefaultActions(restarted, {
    now: () => now,
    refreshGithubCredential: async refreshToken => {
      refreshCalls.push(refreshToken);
      return expiring('ghu_second', 'ghr_second', now);
    },
  });
  assert.equal(actions.hasGithubToken(), true);
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_first');
  assert.deepEqual(refreshCalls, []);

  now += 8 * HOUR - 60_000;
  // Concurrent relay calls share one rotation: a refresh token is single-use.
  const [first, second] = await Promise.all([
    actions.fetchRelayInstallations({ relayUrl: env.relayUrl }),
    actions.fetchRelayInstallations({ relayUrl: env.relayUrl }),
  ]);
  assert.equal(first.username, 'user-of-ghu_second');
  assert.equal(second.username, 'user-of-ghu_second');
  assert.deepEqual(refreshCalls, ['ghr_first']);
  const rotated = new ConfigManager(env.dir);
  await rotated.init();
  assert.deepEqual(rotated.getGithubCredential(), expiring('ghu_second', 'ghr_second', now));
});

test('a relay 401 for an expiring token triggers one refresh and retry', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_revoked_early', 'ghr_live', now));
  env.rejectWith('ghu_revoked_early');
  const actions = createDefaultActions(env.config, { refreshGithubCredential: async () => expiring('ghu_fresh', 'ghr_fresh', now) });
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_fresh');
  assert.deepEqual(env.seen, ['ghu_revoked_early', 'ghu_fresh']);
});

test('a revoked refresh grant clears the saved credential and requires a new sign-in', async t => {
  const env = await setup(t);
  let now = 2_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_revoked', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: async () => { throw new Error('unused'); },
    refreshGithubCredential: async () => { throw new GithubBrowserSignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE); },
  });
  assert.equal(actions.hasGithubToken(), true);
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), new RegExp(GITHUB_SIGN_IN_REVOKED_MESSAGE));
  assert.equal(env.config.getGithubCredential(), undefined);
  assert.equal(actions.hasGithubToken(), false);
  assert.equal(actions.githubLoginRecovery?.()?.detail, GITHUB_SIGN_IN_REVOKED_MESSAGE);
  assert.deepEqual(env.seen, []);
});

test('an expired refresh grant is not presented as a usable identity', async t => {
  const env = await setup(t);
  const now = 3_000_000_000;
  await env.config.setGithubCredential({ accessToken: 'ghu_old', expiresAt: now - HOUR, refreshToken: 'ghr_old', refreshTokenExpiresAt: now - 1 });
  let refreshed = 0;
  const actions = createDefaultActions(env.config, { now: () => now, refreshGithubCredential: async () => { refreshed++; throw new Error('unused'); } });
  assert.equal(actions.hasGithubToken(), false);
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), /expired or was revoked/);
  assert.equal(refreshed, 0);
  assert.equal(env.config.getGithubCredential(), undefined);
});

test('transient refresh failures keep the saved credential and never leak provider text', async t => {
  const env = await setup(t);
  let now = 4_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, {
    now: () => now,
    refreshGithubCredential: async () => { throw new Error('ghr_old provider body'); },
  });
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), error => {
    assert.ok(!(error as Error).message.includes('ghr_old'));
    return true;
  });
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_old');
  assert.equal(actions.hasGithubToken(), true);
});

test('a rotated credential that cannot be saved is not used and requires sign-in', async t => {
  const env = await setup(t);
  let now = 5_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_old', 'ghr_old', now));
  now += 9 * HOUR;
  const actions = createDefaultActions(env.config, { now: () => now, refreshGithubCredential: async () => expiring('ghu_new', 'ghr_new', now) });
  t.mock.method(env.config, 'setGithubCredential', async () => { throw new Error('disk full'); });
  await assert.rejects(actions.fetchRelayInstallations({ relayUrl: env.relayUrl }), /could not save it/);
  assert.equal(actions.hasGithubToken(), false);
  assert.deepEqual(env.seen, []);
});

test('an account switch confirmed during an in-flight refresh is not overwritten by the old account', async t => {
  const env = await setup(t);
  let now = 6_000_000_000;
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  now += 9 * HOUR;
  let release!: () => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
    refreshGithubCredential: async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return expiring('ghu_integry2', 'ghr_integry2', now);
    },
  });
  const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
  await refreshStarted;
  assert.equal(await actions.loginWithGithub({ force: true }), true);
  release();
  assert.equal((await discovery).username, 'user-of-ghu_ultrafix');
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
});

test('a revoked refresh for the old account does not clear an account confirmed meanwhile', async t => {
  const env = await setup(t);
  let now = 6_500_000_000;
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  now += 9 * HOUR;
  let release!: () => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
    refreshGithubCredential: async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      throw new GithubBrowserSignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE);
    },
  });
  const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
  await refreshStarted;
  assert.equal(await actions.loginWithGithub({ force: true }), true);
  release();
  assert.equal((await discovery).username, 'user-of-ghu_ultrafix');
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
  assert.equal(actions.hasGithubToken(), true);
  assert.notEqual(actions.githubLoginRecovery?.()?.detail, GITHUB_SIGN_IN_REVOKED_MESSAGE);
  assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_ultrafix');
});

test('a delayed 401 for a token renewed by a concurrent call retries with the renewal', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_early', 'ghr_live', now));
  env.rejectWith('ghu_early');
  let firstDone!: () => void;
  const firstFinished = new Promise<void>(resolve => { firstDone = resolve; });
  let secondArrived!: () => void;
  const secondSent = new Promise<void>(resolve => { secondArrived = resolve; });
  // Both original requests reach the relay with the early token before either 401 is answered,
  // and the second original request's 401 arrives only after the first call renewed and retried.
  env.holdResponses(async (token, index) => {
    if (token !== 'ghu_early') return;
    if (index === 0) await secondSent;
    if (index === 1) { secondArrived(); await firstFinished; }
  });
  const refreshCalls: string[] = [];
  const actions = createDefaultActions(env.config, {
    refreshGithubCredential: async refreshToken => { refreshCalls.push(refreshToken); return expiring('ghu_fresh', 'ghr_fresh', now); },
  });
  const first = actions.fetchRelayInstallations({ relayUrl: env.relayUrl }).finally(firstDone);
  const second = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
  assert.equal((await first).username, 'user-of-ghu_fresh');
  assert.equal((await second).username, 'user-of-ghu_fresh');
  assert.deepEqual(refreshCalls, ['ghr_live']);
  assert.deepEqual(env.seen, ['ghu_early', 'ghu_early', 'ghu_fresh', 'ghu_fresh']);
});

test('a delayed 401 is not retried under an account confirmed after the request', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  env.rejectWith('ghu_integry');
  let respond!: () => void;
  const responded = new Promise<void>(resolve => { respond = resolve; });
  let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  env.holdResponses(async () => { received(); await responded; });
  let refreshed = 0;
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
    refreshGithubCredential: async () => { refreshed++; throw new Error('unused'); },
  });
  const enrollment = actions.enrollRelay({ relayUrl: env.relayUrl, installationId: '1', label: 'host' });
  await requestReceived;
  assert.equal(await actions.loginWithGithub({ force: true }), true);
  respond();
  await assert.rejects(enrollment, (error: Error & { status?: number }) => error.status === 401);
  assert.equal(refreshed, 0);
  assert.deepEqual(env.seen, ['ghu_integry']);
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
});

test('a 401 refresh superseded by an account switch is not retried under the new account', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  env.rejectWith('ghu_integry');
  let release!: () => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>(resolve => { started = resolve; });
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
    refreshGithubCredential: async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      throw new GithubBrowserSignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE);
    },
  });
  const enrollment = actions.enrollRelay({ relayUrl: env.relayUrl, installationId: '1', label: 'host' });
  await refreshStarted;
  assert.equal(await actions.loginWithGithub({ force: true }), true);
  release();
  await assert.rejects(enrollment, (error: Error & { status?: number }) => error.status === 401);
  assert.deepEqual(env.seen, ['ghu_integry']);
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
  assert.equal(actions.hasGithubToken(), true);
});

test('a failed account switch keeps the previous credential intact', async t => {
  const env = await setup(t);
  const now = Date.now();
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  const actions = createDefaultActions(env.config, {
    githubBrowserLogin: async () => { throw new GithubBrowserSignInError('GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.'); },
  });
  assert.equal(await actions.loginWithGithub({ force: true }), false);
  assert.equal(actions.githubLoginRecovery?.()?.detail, 'GitHub returned an invalid expiring sign-in. Retry or check the OAuth app configuration.');
  assert.equal(env.config.getGithubCredential()?.accessToken, 'ghu_integry');
});

for (const fail of [false, true]) {
  test(`an account switch confirmed while the old account's renewal is ${fail ? "failing" : "persisting"} wins after reload`, async t => {
    const env = await setup(t);
    let now = 7_000_000_000;
    await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
    now += 9 * HOUR;
    const save = env.config.save.bind(env.config);
    let releaseWrite!: () => void;
    let writePaused!: () => void;
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const paused = new Promise<void>(resolve => { writePaused = resolve; });
    let saves = 0;
    t.mock.method(env.config, 'save', async () => {
      if (saves++ === 0) {
        writePaused();
        await gate;
        if (fail) throw new Error('disk full');
      }
      await save();
    });
    const setCredential = env.config.setGithubCredential.bind(env.config);
    let signInQueued!: () => void;
    const queued = new Promise<void>(resolve => { signInQueued = resolve; });
    t.mock.method(env.config, 'setGithubCredential', (credential: GithubUserCredential, options?: { replacingRefreshToken?: string }) => {
      const result = setCredential(credential, options);
      if (credential.refreshToken === 'ghr_ultrafix') signInQueued();
      return result;
    });
    const actions = createDefaultActions(env.config, {
      now: () => now,
      githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
      refreshGithubCredential: async () => expiring('ghu_integry2', 'ghr_integry2', now),
    });
    const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
    await paused;
    const login = actions.loginWithGithub({ force: true });
    await queued;
    releaseWrite();
    assert.equal(await login, true);
    // Success or failure, the old account's renewal yields to the newer sign-in.
    assert.equal((await discovery).username, 'user-of-ghu_ultrafix');

    assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
    assert.equal(actions.hasGithubToken(), true);
    assert.doesNotMatch(actions.githubLoginRecovery?.()?.detail ?? '', /could not save/);
    assert.equal((await actions.fetchRelayInstallations({ relayUrl: env.relayUrl })).username, 'user-of-ghu_ultrafix');
    const reloaded = new ConfigManager(env.dir);
    await reloaded.init();
    assert.deepEqual(reloaded.getGithubCredential(), expiring('ghu_ultrafix', 'ghr_ultrafix', now));
    assert.doesNotMatch(readFileSync(join(env.dir, 'config.json'), 'utf8'), /integry/);
    assert.ok(!env.seen.some(token => token.includes('integry')));
  });
}

test('a revoked refresh rejected while a sign-in is queued does not clear the newer account', async t => {
  const env = await setup(t);
  let now = 7_500_000_000;
  await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
  now += 9 * HOUR;
  let confirm!: (credential: GithubUserCredential) => void;
  let revoke!: (error: Error) => void;
  let loginStarted!: () => void;
  let refreshStarted!: () => void;
  const loginWaiting = new Promise<void>(resolve => { loginStarted = resolve; });
  const refreshWaiting = new Promise<void>(resolve => { refreshStarted = resolve; });
  const actions = createDefaultActions(env.config, {
    now: () => now,
    githubBrowserLogin: () => { loginStarted(); return new Promise(resolve => { confirm = resolve; }); },
    refreshGithubCredential: () => { refreshStarted(); return new Promise((_, reject) => { revoke = reject; }); },
  });
  const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
  const login = actions.loginWithGithub({ force: true });
  await Promise.all([loginWaiting, refreshWaiting]);
  // Same turn: the sign-in's write is queued before the old account's revocation cleanup.
  confirm(expiring('ghu_ultrafix', 'ghr_ultrafix', now));
  revoke(new GithubBrowserSignInError(GITHUB_SIGN_IN_REVOKED_MESSAGE));
  assert.equal(await login, true);
  assert.equal((await discovery).username, 'user-of-ghu_ultrafix');
  assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_ultrafix');
  assert.equal(actions.hasGithubToken(), true);
  assert.notEqual(actions.githubLoginRecovery?.()?.detail, GITHUB_SIGN_IN_REVOKED_MESSAGE);
  const reloaded = new ConfigManager(env.dir);
  await reloaded.init();
  assert.deepEqual(reloaded.getGithubCredential(), expiring('ghu_ultrafix', 'ghr_ultrafix', now));
});

for (const fail of [false, true]) {
  test(`a refresh waits for a queued sign-in's save and ${fail ? 'fails when it fails' : 'then uses it'}`, async t => {
    const env = await setup(t);
    let now = 8_000_000_000;
    await env.config.setGithubCredential(expiring('ghu_integry', 'ghr_integry', now));
    now += 9 * HOUR;
    const save = env.config.save.bind(env.config);
    const gates = [0, 1].map(() => {
      let release!: () => void;
      let paused!: () => void;
      return { gate: new Promise<void>(resolve => { release = resolve; }), reached: new Promise<void>(resolve => { paused = resolve; }),
        release: () => release(), paused: () => paused() };
    });
    let saves = 0;
    t.mock.method(env.config, 'save', async () => {
      const held = gates[saves++];
      if (held) {
        held.paused();
        await held.gate;
        // The second held write is the sign-in for the new account.
        if (fail && held === gates[1]) throw new Error('disk full');
      }
      await save();
    });
    const setCredential = env.config.setGithubCredential.bind(env.config);
    let signInQueued!: () => void;
    const queued = new Promise<void>(resolve => { signInQueued = resolve; });
    t.mock.method(env.config, 'setGithubCredential', (credential: GithubUserCredential, options?: { replacingRefreshToken?: string }) => {
      const result = setCredential(credential, options);
      if (credential.refreshToken === 'ghr_ultrafix') signInQueued();
      return result;
    });
    const actions = createDefaultActions(env.config, {
      now: () => now,
      githubBrowserLogin: async () => expiring('ghu_ultrafix', 'ghr_ultrafix', now),
      refreshGithubCredential: async () => expiring('ghu_integry2', 'ghr_integry2', now),
    });
    const discovery = actions.fetchRelayInstallations({ relayUrl: env.relayUrl });
    await gates[0]!.reached;
    const login = actions.loginWithGithub({ force: true });
    await queued;
    gates[0]!.release();
    await gates[1]!.reached;
    // The new account is in memory but not yet persisted: no relay call may use it.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(env.seen, []);
    gates[1]!.release();
    assert.equal(await login, !fail);
    if (fail) {
      await assert.rejects(discovery, /could not be saved/);
      assert.deepEqual(env.seen, []);
      assert.equal(env.config.getGithubCredential()?.refreshToken, 'ghr_integry2');
    } else {
      assert.equal((await discovery).username, 'user-of-ghu_ultrafix');
      assert.deepEqual(env.seen, ['ghu_ultrafix']);
    }
  });
}
