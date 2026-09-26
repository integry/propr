import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeDesktopPairingApprovalUrl } from '@propr/shared';

const pairingId = 'dpr_ABCDEFGHIJKLMNOPQRSTUV';
const apiBaseUrl = 'https://t-instance123.propr.dev';

describe('ProPR Connect desktop pairing approval URLs', () => {
  it('accepts the API-returned hosted approval and exact tunnel browser fallback', () => {
    assert.equal(normalizeDesktopPairingApprovalUrl({
      apiBaseUrl,
      pairingId,
      approvalUrl: `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.propr.dev`,
    }), `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.propr.dev`);

    assert.equal(normalizeDesktopPairingApprovalUrl({
      apiBaseUrl,
      pairingId,
      approvalUrl: `${apiBaseUrl}/api/desktop/pairings/${pairingId}/browser`,
    }), `${apiBaseUrl}/api/desktop/pairings/${pairingId}/browser`);
  });

  it('rejects synthesized, cross-origin, private, and secret-bearing approval URLs', () => {
    for (const approvalUrl of [
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}`,
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-other.propr.dev`,
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.propr.dev&token=secret`,
      `https://app.propr.dev/desktop/pairing?pairing_id=dpr_1234567890123456789012&tunnel=t-instance123.propr.dev`,
      `https://evil.example/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.propr.dev`,
      `${apiBaseUrl}/api/desktop/pairings/${pairingId}/approval`,
      `${apiBaseUrl}/api/desktop/pairings/${pairingId}/browser?device_secret=secret`,
      `https://user:secret@t-instance123.propr.dev/api/desktop/pairings/${pairingId}/browser`,
      `https://t-%69nstance123.propr.dev/api/desktop/pairings/${pairingId}/browser`,
      `https://t-instance123.propr.dev:443/api/desktop/pairings/${pairingId}/browser`,
    ]) {
      assert.equal(normalizeDesktopPairingApprovalUrl({ apiBaseUrl, pairingId, approvalUrl }), null, approvalUrl);
    }
  });

  it('matches the hosted UI raw query contract for approval parameters', () => {
    for (const approvalUrl of [
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t%2Dinstance123.propr.dev`,
      `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&%74unnel=t-instance123.propr.dev`,
      `https://app.propr.dev/desktop/pairing?pairing%5Fid=${pairingId}&tunnel=t-instance123.propr.dev`,
      `https://app.propr.dev/desktop/pairing?pairing_id=dpr%5FABCDEFGHIJKLMNOPQRSTUV&tunnel=t-instance123.propr.dev`,
    ]) {
      assert.equal(normalizeDesktopPairingApprovalUrl({ apiBaseUrl, pairingId, approvalUrl }), null, approvalUrl);
    }
  });

  it('requires a normalized, validated API origin', () => {
    const approvalUrl = `${apiBaseUrl}/api/desktop/pairings/${pairingId}/browser`;
    for (const untrustedBase of [
      `${apiBaseUrl}/`,
      'https://t-instance123.propr.dev:443',
      'https://t-%69nstance123.propr.dev',
      'http://remote.example.com',
    ]) {
      assert.equal(normalizeDesktopPairingApprovalUrl({
        apiBaseUrl: untrustedBase,
        pairingId,
        approvalUrl,
      }), null);
    }
  });

  it('does not grant the hosted approval contract to Connect lookalikes', () => {
    assert.equal(normalizeDesktopPairingApprovalUrl({
      apiBaseUrl: 'https://t-instance123.foo.propr.dev',
      pairingId,
      approvalUrl: `https://app.propr.dev/desktop/pairing?pairing_id=${pairingId}&tunnel=t-instance123.foo.propr.dev`,
    }), null);
  });

  it('rejects every noncanonical reserved-host base before generic HTTPS fallback', () => {
    for (const untrustedBase of [
      'https://t-instance123.propr.dev:443',
      'https://t-instance123.propr.dev:8443',
      'https://user:secret@t-instance123.propr.dev',
      'https://t-%69nstance123.propr.dev',
      'https://t-instance123.propr.dev.',
      'https://t-instance123.foo.propr.dev',
      'http://localhost.:4000',
      'http://api.dev.localhost.:4000',
    ]) {
      assert.equal(normalizeDesktopPairingApprovalUrl({
        apiBaseUrl: untrustedBase,
        pairingId,
        approvalUrl: `${untrustedBase}/api/desktop/pairings/${pairingId}/browser`,
      }), null, untrustedBase);
    }
  });

  it('preserves unrelated HTTPS remotes, outside lookalikes, and loopback HTTP', () => {
    for (const baseUrl of [
      'https://remote.example.com',
      'https://t-instance123.propr.dev.example.com',
      'http://127.0.0.1:4000',
      'http://localhost:4000',
      'http://api.dev.localhost:4000',
    ]) {
      const approvalUrl = `${baseUrl}/api/desktop/pairings/${pairingId}/browser`;
      assert.equal(normalizeDesktopPairingApprovalUrl({ apiBaseUrl: baseUrl, pairingId, approvalUrl }), approvalUrl);
    }
  });
});
