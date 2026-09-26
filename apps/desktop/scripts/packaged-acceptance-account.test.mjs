import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Server as SocketIOServer } from 'socket.io';
import * as shared from '@propr/shared';
import { DesktopCredentialService } from '../src/credential-service.ts';
import { ProfileStore } from '../src/profile-store.ts';
import {
  authorizePackagedAcceptanceTest,
  packagedAcceptanceAccountConfirmation,
  packagedAcceptancePairingTiming,
  PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS,
} from '../src/acceptance-test-authorization.ts';
import { classifyCurrentUserRequestShape } from './packaged-acceptance-current-user.mjs';
import { PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS } from './packaged-acceptance-clock.mjs';
import { FIXED_TIME } from './acceptance-artifacts.mjs';

// These real fixtures bind Linux-only loopback aliases; authorization/current-user unit tests remain cross-platform.
const linuxFixtureOptions = {
  skip: process.platform !== 'linux' && 'Packaged acceptance fixtures require Linux loopback aliases',
};

// Exercise the runner's actual HTTP fixture without launching its top-level Electron journeys.
// Keep this extraction bounded to fixture construction, as in the stats fixture tests.
const runner = readFileSync(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = runner.indexOf(start);
  const to = runner.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return runner.slice(from, to);
};
const createFixture = async mode => {
  const fixture = runInNewContext(`
    ${between('const DEVICE_SECRET =', 'const consoleRecords =')}
    const requestRecords = [], fixtureCurrentUserRecords = [], fixtureHandshakeRecords = [], socketRecords = [];
    let activeJourney = 'account-regression', currentUserEvidenceInvalid = false;
    const QUEUE_STATS_SUBSCRIBE_EVENT = 'subscribe:queue:stats';
    ${between('const json =', 'let readyOrigin;')}
    ({ createFixture, fixtures, requestRecords, fixtureCurrentUserRecords, INSTANCE_TOKEN });
  `, {
    ...shared, URL, Buffer, createServer, SocketIOServer, once, FIXED_TIME,
    PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS, classifyCurrentUserRequestShape,
  });
  const origin = PACKAGED_ACCEPTANCE_LOOPBACK_ORIGINS[mode === 'revoked' ? 1 : 0];
  await fixture.createFixture(mode, origin);
  return {
    ...fixture, origin,
    close: async () => {
      for (const { io } of fixture.fixtures) await new Promise(resolve => io.close(resolve));
    },
  };
};

// Unit/integration storage only; packaged acceptance still uses the real OS credential backend.
const encryption = {
  isEncryptionAvailable: () => true, backend: () => 'keychain',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString(),
};
const account = { id: '2296', username: 'acceptance-admin', avatarUrl: null };
const confirmationPath = '/api/auth/user?desktop_account_confirmation=1';

