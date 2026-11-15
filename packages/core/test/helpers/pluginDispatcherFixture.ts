import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { pluginHandlerFixture, EVENTS_FIXTURE_ID as ID } from './pluginHandlerFixture.js';
import { PluginDispatcher } from '../../src/plugins/pluginDispatcher.js';
import { listPluginActivity } from '../../src/plugins/pluginDeliveries.js';
import { appendRepositoryEvent } from '../../src/services/repositoryEventJournal.js';

/**
 * The `fixture-events` plugin installed through the real plugin store, limited
 * to two repositories, with a dispatcher factory on a test clock. Import it
 * after mocking `eventPublisher.js` (no Redis in tests).
 */
type Seen = { id: string; seq: number; repository: string; attempt: number }[];
export const ALLOWED = 'owner/allowed';
export const SECOND = 'owner/second';

export async function setup(t: TestContext) {
  const f = await pluginHandlerFixture(t, { pluginId: ID, repositories: [ALLOWED, SECOND] });
  const clock = { now: 1_700_000_000_000 };
  const notices: unknown[] = [];
  const dispatcher = (extra: Partial<ConstructorParameters<typeof PluginDispatcher>[0]> = {}) => new PluginDispatcher({
    ...f.options, now: () => clock.now, timeoutMs: 200, pauseAfterFailures: 100, notify: async notice => { notices.push(notice); }, ...extra,
  });
  const append = async (repository: string, domain: 'pull_request' | 'task', type: string, entityId: number | string, payload: Record<string, unknown> = {}, occurredAt?: string) => {
    const result = await appendRepositoryEvent(f.database, {
      repository, domain, type, entityId, ...(domain === 'pull_request' ? { prNumber: Number(entityId) } : {}), payload, ...(occurredAt ? { occurredAt } : {}),
    }, { publish: false });
    assert.equal(result.status, 'appended');
    return (result as { seq: number }).seq;
  };
  const state = async <T>(key: string) => {
    const row = await f.database('plugin_state').where({ plugin_id: ID, state_key: key }).first() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  };
  const setState = (key: string, value: unknown) => f.database('plugin_state').insert({ plugin_id: ID, state_key: key, value: JSON.stringify(value), bytes: 8, updated_at: 0 }).onConflict(['plugin_id', 'state_key']).merge();
  const seen = async () => (await state<Seen>('seen')) ?? [];
  const deliveries = async () => (await listPluginActivity(f.database, ID)).deliveries;
  return { f, clock, notices, dispatcher, append, seen, setState, deliveries };
}

/** Passes until one makes no attempt. */
export async function drain(dispatcher: InstanceType<typeof PluginDispatcher>) {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const { attempts } = await dispatcher.pass();
    if (!attempts) return total;
    total += attempts;
  }
  throw new Error('the dispatcher did not settle');
}

/** Waits until the predicate holds (a background pass reached a state). */
export async function until(predicate: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
