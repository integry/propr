/**
 * Bundled Agent Tank readiness reporting.
 *
 * A bundled run can succeed while describing no usable usage: with only
 * OpenCode/Vibe enabled - or no enabled agent at all - the runner starts no
 * container and returns an empty map, and a provider Agent Tank failed to read
 * comes back as a status object carrying its error and empty usage. The Settings
 * radio group turns "available" into a green "Bundled Agent Tank ready", so
 * neither snapshot may be reported as available, and neither may be reported as
 * a successful forced refresh.
 *
 * The transport is mocked because the assertion is about how the route reads the
 * snapshot, not about Docker; the readiness predicate itself is the real one.
 */

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { hasAgentTankStatuses, hasUsableAgentTankStatuses } = await import('../../core/src/services/agentTankTypes.js');

let snapshot: Record<string, unknown> | undefined;
const refreshCalls: Array<{ force?: boolean }> = [];

await mock.module('@propr/core', {
  namedExports: {
    loadAgentTankSettings: async () => ({ mode: 'bundled', enabled: true, url: 'http://0.0.0.0:3456' }),
    refreshBundledStatuses: async (options: { force?: boolean } = {}) => {
      refreshCalls.push(options);
      return snapshot;
    },
    getAgentTankStatuses: async () => snapshot,
    canRunBundledAgentTank: async () => false,
    hasAgentTankStatuses,
    hasUsableAgentTankStatuses,
  },
});

const { createAgentTankRoutes } = await import('../routes/configRoutesAgentTank.js');

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

test('a bundled snapshot with no provider is not reported as ready', async () => {
  const routes = createAgentTankRoutes();
  snapshot = {};

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: false, mode: 'bundled', reason: 'no_supported_agents' });

  // Same evidence rule for the explicit operator refresh: nothing was refreshed.
  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: false, error: 'no_supported_agents' });
});

test('a bundled run that failed outright keeps its own reason', async () => {
  const routes = createAgentTankRoutes();
  snapshot = undefined;

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: false, mode: 'bundled', reason: 'bundled_run_failed' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: false, error: 'bundled_run_failed' });
});

test('a bundled snapshot describing a provider stays available', async () => {
  const routes = createAgentTankRoutes();
  snapshot = { claude: { name: 'claude', usage: { session: { percent: 12 } } } };
  refreshCalls.length = 0;

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: true, mode: 'bundled' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: true });
  // The status probe reuses the cache; only the operator's refresh forces a run.
  assert.deepEqual(refreshCalls, [{}, { force: true }]);
});

test('a bundled snapshot whose every provider failed is not reported as ready', async () => {
  const routes = createAgentTankRoutes();
  // The upstream representation of a provider that could not be read: still a
  // status object, still keyed by the provider, but carrying no usage at all.
  snapshot = {
    claude: { name: 'claude', usage: {}, error: 'Timeout waiting for usage data' },
    codex: { name: 'codex', usage: {}, error: 'Not authenticated' },
  };

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: false, mode: 'bundled', reason: 'no_usage_data' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: false, error: 'no_usage_data' });
});

test('a bundled snapshot with one working provider stays available despite another failing', async () => {
  const routes = createAgentTankRoutes();
  snapshot = {
    claude: { name: 'claude', usage: { session: { percent: 12 } }, error: null },
    codex: { name: 'codex', usage: {}, error: 'Timeout waiting for usage data' },
  };

  const status = responseSpy();
  await routes.getAgentTankStatus({} as never, status as never);
  assert.deepEqual(status.body, { available: true, mode: 'bundled' });

  const refresh = responseSpy();
  await routes.postAgentTankRefresh({} as never, refresh as never);
  assert.deepEqual(refresh.body, { success: true });
});

test('a provider status with no usage fields is not usable evidence', () => {
  // A key in the map only proves a provider was configured; readiness needs a
  // number that actually came back.
  assert.equal(hasAgentTankStatuses({ claude: { name: 'claude', usage: {} } }), true);
  assert.equal(hasUsableAgentTankStatuses({ claude: { name: 'claude', usage: {} } }), false);
  assert.equal(
    hasUsableAgentTankStatuses({ claude: { name: 'claude', usage: { session: { percent: 0 } } } }),
    true
  );
});
