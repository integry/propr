/**
 * The aggregate usage read is what supplies a client's usage snapshot, so it has
 * to announce the changes it observes: a percentage that moves between two of
 * these reads is otherwise never pushed to the other connected clients.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AgentStatusResponse } from '@propr/core';

// Imported after NODE_ENV, so core's GitHub auth module does not decide this
// process is a misconfigured server and exit.
process.env.NODE_ENV ??= 'test';
let bundledSnapshot: Record<string, AgentStatusResponse> | undefined;
let bundledReads = 0;
let bundledGate: Promise<void> | undefined;
const runnerMock = await mock.module('../../core/src/services/agentTankBundledRunner.js', {
  namedExports: {
    buildBundledAgentTankConfig: () => '',
    canRunBundledAgentTank: async () => true,
    parseBundledAgentTankOutput: () => ({}),
    getCachedBundledStatuses: () => bundledSnapshot,
    getBundledStatusesForDelta: () => bundledSnapshot,
    getBundledStatusForAlias: () => undefined,
    clearBundledAgentTankCache: () => {},
    scheduleBundledRefresh: () => {},
    refreshBundledStatuses: async () => {
      bundledReads += 1;
      await bundledGate;
      return bundledSnapshot;
    },
  },
});
const core = await import('@propr/core');

type AgentMap = Record<string, AgentStatusResponse>;

const settings = { mode: 'external' as const, url: 'http://agent-tank.test' };
const observed: AgentMap[] = [];
let published = 0;
const originalFetch = globalThis.fetch;

const coreMock = await mock.module('@propr/core', {
  namedExports: {
    ...core,
    // Real change detection, test publisher: what matters here is that the route
    // feeds its snapshot through the shared observer at all.
    observeAgentTankUsageSnapshot: async (agents: AgentMap) => {
      observed.push(agents);
      await core.observeAgentTankUsageSnapshot(agents, async () => { published += 1; });
    },
  },
});

const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');
const { ShellActivityBroadcaster } = await import('../services/shellActivityBroadcaster.js');
const { AgentTankUsageWatcher } = await import('../services/agentTankUsageWatcher.js');
const { ACTIVITY_ROOM } = await import('../services/activitySocketRooms.js');
const { USAGE_UPDATE } = await import('@propr/shared');

// The route and the shared status service must read the same persisted mode.
// Mocking the barrel's settings export does not replace the service's internal
// config import, which would otherwise see the default disabled mode.
before(async () => { await core.runMigrations(); });

after(async () => {
  coreMock.restore();
  runnerMock.restore();
  globalThis.fetch = originalFetch;
  await core.db('system_configs').where('key', 'agent_tank').delete();
  await core.closeConnection();
});

function responseRecorder() {
  const record: { status: number; body?: unknown } = { status: 200 };
  const response = {
    status(code: number) { record.status = code; return response; },
    json(body: unknown) { record.body = body; return response; },
  } as unknown as ExpressResponse;
  return { response, record };
}

/** Answer the aggregate `GET /status` with the given usage percentages. */
function tankReports(percentages: Record<string, number>): void {
  const body = Object.fromEntries(Object.entries(percentages).map(([agent, percent]) => [
    agent,
    { name: agent, usage: { session: { percent, resetsInSeconds: percent * 10 } } },
  ]));
  globalThis.fetch = (async () => new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof globalThis.fetch;
}

async function readUsage(): Promise<unknown> {
  const { getAgentTankUsage } = createAgentTankRoutes();
  const { response, record } = responseRecorder();
  await getAgentTankUsage({} as ExpressRequest, response);
  assert.equal(record.status, 200);
  return record.body;
}

beforeEach(async () => {
  bundledSnapshot = undefined;
  bundledReads = 0;
  bundledGate = undefined;
  observed.length = 0;
  published = 0;
  core.resetAgentTankUsageTracking();
  await core.saveAgentTankSettings(settings);
});

test('a changed aggregate usage read publishes a trigger', async () => {
  tankReports({ claude: 42, agy: 31 });
  await readUsage();
  assert.equal(published, 0, 'the first read is the baseline, not a change');

  tankReports({ claude: 58, agy: 31 });
  const body = await readUsage();

  assert.equal(published, 1);
  assert.deepEqual(Object.keys(observed[1]).sort(), ['antigravity', 'claude']);
  assert.deepEqual(
    (body as { agents: AgentMap }).agents,
    observed[1],
    'the observer sees exactly the snapshot the client is given',
  );
});

test('an unchanged aggregate usage read publishes nothing', async () => {
  tankReports({ claude: 42 });
  await readUsage();
  // Only the countdown moved, which every read moves.
  tankReports({ claude: 42 });
  await readUsage();

  assert.equal(observed.length, 2, 'both reads reached the observer');
  assert.equal(published, 0);
});

test('a usage read that Agent Tank refuses observes nothing', async () => {
  globalThis.fetch = (async () => new globalThis.Response('nope', { status: 503 })) as typeof globalThis.fetch;

  assert.deepEqual(await readUsage(), { enabled: true, mode: 'external', error: 'unreachable' });
  assert.equal(observed.length, 0);
});


function shellSampler() {
  const events: string[] = [];
  const socket = {
    rooms: new Set([ACTIVITY_ROOM]),
    data: { principal: { authorization: { source: 'local', permissions: ['instance.manage_agents'] } } },
    emit() {},
  };
  const io = {
    sockets: { adapter: { rooms: new Map([[ACTIVITY_ROOM, new Set(['connected-client'])]]) },
      sockets: new Map([['connected-client', socket]]) },
    to: () => ({ emit: (event: string) => events.push(event) }),
  };
  return { sampler: new ShellActivityBroadcaster(io as never), events };
}

test('shell sampling ignores countdowns and ordering but detects quota, membership and enabled changes', async () => {
  const { sampler, events } = shellSampler();
  const report = (body: unknown) => {
    globalThis.fetch = async () => new Response(JSON.stringify(body));
  };
  try {
    report({ claude: { name: 'claude', usage: { session: { percent: 42, resetsInSeconds: 120 } } } });
    await sampler.sample();
    report({ claude: { usage: { session: { resetsInSeconds: 90, percent: 42 } }, name: 'claude' } });
    await sampler.sample();
    assert.deepEqual(events, [USAGE_UPDATE], 'countdown-only samples must not wake connected consumers');
    tankReports({ claude: 43 }); await sampler.sample();
    tankReports({ claude: 43, agy: 0 }); await sampler.sample();
    tankReports({ agy: 0, claude: 43 }); await sampler.sample();
    assert.equal(events.length, 3, 'agent ordering is not a change');
    tankReports({ claude: 43 }); await sampler.sample();
    await core.saveAgentTankSettings({ ...settings, mode: 'disabled' });
    await sampler.sample(); await sampler.sample();
    await core.saveAgentTankSettings(settings); await sampler.sample();
    assert.equal(events.length, 6, 'quota, additions, removals and enable transitions each invalidate');
  } finally { sampler.close(); }
});

test('shell sampling announces unavailable and recovery outcomes once each', async () => {
  const { sampler, events } = shellSampler();
  try {
    tankReports({ claude: 42 }); await sampler.sample();
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await sampler.sample(); await sampler.sample();
    assert.equal(events.length, 2);
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    await sampler.sample(); await sampler.sample();
    assert.equal(events.length, 2, 'HTTP and network failures share the router’s unavailable outcome');
    globalThis.fetch = async () => new Response('invalid JSON');
    await sampler.sample();
    assert.equal(events.length, 2, 'body failures have the same unreachable outcome as the endpoint');
    tankReports({ claude: 42 }); await sampler.sample(); await sampler.sample();
    assert.equal(events.length, 3, 'recovery invalidates even when the quota did not change');
  } finally { sampler.close(); }
});

test('closing during an awaited usage body prevents a late invalidation', async () => {
  const { sampler, events } = shellSampler();
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async () => ({ ok: true, json: () => {
    entered();
    return new Promise(resolve => { release = resolve; });
  } }) as Response;
  const pending = sampler.sample();
  await reading;
  sampler.close();
  release({ claude: { name: 'claude', usage: { percent: 42 } } });
  await pending;
  assert.deepEqual(events, []);
});

for (const kind of ['shell', 'watcher'] as const) {
  function observer() {
    if (kind === 'shell') {
      const { sampler, events } = shellSampler();
      return { sample: () => sampler.sample(), close: () => sampler.close(), events };
    }
    const events: string[] = [];
    const watcher = new AgentTankUsageWatcher({
      hasListeners: () => true,
      publish: () => { events.push(USAGE_UPDATE); },
    });
    return { sample: () => watcher.probeOnce(), close: () => watcher.close(), events };
  }

  test(`${kind} observes bundled quota changes without contacting the saved external URL`, async () => {
    await core.saveAgentTankSettings({ mode: 'bundled', url: settings.url });
    let httpReads = 0;
    globalThis.fetch = async () => { httpReads += 1; throw new Error('No external daemon'); };
    const sampler = observer();
    const report = (percent: number, countdown: number) => {
      bundledSnapshot = { claude: { name: 'claude', usage: { session: { percent, resetsInSeconds: countdown } } } };
    };
    try {
      report(42, 120);
      await sampler.sample();
      report(42, 90);
      await sampler.sample();
      assert.deepEqual(sampler.events, [USAGE_UPDATE]);
      report(49, 60);
      await sampler.sample();
      await sampler.sample();
      assert.equal(sampler.events.length, 2, 'changed bundled usage wakes the sidebar exactly once');
      bundledSnapshot = undefined;
      await sampler.sample(); await sampler.sample();
      assert.equal(sampler.events.length, 3, 'unavailable data is observed once');
      report(49, 30);
      await sampler.sample();
      assert.equal(sampler.events.length, 4, 'recovery is observable');
      await core.saveAgentTankSettings({ mode: 'disabled' });
      const reads = bundledReads;
      await sampler.sample(); await sampler.sample();
      assert.equal(sampler.events.length, 5);
      assert.equal(bundledReads, reads, 'disabled mode never invokes the runner');
      assert.equal(httpReads, 0, 'bundled and disabled sampling never use HTTP');
    } finally { await sampler.close(); }
  });

  test(`${kind} suppresses overlapping bundled probes and publication after close`, { timeout: 5000 }, async () => {
    await core.saveAgentTankSettings({ mode: 'bundled' });
    let release!: () => void;
    bundledGate = new Promise<void>(resolve => { release = resolve; });
    const sampler = observer();
    const pending = sampler.sample();
    // Wait for the persisted settings read to reach the held bundled refresh.
    while (!bundledReads) await new Promise(resolve => setImmediate(resolve));
    await sampler.sample();
    assert.equal(bundledReads, 1);
    await sampler.close();
    release();
    await pending;
    assert.deepEqual(sampler.events, []);
  });
}
