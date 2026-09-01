import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { PROPR_API_ORIGIN_PARITY_CASES } from '@propr/shared';
import { up as createDesktopAuthTables } from '../../core/src/db/migrations/20260829000000_create_desktop_auth.js';
import { up as addTwoPhaseDesktopPairing } from '../../core/src/db/migrations/20260830000000_add_two_phase_desktop_pairing.js';
import { DesktopAuthError, DesktopAuthService } from '../desktopAuthService.js';

let database: Knex;
let now: Date;

const pairingBinding = (origin = 'https://app.example.test') => ({
  instanceId: 'profile-a',
  origin,
  scope: 'desktop-instance' as const,
  credentialGeneration: 'G'.repeat(22),
});

const startPairing = (
  target: DesktopAuthService,
  name: string,
  origin = 'https://app.example.test',
) => target.startPairing(name, pairingBinding(origin));

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await createDesktopAuthTables(database);
  await addTwoPhaseDesktopPairing(database);
  now = new Date('2026-08-29T14:00:00.000Z');
});

afterEach(async () => database.destroy());
after(async () => closeConnection());

describe('desktop managed Connect pairing authority', () => {
  test('uses the configured API browser entry and preserves only a managed hosted tunnel selector', async () => {
    const hosted = new DesktopAuthService({
      database,
      now: () => new Date(now),
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://t-instance123.propr.dev',
    });
    const pairing = await startPairing(hosted, 'Windows desktop', 'https://t-instance123.propr.dev');

    assert.equal(
      pairing.approvalUrl,
      `https://t-instance123.propr.dev/api/desktop/pairings/${pairing.pairingId}/browser`,
    );
    assert.equal(
      hosted.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}&tunnel=t-instance123.propr.dev`,
    );
    const selfManaged = new DesktopAuthService({
      database,
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://t-tenant.propr.dev.example.com',
    });
    assert.equal(
      selfManaged.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}`,
    );
  });

  test('does not place a Connect selector in hosted approval URLs for lookalike API hosts', async () => {
    const lookalike = new DesktopAuthService({
      database,
      now: () => new Date(now),
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://t-instance123.propr.dev.example.com',
    });
    const pairing = await startPairing(lookalike, 'Lookalike test');

    assert.equal(
      lookalike.getFrontendApprovalUrl(pairing.pairingId).toString(),
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairing.pairingId}`,
    );
  });

  test('rejects noncanonical reserved API_PUBLIC_URL spellings before starting pairing', async () => {
    for (const publicApiUrl of [
      ' https://t-instance123.propr.dev',
      'https://t-instance123.propr.dev ',
      'https://t-instance123.propr.dev/',
      'https://t-instance123.propr.dev//',
      'HTTPS://t-instance123.propr.dev',
      'https://T-instance123.propr.dev',
      'https://user:secret@t-instance123.propr.dev',
      'https://t-instance123.propr.dev:443',
      'https://t-instance123.propr.dev?query=secret',
      'https://t-instance123.propr.dev#fragment',
      'https://t-%69nstance123.propr.dev',
      'https://t-%zz.propr.dev',
      'https://x.t-instance123.propr.dev',
      'https://nested.t-instance123.propr.dev',
      'https://t-instance123.propr.dev.',
      'https://t-instance123.extra.propr.dev',
      'https://extra.t-instance123.propr.dev',
      'https://t-аbc.propr.dev',
      `https://t-instance123.propr.dev${' '.repeat(2049)}`,
    ]) {
      const invalidConnect = new DesktopAuthService({
        database,
        now: () => new Date(now),
        approvalBaseUrl: 'https://app.propr.dev',
        publicApiUrl,
      });

      await assert.rejects(
        startPairing(invalidConnect, 'Invalid Connect test'),
        (error: unknown) => error instanceof DesktopAuthError
          && error.code === 'PAIRING_CONFIGURATION_INVALID'
          && error.status === 503
          && error.message === 'Desktop pairing is unavailable because the public API URL is invalid',
      );
    }

    assert.equal(await database('desktop_pairing_requests').count<{ count: number }>('* as count').first()
      .then(result => Number(result?.count)), 0);
  });

  test('pairing rejects mixed-case managed tunnel DNS before URL normalization', () => {
    const pairingId = 'dpr_' + 'A'.repeat(22);
    const hosted = new DesktopAuthService({
      database,
      approvalBaseUrl: 'https://app.propr.dev',
      publicApiUrl: 'https://T-Instance123.ProPR.dev',
    });
    assert.throws(() => hosted.getFrontendApprovalUrl(pairingId), (error: unknown) =>
      error instanceof DesktopAuthError
      && error.code === 'PAIRING_CONFIGURATION_INVALID'
      && !error.message.includes('T-Instance123'));
  });

  test('matches the shared canonical origin parity table for the public REST and Socket origin', async () => {
    let index = 0;
    for (const [name, input, expected] of PROPR_API_ORIGIN_PARITY_CASES) {
      const candidate = new DesktopAuthService({
        database,
        approvalBaseUrl: 'https://app.example.test',
        publicApiUrl: input,
      });
      const start = startPairing(candidate, `Parity ${index++}`, expected ?? 'https://invalid.example.test');
      if (expected === null) await assert.rejects(start, undefined, name);
      else assert.equal(new URL((await start).approvalUrl).origin, expected, name);
    }
  });
});
