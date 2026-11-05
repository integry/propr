import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import { createGithubCodePresenter } from './github-code-presenter';
import { createGithubBrowserLogin, createGithubTokenRefresher, type GithubBrowserAuthDependencies } from './github-browser-auth';

const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const token = { access_token: 'fixture_token', token_type: 'bearer' };
function fixture(responses: unknown[] = [device, token, { login: 'propr-ultrafix', id: 123 }]) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const waits: number[] = [];
  const identities: string[] = [];
  let closed = 0;
  const dependencies: GithubBrowserAuthDependencies = {
    clientId: 'propr-client',
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json(responses.shift()); },
    presentCode: async (code, url) => {
      assert.equal(code, device.user_code); assert.equal(url, device.verification_uri);
      return async () => { closed++; };
    },
    confirmIdentity: async login => { assert.equal(closed, 1); identities.push(login); return true; },
    sleep: async ms => { waits.push(ms); },
  };
  return { dependencies, calls, waits, identities, closed: () => closed };
}

test('browser sign-in verifies and confirms identity, keeping codes out of logs and browser URL', async () => {
  const f = fixture(); const logs: string[] = [];
  assert.deepEqual(await createGithubBrowserLogin(f.dependencies)({ onLog: line => logs.push(line) }), { accessToken: token.access_token });
  assert.deepEqual(f.identities, ['propr-ultrafix']);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(f.calls[2].url, 'https://api.github.com/user');
  assert.equal(f.calls[2].options?.redirect, 'error');
  assert.equal(new Headers(f.calls[2].options?.headers).get('Authorization'), `Bearer ${token.access_token}`);
  assert.equal(new URLSearchParams(f.calls[1].options?.body as URLSearchParams).get('device_code'), device.device_code);
  for (const secret of [device.device_code, device.user_code, token.access_token]) assert.ok(!logs.join().includes(secret));
});

test('polling respects pending and cumulative slowdown intervals', async () => {
  const f = fixture([device, { error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { error: 'slow_down' }, token, { login: 'propr-ultrafix', id: 123 }]);
  await createGithubBrowserLogin(f.dependencies)();
  assert.deepEqual(f.waits, [5000, 5000, 10000, 15000]);
});

for (const error of ['access_denied', 'expired_token', 'incorrect_client_credentials']) test(`handles ${error} and closes native UI`, async () => {
  const f = fixture([device, { error }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /GitHub (sign-in|OAuth client)/);
  assert.equal(f.closed(), 1);
});

for (const uri of ['https://evil.example/login/device', 'https://github.com/login/device?code=forged', 'propr://connect', 'http://github.com/login/device']) test(`rejects untrusted verification URL ${uri}`, async () => {
  const f = fixture([{ ...device, verification_uri: uri }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /unavailable/);
  assert.equal(f.calls.length, 1);
});

test('missing public client configuration fails before browser or network access', async () => {
  const f = fixture(); delete f.dependencies.clientId;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /PROPR_DESKTOP_GITHUB_CLIENT_ID/);
  assert.equal(f.calls.length, 0);
});

test('unconfirmed identity cannot authorize setup', async () => {
  const f = fixture(); f.dependencies.confirmIdentity = async () => false;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /account was not confirmed/);
});

test('cancellation discards a late token response; a fresh attempt can retry', async () => {
  const f = fixture(); const controller = new AbortController();
  f.dependencies.sleep = async () => { controller.abort(); };
  const login = createGithubBrowserLogin(f.dependencies);
  await assert.rejects(login({ signal: controller.signal }), /cancelled/);
  assert.equal(f.calls.length, 1); assert.equal(f.closed(), 1);
  const fresh = fixture();
  Object.assign(f.dependencies, fresh.dependencies);
  assert.deepEqual(await login(), { accessToken: token.access_token });
});

test('superseded attempt cannot publish a late successful identity', async () => {
  const f = fixture(); let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.dependencies.confirmIdentity = async () => { started(); await waiting; return true; };
  const login = createGithubBrowserLogin(f.dependencies);
  const old = login(); const rejected = assert.rejects(old);
  await ready;
  const fresh = fixture(); Object.assign(f.dependencies, fresh.dependencies);
  assert.deepEqual(await login(), { accessToken: token.access_token });
  release(); await rejected;
});

test('deadline cancels polling and closes native UI', async () => {
  const f = fixture(); f.dependencies.deadlineMs = 10; delete f.dependencies.sleep;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /timed out/);
  assert.equal(f.closed(), 1);
});

