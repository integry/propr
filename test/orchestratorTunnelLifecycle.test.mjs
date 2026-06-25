import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveConfig,
  parseStackStatus,
  buildServiceSpec,
  CORE_SERVICES,
  TOGGLE_SERVICES,
  SERVICES,
} from '../docker/launcher/orchestrator.mjs';

// Integration coverage for the launcher's optional Cloudflare tunnel sidecar
// across its lifecycle (enumeration → launch spec → status parsing), driven
// entirely through the dependency-free pure functions. No real Docker daemon
// and no real Cloudflare connection are touched: parseStackStatus is fed
// synthetic `docker ps` output and buildServiceSpec is inspected directly.

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

function cfgFor(env = {}, overrides = {}) {
  return resolveConfig(env, { manifestPath, ...overrides });
}

// Reconstruct the tab-separated stdout that getStackStatus passes to
// parseStackStatus. Columns mirror STACK_STATUS_PS_ARGS:
// {{.Names}}\t{{.State}}\t{{.Status}}\t{{.Ports}}.
function psRow({ name, state, status, ports = '' }) {
  return [name, state, status, ports].join('\t');
}

function tunnelStateOf(cfg, stdout) {
  return parseStackStatus(cfg, stdout).services.find((s) => s.service === 'tunnel');
}

describe('tunnel service enumeration', () => {
  test('tunnel is an optional (toggle) service, not a core one', () => {
    assert.ok(TOGGLE_SERVICES.includes('tunnel'));
    assert.ok(!CORE_SERVICES.includes('tunnel'));
    assert.ok(SERVICES.includes('tunnel'));
  });

  test('tunnel is enumerated after every core service so it starts last', () => {
    // startStack composes [...CORE_SERVICES, ui, docs, tunnel]; SERVICES keeps the
    // same shape, so the tunnel index must follow all core service indices.
    const tunnelIndex = SERVICES.indexOf('tunnel');
    const lastCoreIndex = Math.max(...CORE_SERVICES.map((s) => SERVICES.indexOf(s)));
    assert.ok(tunnelIndex > lastCoreIndex);
  });
});

describe('tunnel sidecar launch spec (no Docker)', () => {
  test('uses the resolved cloudflared image and runs the token-authenticated tunnel', () => {
    const cfg = cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'secret-token' });
    const spec = buildServiceSpec(cfg, 'tunnel');

    assert.equal(spec.image, cfg.cloudflaredImage);
    assert.deepEqual(spec.command, ['tunnel', '--no-autoupdate', 'run', '--token', 'secret-token']);
  });

  test('honors an overridden cloudflared image for the sidecar', () => {
    const cfg = cfgFor({
      PROPR_UI_TUNNEL_TOKEN: 'secret-token',
      PROPR_CLOUDFLARED_IMAGE: 'cloudflare/cloudflared:2024.1.0',
    });
    const spec = buildServiceSpec(cfg, 'tunnel');

    assert.equal(spec.image, 'cloudflare/cloudflared:2024.1.0');
  });

  test('publishes no host ports (the sidecar dials out to Cloudflare)', () => {
    const cfg = cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'secret-token' });
    const spec = buildServiceSpec(cfg, 'tunnel');

    assert.ok(!spec.args.includes('-p'));
  });
});

describe('parseStackStatus recognizes propr-tunnel rows', () => {
  const cfg = cfgFor();

  test('an absent tunnel container is reported as not created', () => {
    // `docker ps -a` lists the running core services but no tunnel container,
    // which is the steady state when the tunnel is disabled.
    const stdout = [
      psRow({ name: 'propr-redis', state: 'running', status: 'Up 2 minutes', ports: '6379/tcp' }),
      psRow({ name: 'propr-api', state: 'running', status: 'Up 2 minutes', ports: '0.0.0.0:4000->4000/tcp' }),
    ].join('\n');

    const tunnel = tunnelStateOf(cfg, stdout);
    assert.equal(tunnel.name, 'propr-tunnel');
    assert.equal(tunnel.exists, false);
    assert.equal(tunnel.running, false);
    assert.equal(tunnel.state, 'absent');
    assert.equal(tunnel.status, 'not created');
    assert.equal(tunnel.ports, '');
  });

  test('a running tunnel container is recognized by its canonical name', () => {
    const stdout = [
      psRow({ name: 'propr-api', state: 'running', status: 'Up 5 minutes' }),
      psRow({ name: 'propr-tunnel', state: 'running', status: 'Up 1 minute' }),
    ].join('\n');

    const tunnel = tunnelStateOf(cfg, stdout);
    assert.equal(tunnel.exists, true);
    assert.equal(tunnel.running, true);
    assert.equal(tunnel.state, 'running');
    assert.equal(tunnel.status, 'Up 1 minute');
  });

  test('a stopped/exited tunnel container exists but is not running', () => {
    const stdout = psRow({
      name: 'propr-tunnel',
      state: 'exited',
      status: 'Exited (0) 3 seconds ago',
    });

    const tunnel = tunnelStateOf(cfg, stdout);
    assert.equal(tunnel.exists, true);
    assert.equal(tunnel.running, false);
    assert.equal(tunnel.state, 'exited');
    assert.equal(tunnel.status, 'Exited (0) 3 seconds ago');
  });

  test('the tunnel row is matched under a non-default stack prefix', () => {
    const customCfg = cfgFor({ PROPR_STACK: 'acme' });
    const stdout = psRow({ name: 'acme-tunnel', state: 'running', status: 'Up 10 seconds' });

    const status = parseStackStatus(customCfg, stdout);
    const tunnel = status.services.find((s) => s.service === 'tunnel');
    assert.equal(tunnel.name, 'acme-tunnel');
    assert.equal(tunnel.running, true);
    // A propr-prefixed row must NOT match the acme stack's tunnel.
    const mismatched = parseStackStatus(customCfg, psRow({ name: 'propr-tunnel', state: 'running', status: 'Up' }));
    assert.equal(mismatched.services.find((s) => s.service === 'tunnel').exists, false);
  });

  test('a running tunnel alone does NOT mark the whole stack as running', () => {
    // An orphaned tunnel sidecar (core services down) must not hide the
    // unusable state — `propr status` should still report the stack as down.
    const stdout = psRow({ name: 'propr-tunnel', state: 'running', status: 'Up 1 minute' });
    assert.equal(parseStackStatus(cfg, stdout).running, false);
  });

  test('a running core service marks the whole stack as running', () => {
    const stdout = psRow({ name: 'propr-api', state: 'running', status: 'Up 1 minute' });
    assert.equal(parseStackStatus(cfg, stdout).running, true);
  });
});

describe('tunnel status parsing across a start/stop lifecycle', () => {
  const cfg = cfgFor({ PROPR_UI_TUNNEL_TOKEN: 'secret-token', PROPR_INSTANCE_ID: 'abc123' });

  test('absent → running → exited is reflected purely from docker ps output', () => {
    const absent = tunnelStateOf(cfg, psRow({ name: 'propr-api', state: 'running', status: 'Up' }));
    assert.equal(absent.running, false);
    assert.equal(absent.state, 'absent');

    const running = tunnelStateOf(cfg, psRow({ name: 'propr-tunnel', state: 'running', status: 'Up 30 seconds' }));
    assert.equal(running.running, true);

    const exited = tunnelStateOf(cfg, psRow({ name: 'propr-tunnel', state: 'exited', status: 'Exited (1) just now' }));
    assert.equal(exited.exists, true);
    assert.equal(exited.running, false);
  });
});
