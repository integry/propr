import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  copyApprovedDesktopPairingUrl,
  DesktopPairingBrowserOpenError,
  openApprovedDesktopPairingUrl,
  supportsAmbiguousPairingLaunchRecovery,
} from './pairing-browser';

const pairingId = `dpr_${'A'.repeat(22)}`;
const fallback = `https://api.example.test/api/desktop/pairings/${pairingId}/browser`;

describe('desktop pairing browser final sink', () => {
  it('limits ambiguous OS launch recovery to Linux', () => {
    assert.equal(supportsAmbiguousPairingLaunchRecovery('linux'), true);
    assert.equal(supportsAmbiguousPairingLaunchRecovery('darwin'), false);
    assert.equal(supportsAmbiguousPairingLaunchRecovery('win32'), false);
  });

  it('opens only the exact canonical API browser route', async () => {
    const opened: string[] = [];
    await openApprovedDesktopPairingUrl({
      apiBaseUrl: 'https://api.example.test',
      pairingId,
      approvalUrl: fallback,
    }, { openExternal: async url => { opened.push(url); } });

    assert.deepEqual(opened, [fallback]);
  });

  it('opens the exact hosted Connect approval bound to the verified tunnel', async () => {
    const approvalUrl = `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.propr.dev`;
    const opened: string[] = [];
    await openApprovedDesktopPairingUrl({
      apiBaseUrl: 'https://t-instance123.propr.dev',
      pairingId,
      approvalUrl,
    }, { openExternal: async url => { opened.push(url); } });

    assert.deepEqual(opened, [approvalUrl]);
  });

  it('copies only the exact normalized approval URL at the main-process sink', () => {
    const copied: string[] = [];
    copyApprovedDesktopPairingUrl({
      apiBaseUrl: 'https://api.example.test', pairingId, approvalUrl: fallback,
    }, { writeText: value => { copied.push(value); } });
    assert.deepEqual(copied, [fallback]);

    assert.throws(() => copyApprovedDesktopPairingUrl({
      apiBaseUrl: 'https://api.example.test', pairingId,
      approvalUrl: `${fallback}?device_secret=must-not-copy`,
    }, { writeText: value => { copied.push(value); } }), /request was rejected/);
    assert.deepEqual(copied, [fallback]);
  });

  it('rejects replacement, mutation, noncanonical, and reserved-host values without opening', async () => {
    const opened: string[] = [];
    for (const approvalUrl of [
      `https://api.example.test/api/desktop/pairings/dpr_${'B'.repeat(22)}/browser`,
      `${fallback}?next=https://attacker.example`,
      `https://api.example.test:443/api/desktop/pairings/${pairingId}/browser`,
      `https://x.t-instance123.propr.dev/api/desktop/pairings/${pairingId}/browser`,
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-replaced456.propr.dev`,
    ]) {
      await assert.rejects(
        openApprovedDesktopPairingUrl({
          apiBaseUrl: approvalUrl.includes('app.propr.dev')
            ? 'https://t-instance123.propr.dev'
            : 'https://api.example.test',
          pairingId,
          approvalUrl,
        }, { openExternal: async url => { opened.push(url); } }),
        (error: unknown) => (error as Error).message === 'Desktop pairing browser request was rejected',
      );
    }
    assert.deepEqual(opened, []);
  });

  it('classifies shell rejection without copying the approval URL into its message', async () => {
    await assert.rejects(
      openApprovedDesktopPairingUrl({
        apiBaseUrl: 'https://api.example.test', pairingId, approvalUrl: fallback,
      }, { openExternal: async () => { throw new Error(`xdg-open rejected ${fallback}`); } }, {
        ambiguousOsLaunchFailure: true,
      }),
      (error: unknown) => error instanceof DesktopPairingBrowserOpenError
        && error.message === 'Desktop pairing browser could not be opened'
        && !error.message.includes(pairingId),
    );
  });

  it('keeps non-system approval-host failures terminal', async () => {
    const navigationFailure = new Error('Packaged approval navigation failed');
    await assert.rejects(
      openApprovedDesktopPairingUrl({
        apiBaseUrl: 'https://api.example.test', pairingId, approvalUrl: fallback,
      }, { openExternal: async () => { throw navigationFailure; } }),
      error => error === navigationFailure,
    );
  });
});