test('transport exceptions containing secrets are never surfaced', async () => {
  const f = fixture(); f.dependencies.fetch = async () => { throw new Error(`GitHub ${device.device_code}`); };
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), error => {
    assert.ok(!(error as Error).message.includes(device.device_code)); return true;
  });
});

test('a token arriving after cancellation is discarded before identity lookup', async () => {
  const f = fixture(); const caller = new AbortController();
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fetch = f.dependencies.fetch!;
  f.dependencies.fetch = async (url, options) => {
    if (String(url).endsWith('/access_token')) { started(); await pending; }
    return fetch(url, options);
  };
  const result = createGithubBrowserLogin(f.dependencies)({ signal: caller.signal });
  const rejected = assert.rejects(result, /cancelled/);
  await ready; caller.abort(); release(); await rejected;
  assert.equal(f.calls.length, 2); assert.deepEqual(f.identities, []);
});

test('browser-open failure aborts the attempt without polling', async () => {
  const f = fixture(); f.dependencies.presentCode = async () => { throw new Error('OS refused to open browser'); };
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /Check your browser/);
  assert.equal(f.calls.length, 1);
});

for (const failure of ['browser rejection', 'unsafe URL', 'shutdown response', 'dialog rejection']) test(`real presenter preserves safe browser failure through login: ${failure}`, async () => {
  const f = fixture(); const logs: string[] = [];
  let opened = 0; let closed = 0;
  const present = createGithubCodePresenter({
    isShuttingDown: () => failure === 'shutdown response',
    copy: () => assert.fail('failure must not copy'),
    openExternal: async () => { opened++; throw new Error(`${device.device_code} ${device.user_code} private OS details`); },
    showDialog: async options => {
      if (failure === 'dialog rejection') throw new Error(`${device.user_code} private dialog details`);
      if (!opened) return { response: 0 };
      return new Promise(resolve => options.signal!.addEventListener('abort', () => {
        closed++; resolve({ response: 1 });
      }, { once: true }));
    },
  });
  f.dependencies.presentCode = (code, url, signal, cancel) => present(code, failure === 'unsafe URL' ? 'javascript:alert(1)' : url, signal, cancel);
  delete f.dependencies.sleep;
  await assert.rejects(createGithubBrowserLogin(f.dependencies)({ onLog: line => logs.push(line) }), error => {
    assert.equal((error as Error).message, 'GitHub browser sign-in could not complete. Check your browser and connection, then retry.');
    assert.notEqual((error as Error).name, 'AbortError');
    return true;
  });
  assert.equal(opened, failure === 'browser rejection' ? 1 : 0);
  assert.equal(closed, failure === 'browser rejection' ? 1 : 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.identities, []);
  for (const secret of [device.device_code, device.user_code, token.access_token]) assert.ok(!logs.join().includes(secret));
});

test('browser launch failure discards an in-flight token before identity lookup', async () => {
  const f = fixture(); let rejectOpen!: (error: Error) => void; let releaseToken!: () => void;
  let pollStarted!: () => void; let dialogs = 0;
  const polling = new Promise<void>(resolve => { pollStarted = resolve; });
  const pending = new Promise<void>(resolve => { releaseToken = resolve; });
  const fetch = f.dependencies.fetch!;
  f.dependencies.fetch = async (url, options) => {
    if (String(url).endsWith('/access_token')) { pollStarted(); await pending; }
    return fetch(url, options);
  };
  f.dependencies.presentCode = createGithubCodePresenter({
    isShuttingDown: () => false, copy: () => assert.fail('must not copy'),
    openExternal: () => new Promise((_, reject) => { rejectOpen = reject; }),
    showDialog: async options => {
      if (++dialogs === 1) return { response: 0 };
      return new Promise(resolve => options.signal!.addEventListener('abort', () => resolve({ response: 1 }), { once: true }));
    },
  });
  const result = createGithubBrowserLogin(f.dependencies)();
  const rejected = assert.rejects(result, /browser sign-in could not complete/);
  await polling;
  rejectOpen(new Error(`${device.device_code} private browser details`));
  await settle();
  releaseToken();
  await rejected;
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.identities, []);
});

