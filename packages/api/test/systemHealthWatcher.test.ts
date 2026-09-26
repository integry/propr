import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { SystemHealthWatcher } from '../services/systemHealthWatcher.js';

after(async () => closeConnection());

const HEALTHY = {
  api: 'healthy',
  redis: 'connected',
  daemon: 'running',
  worker: 'running',
  workerCount: 2,
  githubAuth: 'connected',
  githubAuthMode: 'app',
  githubEventIntake: 'routing_websocket',
  githubEventIntakeStatus: 'connected',
  claudeAuth: 'connected',
  indexing: 'idle',
  agents: [{ id: 'a1', type: 'claude', alias: 'default', status: 'connected' }],
  warnings: [] as Array<{ type: string; message: string }>,
  timestamp: '2026-09-26T00:00:00.000Z',
};

interface WatcherHarness {
  watcher: SystemHealthWatcher;
  published: number;
  setSnapshot(snapshot: Record<string, unknown>): void;
  failNextRead(): void;
  setListeners(listening: boolean): void;
}

function createWatcher(): WatcherHarness {
  let snapshot: Record<string, unknown> = { ...HEALTHY };
  let listening = true;
  let failRead = false;
  const harness = {
    published: 0,
    setSnapshot(next: Record<string, unknown>) { snapshot = next; },
    failNextRead() { failRead = true; },
    setListeners(next: boolean) { listening = next; },
  } as WatcherHarness;
  harness.watcher = new SystemHealthWatcher({
    readSnapshot: async () => {
      if (failRead) {
        failRead = false;
        throw new Error('status unavailable');
      }
      // A real snapshot is freshly stamped on every read.
      return { ...snapshot, timestamp: new Date().toISOString() };
    },
    publish: () => { harness.published += 1; },
    hasListeners: () => listening,
  });
  return harness;
}

describe('system health watcher', { concurrency: false }, () => {
  test('announces the first health state it observes with listeners', async () => {
    const harness = createWatcher();

    // A client that read health before this probe may already be behind, and
    // no later probe would correct it: every one of them sees this same state.
    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 1);
  });

  test('says nothing while the health it already published holds', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 1, 'only the baseline was announced');
  });

  test('publishes when a worker stops while the client socket stays connected', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    // No task transition, no indexing activity, nothing else moves: the
    // workers simply went away.
    harness.setSnapshot({ ...HEALTHY, worker: 'stopped', workerCount: 0 });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 2);
    assert.equal(await harness.watcher.probeOnce(), false, 'the outage is now the baseline');
    assert.equal(harness.published, 2);
  });

  test('publishes when the daemon stops', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    harness.setSnapshot({ ...HEALTHY, daemon: 'stopped', githubEventIntakeStatus: 'disconnected' });

    assert.equal(await harness.watcher.probeOnce(), true);
    assert.equal(harness.published, 2);
  });

  test('publishes when Redis, authentication or an agent goes away', async () => {
    for (const change of [
      { redis: 'disconnected' },
      { githubAuth: 'disconnected', githubAuthMode: 'none' },
      { claudeAuth: 'disconnected' },
      { agents: [{ id: 'a1', type: 'claude', alias: 'default', status: 'disconnected' }] },
      { warnings: [{ type: 'agent_runtime_unified_image_unavailable', message: 'boom' }] },
    ]) {
      const harness = createWatcher();
      await harness.watcher.probeOnce();

      harness.setSnapshot({ ...HEALTHY, ...change });

      assert.equal(
        await harness.watcher.probeOnce(),
        true,
        `expected ${JSON.stringify(change)} to be announced`,
      );
    }
  });

  test('ignores the parts of the snapshot the health surfaces do not show', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();

    // A fresh timestamp and moving routing diagnostics are not health, and
    // asking every connected client to re-read for them would put back the
    // polling this replaced.
    harness.setSnapshot({ ...HEALTHY, routing: { connected: true, lastSeenAt: 'later' } });

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 1);
  });

  test('does not probe when nobody is connected to be told', async () => {
    const harness = createWatcher();
    harness.setListeners(false);

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });

  test('keeps its baseline when the snapshot cannot be read', async () => {
    const harness = createWatcher();
    await harness.watcher.probeOnce();
    harness.failNextRead();

    assert.equal(await harness.watcher.probeOnce(), false, 'a failed read is not a change');
    assert.equal(harness.published, 1);

    // The health that was there all along is still not news.
    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 1);
  });

  test('stops probing once closed', async () => {
    const harness = createWatcher();
    await harness.watcher.close();

    assert.equal(await harness.watcher.probeOnce(), false);
    assert.equal(harness.published, 0);
  });
});
