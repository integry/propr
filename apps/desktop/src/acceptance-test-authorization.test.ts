import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parseDesktopPairingStart, ProprClientError } from '@propr/client';
import {
  PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS,
  PACKAGED_ACCEPTANCE_TIME,
} from '../scripts/packaged-acceptance-clock.mjs';
import {
  authorizePackagedAcceptanceTest,
  packagedAcceptancePairingTiming,
} from './acceptance-test-authorization';
import { redactDesktopValue } from './secret-redaction';

const acceptanceUserData = resolve('/tmp/propr-desktop-acceptance-a1');
const defaultUserData = resolve('/tmp/default');
const input = {
  argv: ['app', '--propr-acceptance-test', `--user-data-dir=${acceptanceUserData}`],
  defaultUserDataDirectory: defaultUserData,
  environmentTriggered: true,
  isPackaged: true,
  platform: 'linux' as const,
};

describe('packaged acceptance authorization', () => {
  it('accepts only the dual-trigger packaged Linux launch with an isolated profile', () => {
    assert.equal(authorizePackagedAcceptanceTest(input), acceptanceUserData);
    assert.equal(authorizePackagedAcceptanceTest({ ...input, argv: ['app'], environmentTriggered: false }), null);
  });

  it('fails closed for partial triggers, other platforms, and the default profile', () => {
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, environmentTriggered: false }), /both/);
    assert.throws(() => authorizePackagedAcceptanceTest({ ...input, platform: 'darwin' }), /Linux/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${defaultUserData}`],
    }), /must use/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${join(acceptanceUserData, '..', 'default')}`],
    }), /must use/);
    assert.throws(() => authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app', '--propr-acceptance-test', `--user-data-dir=${join(dirname(acceptanceUserData), 'propr-desktop-acceptance-a1', '..', 'escaped')}`],
    }), /must use/);
  });

  it('supplies sleep and the shared clock only through the dual-authorized acceptance result', async () => {
    const authorizedDirectory = authorizePackagedAcceptanceTest(input);
    const timing = packagedAcceptancePairingTiming(authorizedDirectory);

    assert.ok(timing);
    assert.deepEqual(Object.keys(timing).sort(), ['now', 'sleep']);
    assert.equal(timing.now(), PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS);
    assert.equal(new Date(timing.now()).toISOString(), PACKAGED_ACCEPTANCE_TIME);
    assert.equal(PACKAGED_ACCEPTANCE_TIME, '2026-01-02T03:04:05.000Z');
    await timing.sleep(60_000);

    for (const mode of ['production', 'packaged smoke', 'ordinary runtime']) {
      assert.equal(packagedAcceptancePairingTiming(null), undefined, mode);
    }
    const untriggered = authorizePackagedAcceptanceTest({
      ...input,
      argv: ['app'],
      environmentTriggered: false,
    });
    assert.equal(packagedAcceptancePairingTiming(untriggered), undefined);

    const main = readFileSync(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    assert.match(
      main,
      /packagedAcceptancePairingTiming\(packagedAcceptanceUserDataDirectory\)/,
    );
    assert.match(main, /acceptancePairingTiming \? \{ pairingTiming: acceptancePairingTiming \} : \{\}/);
    assert.match(main, /packagedAcceptanceTest \? \{\s*reportWebSocketHandshake:/);
    assert.match(main, /desktop\.acceptance\.websocket_handshake/);
  });

  it('keeps the shared clock subject to exact pairing expiry validation', () => {
    const timing = packagedAcceptancePairingTiming(authorizePackagedAcceptanceTest(input));
    assert.ok(timing);
    const response = {
      pairingId: `dpr_${'P'.repeat(22)}`,
      deviceSecret: 'D'.repeat(43),
      approvalUrl: 'https://propr.example.test/approve',
      interval: 1,
    };

    assert.equal(parseDesktopPairingStart({
      ...response,
      expiresAt: new Date(PACKAGED_ACCEPTANCE_EPOCH_MILLISECONDS + 60_000).toISOString(),
    }, 'https://propr.example.test', timing.now).expiresAt,
    '2026-01-02T03:05:05.000Z');
    assert.throws(() => parseDesktopPairingStart({
      ...response,
      expiresAt: PACKAGED_ACCEPTANCE_TIME,
    }, 'https://propr.example.test', timing.now), (error: unknown) =>
      error instanceof ProprClientError && error.kind === 'invalid_response');
  });

  it('preserves only fixed secret-free handshake booleans through protected logging', () => {
    const evidence = {
      schemaVersion: 1,
      path: 'socket-io',
      transport: 'websocket',
      resource: 'websocket',
      scopeQueryPresent: true,
      scopeQueryCount: 1,
      scopeEqualsActive: true,
      activeBindingPresent: true,
      profileGenerationCurrent: true,
      originEqualsActive: true,
      rendererBearerPresent: false,
      rendererCookiePresent: false,
      outboundBearerPresent: true,
      bearerMainInjected: true,
      accepted: true,
      rejectionCategory: 'none',
    };
    assert.deepEqual(redactDesktopValue(evidence), evidence);
    assert.equal(JSON.stringify(evidence).includes('http'), false);
    assert.equal(JSON.stringify(evidence).includes('Bearer '), false);
  });
});
