import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { appendRepositoryEvent, closeConnection, pruneRepositoryEvents } from '@propr/core';
import {
  activeRepositoryEventWaiterCount,
  listRepositoryEventsAfterCursor,
  waitForRepositoryEvents,
} from '../services/repositoryEventWait.js';

/** The `task` domain reads, waits and expires through the same journal read path as every other domain. */
const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const repository = 'acme/app';
let db: Knex;

after(closeConnection);
beforeEach(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
  await db.migrate.latest({ directory: migrations });
});
afterEach(async () => {
  await db.destroy();
  assert.equal(activeRepositoryEventWaiterCount(), 0);
});

const DAY_MS = 24 * 60 * 60 * 1000;
async function appendTask(type: string, payload: Record<string, unknown> = {}, occurredAt?: string): Promise<void> {
  const result = await appendRepositoryEvent(db, {
    repository, domain: 'task', type, entityId: 'issue-42', issueNumber: 42,
    payload: { taskId: 'issue-42', kind: 'implementation', ...payload }, dedupeKey: `task:issue-42:${type}`, occurredAt,
  }, { publish: false });
  assert.equal(result.status, 'appended');
}
const list = (options: Partial<Parameters<typeof listRepositoryEventsAfterCursor>[0]> = {}) =>
  listRepositoryEventsAfterCursor({ db, repository, ...options });

test('task events are listed, filtered by domain and type, and waited on', async () => {
  const start = (await list()).cursor;
  await appendRepositoryEvent(db, { repository, domain: 'pull_request', type: 'opened', entityId: 7, prNumber: 7 }, { publish: false });
  await appendTask('queued');
  await appendTask('started');
  await appendTask('failed', { status: 'failed', failureCategory: 'git_operation' });

  const page = await list({ afterCursor: start, domains: ['task'] });
  assert.deepEqual(page.events.map(event => [event.domain, event.type, event.entityId, event.issueNumber]), [
    ['task', 'queued', 'issue-42', 42], ['task', 'started', 'issue-42', 42], ['task', 'failed', 'issue-42', 42],
  ]);
  assert.equal(page.events[2].payload.failureCategory, 'git_operation');
  assert.deepEqual((await list({ afterCursor: start, types: ['failed'] })).events.map(event => event.type), ['failed']);

  const waited = await waitForRepositoryEvents({
    db, repository, ownerId: '1', afterCursor: start, domains: ['task'], types: ['started'], timeoutSeconds: 1, pollIntervalMs: 60_000,
  });
  assert.equal(waited.outcome, 'events');
  assert.deepEqual(waited.events.map(event => event.type), ['started']);
});

test('retention prunes task events by age like any other event', async () => {
  await appendTask('queued', {}, new Date(Date.now() - 40 * DAY_MS).toISOString());
  await appendTask('started');
  await appendTask('cancelled', { status: 'cancelled', terminalReason: 'cancelled_by_user' });
  const result = await pruneRepositoryEvents(db);
  assert.equal(result.deleted, 1);
  assert.deepEqual((await list({ fromStart: true, domains: ['task'] })).events.map(event => event.type), ['started', 'cancelled']);
});
