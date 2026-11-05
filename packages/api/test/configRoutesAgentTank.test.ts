/**
 * Agent Tank config routes.
 *
 * These cover the two ways the mode can arrive at the backend: the current
 * `{ mode }` body the UI/CLI/MCP send, and the legacy `{ enabled }` body an
 * older client may still send during a rolling upgrade.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

// One shared connection for the file: closing it per test would leave the next
// test unable to reacquire one.
const configManager = await import('@propr/core');
const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');

after(async () => {
  await configManager.db('system_configs').whereIn('key', ['agent_tank']).delete();
  await configManager.closeConnection();
});

function responseSpy() {
  return {
    statusCode: 200,
    body: undefined as Record<string, unknown> | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      this.body = payload;
      return this;
    },
  };
}

test('agent tank settings routes persist the mode and reject an unknown one', async () => {
  await configManager.runMigrations();
  await configManager.db('system_configs').whereIn('key', ['agent_tank']).delete();

  const routes = createAgentTankRoutes();

  // Bundled mode carries no URL; the previously saved one must survive.
  await configManager.saveAgentTankSettings({ mode: 'external', url: 'http://saved:3456' });
  let res = responseSpy();
  await routes.postAgentTankSettings({ body: { mode: 'bundled' } } as never, res as never);
  assert.equal(res.statusCode, 200);
  let saved = await configManager.loadAgentTankSettings();
  assert.equal(saved.mode, 'bundled');
  assert.equal(saved.url, 'http://saved:3456');
  assert.equal(saved.enabled, true);

  // A legacy `{ enabled: true }` body means "my host install", i.e. external.
  res = responseSpy();
  await routes.postAgentTankSettings({ body: { enabled: true, url: 'http://legacy:3456' } } as never, res as never);
  saved = await configManager.loadAgentTankSettings();
  assert.equal(saved.mode, 'external');
  assert.equal(saved.url, 'http://legacy:3456');

  res = responseSpy();
  await routes.postAgentTankSettings({ body: { enabled: false } } as never, res as never);
  assert.equal((await configManager.loadAgentTankSettings()).mode, 'disabled');

  res = responseSpy();
  await routes.postAgentTankSettings({ body: { mode: 'sideways' } } as never, res as never);
  assert.equal(res.statusCode, 400);
  // A rejected write must not change the stored mode.
  assert.equal((await configManager.loadAgentTankSettings()).mode, 'disabled');

  // GET returns the mode alongside the derived boolean older clients read.
  res = responseSpy();
  await routes.getAgentTankSettings({} as never, res as never);
  assert.equal(res.body?.mode, 'disabled');
  assert.equal(res.body?.enabled, false);
});

test('disabled mode short-circuits status, usage and refresh without any transport', async () => {
  await configManager.runMigrations();
  await configManager.saveAgentTankSettings({ mode: 'disabled', url: 'http://0.0.0.0:3456' });

  const routes = createAgentTankRoutes();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; return new Response('{}'); }) as typeof fetch;

  try {
    const status = responseSpy();
    await routes.getAgentTankStatus({} as never, status as never);
    assert.deepEqual(status.body, { available: false, reason: 'disabled' });

    const usage = responseSpy();
    await routes.getAgentTankUsage({} as never, usage as never);
    assert.deepEqual(usage.body, { enabled: false });

    const refresh = responseSpy();
    await routes.postAgentTankRefresh({} as never, refresh as never);
    assert.equal(refresh.body?.success, false);

    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
