/**
 * The aggregate usage read is what supplies a client's usage snapshot, so it has
 * to announce the changes it observes: a percentage that moves between two of
 * these reads is otherwise never pushed to the other connected clients.
 */

import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { AgentStatusResponse } from '@propr/core';

// Imported after NODE_ENV, so core's GitHub auth module does not decide this
// process is a misconfigured server and exit.
process.env.NODE_ENV ??= 'test';
const core = await import('@propr/core');

type AgentMap = Record<string, AgentStatusResponse>;

const settings = { enabled: true, url: 'http://agent-tank.test' };
const observed: AgentMap[] = [];
let published = 0;
const originalFetch = globalThis.fetch;

const coreMock = await mock.module('@propr/core', {
  namedExports: {
    ...core,
    loadAgentTankSettings: async () => settings,
    // Real change detection, test publisher: what matters here is that the route
    // feeds its snapshot through the shared observer at all.
    observeAgentTankUsageSnapshot: async (agents: AgentMap) => {
      observed.push(agents);
      await core.observeAgentTankUsageSnapshot(agents, async () => { published += 1; });
    },
  },
});

const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');

after(async () => {
  coreMock.restore();
  globalThis.fetch = originalFetch;
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

beforeEach(() => {
  observed.length = 0;
  published = 0;
  core.resetAgentTankUsageTracking();
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

  assert.deepEqual(await readUsage(), { enabled: true, error: 'HTTP 503' });
  assert.equal(observed.length, 0);
});