test('expiring device-flow credentials are accepted with absolute expiry after identity confirmation', async () => {
  const expiring = { ...token, expires_in: 28800, refresh_token: 'ghr_fixture_refresh', refresh_token_expires_in: 15897600, scope: 'repo,read:org' };
  const f = fixture([device, expiring, { login: 'propr-ultrafix', id: 123 }]);
  f.dependencies.now = () => 1_000_000; const logs: string[] = [];
  assert.deepEqual(await createGithubBrowserLogin(f.dependencies)({ onLog: line => logs.push(line) }), {
    accessToken: token.access_token, expiresAt: 1_000_000 + 28_800_000,
    refreshToken: 'ghr_fixture_refresh', refreshTokenExpiresAt: 1_000_000 + 15_897_600_000,
  });
  assert.deepEqual(f.identities, ['propr-ultrafix']);
  assert.equal(new Headers(f.calls[2].options?.headers).get('Authorization'), `Bearer ${token.access_token}`);
  assert.ok(!logs.join().includes('ghr_fixture_refresh'));
});

for (const [name, grant] of [
  ['refresh token without expiry', { ...token, refresh_token: 'ghr_fixture_refresh' }],
  ['expiry without refresh token', { ...token, expires_in: 28800 }],
  ['malformed refresh token', { ...token, expires_in: 28800, refresh_token: 'bad token' }],
  ['non-integer expiry', { ...token, expires_in: '28800', refresh_token: 'ghr_fixture_refresh' }],
  ['refresh token equal to access token', { ...token, expires_in: 28800, refresh_token: token.access_token }],
] as const) test(`rejects an invalid expiring grant (${name}) before identity confirmation`, async () => {
  const f = fixture([device, grant]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /invalid expiring sign-in/);
  assert.deepEqual(f.identities, []);
  assert.equal(f.calls.length, 2);
  assert.equal(f.closed(), 1);
});

function refreshFixture(response: unknown, status = 200) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const refresh = createGithubTokenRefresher({
    clientId: 'propr-client', now: () => 5_000,
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json(response, { status }); },
  });
  return { refresh, calls };
}

test('refresh rotates an expiring credential without a client secret', async () => {
  const { refresh, calls } = refreshFixture({ access_token: 'ghu_rotated', token_type: 'bearer', expires_in: 28800, refresh_token: 'ghr_rotated', refresh_token_expires_in: 100 });
  assert.deepEqual(await refresh('ghr_original'), { accessToken: 'ghu_rotated', expiresAt: 5_000 + 28_800_000, refreshToken: 'ghr_rotated', refreshTokenExpiresAt: 5_000 + 100_000 });
  assert.equal(calls[0].url, 'https://github.com/login/oauth/access_token');
  assert.equal(calls[0].options?.redirect, 'error');
  const body = new URLSearchParams(calls[0].options?.body as URLSearchParams);
  assert.deepEqual(Object.fromEntries(body), { client_id: 'propr-client', grant_type: 'refresh_token', refresh_token: 'ghr_original' });
});

for (const error of ['bad_refresh_token', 'invalid_grant']) test(`refresh reports ${error} as revoked without provider text`, async () => {
  const { refresh } = refreshFixture({ error, error_description: 'secret-provider-text ghr_original' });
  await assert.rejects(refresh('ghr_original'), failure => {
    assert.match((failure as Error).message, /expired or was revoked/);
    assert.ok(!(failure as Error).message.includes('secret-provider-text')); return true;
  });
});