const setup = async (mode, overrides = {}) => {
  const fixture = await createFixture(mode);
  const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-acceptance-'));
  const authorized = authorizePackagedAcceptanceTest({
    argv: ['app', '--propr-acceptance-test', `--user-data-dir=${directory}`],
    defaultUserDataDirectory: join(tmpdir(), 'default-desktop-profile'),
    environmentTriggered: true, isPackaged: true, platform: 'linux',
  });
  const profiles = new ProfileStore(directory, encryption);
  const confirm = packagedAcceptanceAccountConfirmation(authorized);
  let confirmations = 0;
  const service = new DesktopCredentialService({
    profiles, fetch, clientName: 'Acceptance account regression',
    pairingTiming: packagedAcceptancePairingTiming(authorized),
    openPairingBrowser: async () => {},
    confirmAccount: async (observed, origin, signal) => {
      confirmations++;
      assert.deepEqual(observed, account);
      assert.equal(origin, fixture.origin);
      assert.equal(await profiles.readCredential('operations'), null);
      assert.equal((await profiles.list()).profiles.length, 0);
      return confirm(observed, origin, signal);
    },
    ...overrides,
  });
  return {
    fixture, profiles, service,
    profile: { id: 'operations', label: 'Operations', apiBaseUrl: fixture.origin },
    confirmations: () => confirmations,
    close: async () => {
      await service.dispose(); await profiles.close(); await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

for (const mode of ['ready', 'revoked', 'renderer-only-rejection']) {
  test(`acceptance ${mode} fixture pairs, activates and verifies native invalidation through the real credential service`, linuxFixtureOptions, async () => {
    const decisions = [];
    const f = await setup(mode, { reportCredentialDecision: decision => decisions.push(decision) });
    try {
      assert.equal((await f.service.probe(f.profile)).status, 'authentication-required');
      await f.service.pair(f.profile);
      assert.equal(f.confirmations(), 1);
      assert.deepEqual((await f.profiles.list()).profiles[0].account, account);
      const probe = await f.service.probe(f.profile);
      assert.equal(probe.status, 'ready');
      const activated = await f.service.activate(probe.activationTicket);
      assert.equal(activated.status, 'ready');
      assert.equal(activated.profileId, f.profile.id);
      assert.match(activated.transportScope, /^[A-Za-z0-9_-]{22}$/);
      const url = `${f.fixture.origin}/api/auth/user?proprDesktopScopeGeneration=1`;
      const prepared = f.service.prepareRequest(url, {
        Origin: shared.DESKTOP_RENDERER_ORIGIN,
        'X-ProPR-Desktop-Transport-Scope': activated.transportScope,
      });
      assert.notEqual(prepared.cancel, true);
      const response = await fetch(url, { headers: prepared.requestHeaders });
      assert.equal(response.status, mode === 'ready' ? 200 : 401);
      const user = await response.json();
      if (mode === 'ready') {
        assert.equal(user.id, account.id);
        assert.equal(user.username, account.username);
      } else assert.equal(user.code, 'INSTANCE_TOKEN_REVOKED');
      assert.deepEqual(Array.from(f.fixture.fixtureCurrentUserRecords, record => record.source), [
        'account-confirmation', 'main', 'renderer',
      ]);
      assert.ok(f.fixture.fixtureCurrentUserRecords.every(record =>
        record.authorizationMatchesActivatedBearer && !record.cookiePresent));
      const requests = Array.from(f.fixture.requestRecords);
      const activation = requests.findIndex(record => record.url.endsWith('/activate'));
      const confirmation = requests.findIndex(record => record.url === confirmationPath);
      const reprobe = requests.findIndex(record => record.url === '/api/auth/user');
      assert.ok(activation >= 0 && confirmation > activation && reprobe > confirmation);

      if (mode !== 'ready') {
        const saved = await f.profiles.readCredential(f.profile.id);
        assert.ok(saved);
        assert.equal(f.service.isActiveConnectionScope(activated), true);
        const confirmed = mode === 'revoked';
        assert.deepEqual(await f.service.invalidate({ ...activated, code: user.code }), {
          invalidated: confirmed,
        });
        assert.deepEqual(Array.from(f.fixture.fixtureCurrentUserRecords, record => [
          record.source, record.responseStatus, record.classification,
        ]), [
          ['account-confirmation', 200, 'success'],
          ['main', 200, 'success'],
          ['renderer', 401, 'revoked'],
          ['main', confirmed ? 401 : 200, confirmed ? 'revoked' : 'success'],
        ]);
        assert.ok(f.fixture.fixtureCurrentUserRecords.every(record =>
          record.authorizationMatchesActivatedBearer && !record.cookiePresent));
        assert.deepEqual(await f.profiles.readCredential(f.profile.id), confirmed ? null : saved);
        assert.equal(f.service.isActiveConnectionScope(activated), !confirmed);
        const profiles = await f.profiles.list();
        assert.equal(profiles.profiles[0].id, f.profile.id, 'Keep the saved instance after revocation');
        if (!confirmed) {
          assert.equal(profiles.activeProfileId, f.profile.id);
          assert.deepEqual(await f.profiles.pendingRevocations(), []);
        }
        assert.deepEqual(decisions, [
          { reason: 'renderer-invalidation', outcome: 'requested' },
          { reason: 'renderer-invalidation', outcome: confirmed ? 'retired' : 'retained' },
        ]);
      }
    } finally { await f.close(); }
  });
}

test('acceptance revocation persists across request sources and resets for a new pairing', linuxFixtureOptions, async () => {
  const fixture = await createFixture('revoked');
  const nativeHeaders = { Authorization: `Bearer ${fixture.INSTANCE_TOKEN}` };
  const rendererPath = '/api/auth/user?proprDesktopScopeGeneration=1';
  const rendererHeaders = { ...nativeHeaders, Origin: shared.DESKTOP_RENDERER_ORIGIN };
  const post = async (path, body = {}) => {
    const response = await fetch(`${fixture.origin}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const check = async (path, headers, status, code) => {
    const response = await fetch(`${fixture.origin}${path}`, { headers });
    assert.equal(response.status, status);
    if (code) assert.equal((await response.json()).code, code);
    else await response.arrayBuffer();
  };
  try {
    for (let pairing = 0; pairing < 2; pairing++) {
      const started = await post('/api/desktop/pairings');
      const path = `/api/desktop/pairings/${started.pairingId}`;
      await check('/api/auth/user', nativeHeaders, 401, 'INVALID_INSTANCE_TOKEN');
      const polled = await post(`${path}/poll`, { deviceSecret: started.deviceSecret });
      await post(`${path}/activate`, {
        deviceSecret: started.deviceSecret, activationTicket: polled.activationTicket,
      });
      // An unauthenticated renderer request must not revoke the activated token.
      await check(rendererPath, { Origin: shared.DESKTOP_RENDERER_ORIGIN }, 401, 'INVALID_INSTANCE_TOKEN');
      await check(confirmationPath, nativeHeaders, 200);
      await check('/api/auth/user', nativeHeaders, 200);
      fixture.fixtureCurrentUserRecords.length = 0;
      await check(rendererPath, rendererHeaders, 401, 'INSTANCE_TOKEN_REVOKED');
      await check('/api/auth/user', nativeHeaders, 401, 'INSTANCE_TOKEN_REVOKED');
      await check(confirmationPath, nativeHeaders, 401, 'INSTANCE_TOKEN_REVOKED');
      await check(rendererPath, rendererHeaders, 401, 'INSTANCE_TOKEN_REVOKED');
      assert.deepEqual(Array.from(fixture.fixtureCurrentUserRecords, record => record.rendererRequestOccurrence), [
        2, 0, 0, 3,
      ], 'Reset renderer request occurrences for each pairing, including its unauthenticated request');
      fixture.fixtureCurrentUserRecords.length = 0;
    }
  } finally { await fixture.close(); }
});

for (const failure of ['malformed-account', 'denied-admission', 'cancelled-confirmation', 'missing-confirmation']) {
  test(`acceptance pairing never commits or activates after ${failure}`, linuxFixtureOptions, async () => {
    const f = await setup('ready', failure === 'missing-confirmation'
      ? { confirmAccount: undefined }
      : failure === 'cancelled-confirmation'
      ? { confirmAccount: async () => false }
      : { fetch: async (input, init) => input.toString().endsWith(confirmationPath)
        ? new Response(JSON.stringify(failure === 'malformed-account'
          ? { ...account, id: 'acceptance-user' } : { code: 'INSUFFICIENT_INSTANCE_PERMISSION' }),
        { status: failure === 'malformed-account' ? 200 : 403 })
        : fetch(input, init) });
    try {
      await assert.rejects(f.service.pair(f.profile), {
        code: failure.endsWith('confirmation') ? 'PAIRING_CANCELLED' : 'PAIRING_REJECTED',
      });
      assert.equal(f.confirmations(), 0);
      assert.equal(await f.profiles.readCredential(f.profile.id), null);
      assert.equal((await f.profiles.list()).profiles.length, 0);
      assert.equal((await f.service.probe(f.profile)).status, 'authentication-required');
    } finally { await f.close(); }
  });
}

test('acceptance identity routes reject inactive tokens, wrong custody and malformed confirmation requests', linuxFixtureOptions, async () => {
  const f = await setup('ready');
  const bearer = { Authorization: `Bearer ${f.fixture.INSTANCE_TOKEN}` };
  try {
    assert.equal((await fetch(`${f.fixture.origin}${confirmationPath}`, { headers: bearer })).status, 401);
    await f.service.pair(f.profile);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { ...bearer, Cookie: 'session=wrong' },
      { ...bearer, 'X-ProPR-Desktop-Transport-Scope': 'renderer-scope' },
      { ...bearer, Origin: shared.DESKTOP_RENDERER_ORIGIN }]) {
      assert.equal((await fetch(`${f.fixture.origin}${confirmationPath}`, { headers })).status, 401);
    }
    for (const path of [`${confirmationPath}&extra=1`, '/api/auth/user?desktop_account_confirmation=0']) {
      assert.equal((await fetch(`${f.fixture.origin}${path}`, { headers: bearer })).status, 401);
    }
  } finally { await f.close(); }
});
