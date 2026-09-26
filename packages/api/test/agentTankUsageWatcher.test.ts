import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { AgentTankUsageWatcher } from '../services/agentTankUsageWatcher.js';

after(async () => closeConnection());

interface WatcherHarness {
  watcher: AgentTankUsageWatcher;
  published: number;
  setStatus(status: unknown): void;
  setSettings(settings: { enabled: boolean; url: string }): void;
  setListeners(listening: boolean): void;
}

function createWatcher(): WatcherHarness {
  let status: unknown = { claude: { used: 1 } };
  let settings = { enabled: true, url: 'http://agent-tank.test' };
  let listening = true;
  const harness = {
    published: 0,
    setStatus(next: unknown) { status = next; },
    setSettings(next: { enabled: boolean; url: string }) { settings = next; },
    setListeners(next: boolean) { listening = next; },
  } as WatcherHarness;
  harness.watcher = new AgentTankUsageWatcher({
    loadSettings: async () => settings,
    probe: async () => status,
    publish: () => { harness.published += 1; },
    hasListeners: () => listening,
  });
  return harness;
}

describe('agent tank usage watcher', { concurrency: false }, () => {
  test('says nothing while the numbers it already published hold', async () => {
    const harness = createWatcher();

    assert.equal(await harness.watcher.probeOnce(), false, 'the first probe only seeds');
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });

  test('publishes when a provider quota moves', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    harness.setStatus({ claude: { used: 2 } });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 1);
    assert.equal(await harness.watcher.probeOnce(), false, 'the new value is now the baseline');
    assert.equal(harness.published, 1);
  });

  test('publishes when the integration is enabled or disabled behind the sidebar', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    harness.setSettings({ enabled: false, url: 'http://agent-tank.test' });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 1);
  });

  test('does not probe when nobody is connected to be told', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();
    harness.setListeners(false);
    harness.setStatus({ claude: { used: 3 } });

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });

  test('stops probing once closed', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();
    harness.setStatus({ claude: { used: 4 } });
    await harness.watcher.close();

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });
});