test('refresh transport, server, and non-rotating responses fail without revoking or leaking', async () => {
  for (const [response, status] of [[{ error: 'server_error' }, 500], [{ access_token: 'ghu_rotated', token_type: 'bearer' }, 200]] as const) {
    const { refresh } = refreshFixture(response, status);
    await assert.rejects(refresh('ghr_original'), /could not be renewed|invalid expiring sign-in/);
  }
  const refresh = createGithubTokenRefresher({ clientId: 'propr-client', fetch: async () => { throw new Error('ghr_original socket detail'); } });
  await assert.rejects(refresh('ghr_original'), failure => {
    assert.match((failure as Error).message, /could not be renewed/);
    assert.ok(!(failure as Error).message.includes('ghr_original')); return true;
  });
});

test('refresh fails before network access without client configuration', async () => {
  let called = false;
  const refresh = createGithubTokenRefresher({ fetch: async () => { called = true; return Response.json({}); } });
  await assert.rejects(refresh('ghr_original'), /PROPR_DESKTOP_GITHUB_CLIENT_ID/);
  assert.equal(called, false);
});

for (const error of ['device_flow_disabled', 'incorrect_client_credentials']) test(`recognizes HTTP 400 ${error} without provider text`, async () => {
  const f = fixture();
  f.dependencies.fetch = async () => Response.json({ error, error_description: 'secret-provider-text' }, { status: 400 });
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), error => {
    assert.match((error as Error).message, /Contact the desktop distributor/);
    assert.ok(!(error as Error).message.includes('secret-provider-text')); return true;
  });
});

for (const body of ['not-json', JSON.stringify({ error: 'unknown', error_description: 'private-data' })]) test('unknown HTTP error bodies remain private', async () => {
  const f = fixture(); f.dependencies.fetch = async () => new Response(body, { status: 400 });
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), error => {
    assert.ok(!(error as Error).message.includes(body)); return true;
  });
});

test('bounded opaque provider codes accept alternate printable formats', async () => {
  const alternate = { ...device, device_code: 'opaque_DEVICE.code+/=', user_code: 'code_123.456' };
  const f = fixture([alternate, token, { login: 'propr-ultrafix', id: 123 }]);
  f.dependencies.presentCode = async code => { assert.equal(code, alternate.user_code); return async () => {}; };
  f.dependencies.confirmIdentity = async () => true;
  assert.deepEqual(await createGithubBrowserLogin(f.dependencies)(), { accessToken: token.access_token });
  assert.equal(new URLSearchParams(f.calls[1].options?.body as URLSearchParams).get('device_code'), alternate.device_code);
});
for (const field of ['device_code', 'user_code']) for (const value of ['', 'a\nb', 'x'.repeat(field === 'device_code' ? 1025 : 129)]) test(`unsafe or oversized ${field} is rejected before presentation`, async () => {
  const f = fixture([{ ...device, [field]: value }]);
  await assert.rejects(createGithubBrowserLogin(f.dependencies)(), /unavailable/);
  assert.equal(f.calls.length, 1);
});


