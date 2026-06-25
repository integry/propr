import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig, getTunnelStatus } from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

// Build a resolved config from an explicit env so tunnel fields are deterministic.
function cfgFor(env) {
  return resolveConfig(env, { manifestPath });
}

// Minimal stack status with an optional running tunnel sidecar, so getTunnelStatus
// never has to shell out to `docker ps` during the test.
function stackStatus({ tunnelRunning = false } = {}) {
  return {
    stack: 'propr',
    network: 'propr-net',
    running: false,
    services: [{ name: 'propr-tunnel', service: 'tunnel', exists: tunnelRunning, running: tunnelRunning, state: tunnelRunning ? 'running' : 'absent', status: '', ports: '' }],
  };
}

describe('getTunnelStatus', () => {
  test('a missing token reports configured=false (and enabled=false by default)', async () => {
    const t = await getTunnelStatus(cfgFor({}), stackStatus());
    assert.equal(t.configured, false);
    assert.equal(t.enabled, false);
    assert.equal(t.publicApiUrl, null);
    assert.equal(t.reachable, null);
  });

  test('a present token reports configured=true and enabled=true', async () => {
    const t = await getTunnelStatus(cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'tok' }), stackStatus());
    assert.equal(t.configured, true);
    assert.equal(t.enabled, true);
  });

  test('PROPR_UI_TUNNEL_ENABLED enables without a token (configured stays false)', async () => {
    const t = await getTunnelStatus(cfgFor({ PROPR_UI_TUNNEL_ENABLED: 'true' }), stackStatus());
    assert.equal(t.enabled, true);
    assert.equal(t.configured, false);
  });

  test('a stopped tunnel container reports running=false', async () => {
    const t = await getTunnelStatus(cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'tok' }), stackStatus({ tunnelRunning: false }));
    assert.equal(t.running, false);
  });

  test('a running tunnel container reports running=true', async () => {
    const t = await getTunnelStatus(cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'tok' }), stackStatus({ tunnelRunning: true }));
    assert.equal(t.running, true);
  });

  test('publicApiUrl is derived from the instance id', async () => {
    const t = await getTunnelStatus(cfgFor({ PROPR_INSTANCE_ID: 'abc123' }), stackStatus());
    assert.equal(t.publicApiUrl, 'https://abc123.proxy.propr.dev');
  });

  test('an unreachable public URL yields reachable=false, never throws', async () => {
    // Port 1 on loopback refuses immediately, so the best-effort probe resolves
    // false fast instead of waiting out the timeout.
    const t = await getTunnelStatus(cfgFor({ PROPR_UI_PUBLIC_API_URL: 'http://127.0.0.1:1' }), stackStatus());
    assert.equal(t.publicApiUrl, 'http://127.0.0.1:1');
    assert.equal(t.reachable, false);
  });
});