// Model Electron's async native dialog: it stays open until a button or abort.
function nativeFixture(responses?: unknown[]) {
  const f = fixture(responses);
  const dialogs: { options: MessageBoxOptions; respond(response: number): void; closed: boolean }[] = [];
  const copied: string[] = []; const opened: string[] = [];
  f.dependencies.presentCode = createGithubCodePresenter({
    isShuttingDown: () => false,
    copy: code => copied.push(code),
    openExternal: async url => { opened.push(url); },
    showDialog: options => new Promise(resolve => {
      const entry = { options, closed: false, respond: (response: number) => {
        entry.closed = true;
        options.signal!.removeEventListener('abort', abort);
        resolve({ response });
      } };
      const abort = () => entry.respond(options.cancelId!);
      dialogs.push(entry);
      options.signal!.addEventListener('abort', abort, { once: true });
      if (options.signal!.aborted) abort();
    }),
  });
  f.dependencies.confirmIdentity = async login => {
    assert.ok(dialogs.length > 0);
    assert.ok(dialogs.every(dialog => dialog.closed), 'native code UI closes before confirmation');
    f.identities.push(login);
    return true;
  };
  return { ...f, dialogs, copied, opened };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

for (const action of ['leave open', 'copy', 'open browser']) test(`real native presenter advances to verified confirmation with initial action: ${action}`, async () => {
  const f = nativeFixture(); let approve!: () => void;
  f.dependencies.sleep = () => new Promise(resolve => { approve = resolve; });
  const logs: string[] = [];
  const result = createGithubBrowserLogin(f.dependencies)({ onLog: line => logs.push(line) });
  await settle();
  assert.equal(f.dialogs.length, 1);
  assert.equal(f.dialogs[0].closed, false);
  assert.equal(f.calls.length, 1);
  if (action !== 'leave open') {
    f.dialogs[0].respond(action === 'copy' ? 1 : 0);
    await settle();
    assert.equal(f.dialogs.length, 2);
    assert.equal(f.dialogs[1].closed, false);
  }
  // Approval in another browser needs no response from the open native dialog.
  approve();
  assert.deepEqual(await result, { accessToken: token.access_token });
  assert.deepEqual(f.identities, ['propr-ultrafix']);
  assert.ok(f.dialogs.every(dialog => dialog.closed));
  assert.deepEqual(f.copied, action === 'copy' ? [device.user_code] : []);
  assert.deepEqual(f.opened, action === 'open browser' ? [device.verification_uri] : []);
  for (const secret of [device.user_code, device.device_code, token.access_token]) assert.ok(!logs.join().includes(secret));
});

for (const ending of ['native cancel', 'shutdown', 'deadline', 'provider expiry', 'device expiry']) test(`held initial native dialog closes on ${ending} and allows retry`, async () => {
  const f = nativeFixture(ending === 'provider expiry' ? [device, { error: 'expired_token' }] : undefined);
  if (ending === 'deadline') f.dependencies.deadlineMs = 10;
  if (ending === 'device expiry') {
    const fetch = f.dependencies.fetch!;
    f.dependencies.fetch = async (url, options) => String(url).endsWith('/device/code')
      ? Response.json({ ...device, expires_in: 1 }) : fetch(url, options);
  }
  if (ending !== 'provider expiry') delete f.dependencies.sleep;
  const caller = new AbortController();
  const login = createGithubBrowserLogin(f.dependencies);
  const result = login({ signal: caller.signal });
  const rejected = assert.rejects(result, ending.includes('expiry') ? /expired/ : ending === 'deadline' ? /timed out/ : /cancelled/);
  await settle();
  if (ending === 'native cancel') f.dialogs[0].respond(2);
  if (ending === 'shutdown') caller.abort();
  await rejected;
  assert.ok(f.dialogs.every(dialog => dialog.closed));
  assert.deepEqual(f.identities, []);
  const fresh = nativeFixture(); Object.assign(f.dependencies, fresh.dependencies);
  assert.deepEqual(await login(), { accessToken: token.access_token });
  assert.deepEqual(fresh.identities, ['propr-ultrafix']);
  assert.ok(fresh.dialogs.every(dialog => dialog.closed));
});

test('repeated native attempts close superseded initial dialog before a fresh confirmation', async () => {
  const f = nativeFixture(); delete f.dependencies.sleep;
  const login = createGithubBrowserLogin(f.dependencies);
  const old = login(); const rejected = assert.rejects(old);
  await settle();
  assert.equal(f.dialogs[0].closed, false);
  const fresh = nativeFixture(); Object.assign(f.dependencies, fresh.dependencies);
  assert.deepEqual(await login(), { accessToken: token.access_token });
  await rejected;
  assert.ok(f.dialogs.every(dialog => dialog.closed));
  assert.deepEqual(f.identities, []);
  assert.deepEqual(fresh.identities, ['propr-ultrafix']);
});

test('host-safe failures use fixed messages even if an Error message is overwritten', async () => {
  const { GithubBrowserSignInError } = await import('@propr/local-setup');
  const failure = new GithubBrowserSignInError('GitHub account was not confirmed. Retry sign-in and choose the intended account in GitHub.');
  failure.message = `${token.access_token} ${device.device_code} ${device.user_code}`;
  assert.match(GithubBrowserSignInError.safeMessage(failure), /account was not confirmed/);
  const arbitrary = GithubBrowserSignInError.safeMessage(new Error(failure.message));
  assert.match(arbitrary, /browser sign-in could not complete/);
  for (const secret of [token.access_token, device.device_code, device.user_code]) assert.ok(!arbitrary.includes(secret));
});
