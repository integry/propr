import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { appendRepositoryEvent, closeConnection, pruneRepositoryEvents } from '@propr/core';
import { decodeRepositoryEventCursor, encodeRepositoryEventCursor, type RepositoryEventDomain } from '@propr/shared';
import {
  RepositoryEventWaitError,
  activeRepositoryEventWaiterCount,
  installRepositoryEventAppendHook,
  listRepositoryEventsAfterCursor,
  notifyRepositoryEventWaiters,
  waitForRepositoryEvents,
  type RepositoryEventWaitOptions,
} from '../services/repositoryEventWait.js';

const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const repository = 'acme/app';
const otherRepository = 'acme/other';
const ownerId = '123';
let db: Knex;

after(closeConnection);
beforeEach(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
  await db.migrate.latest({ directory: migrations });
});
afterEach(async () => {
  await db.destroy();
  assert.equal(activeRepositoryEventWaiterCount(), 0, 'no wake listener outlives its wait');
});

let counter = 0;
async function append(overrides: { domain?: RepositoryEventDomain; type?: string; repository?: string; prNumber?: number; planId?: string; occurredAt?: string } = {}): Promise<number> {
  const domain = overrides.domain ?? 'pull_request';
  const prNumber = overrides.prNumber ?? (domain === 'pull_request' ? 7 : undefined);
  const result = await appendRepositoryEvent(db, {
    repository: overrides.repository ?? repository, domain, type: overrides.type ?? 'head_changed',
    entityId: prNumber ?? `entity-${++counter}`, prNumber, planId: overrides.planId, headSha: domain === 'pull_request' ? 'a'.repeat(40) : null,
    payload: { n: ++counter }, occurredAt: overrides.occurredAt,
  }, { publish: false });
  assert.equal(result.status, 'appended');
  return (result as { seq: number }).seq;
}

const list = (options: Partial<Parameters<typeof listRepositoryEventsAfterCursor>[0]> = {}) =>
  listRepositoryEventsAfterCursor({ db, repository, ...options });
const wait = (options: Partial<RepositoryEventWaitOptions> = {}) =>
  waitForRepositoryEvents({ db, repository, ownerId, timeoutSeconds: 5, pollIntervalMs: 60_000, ...options });

async function rejects(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RepositoryEventWaitError, String(error));
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(error.recovery.length > 0, 'every error carries a recovery instruction');
    return true;
  });
}

const seqOf = (cursor: string) => (decodeRepositoryEventCursor(cursor, repository) as { seq: number }).seq;

test('without a cursor a list starts at the current end; fromStart returns the retained history', async () => {
  const first = await append({ type: 'opened' });
  await append({ repository: otherRepository });
  const second = await append();

  const current = await list();
  assert.deepEqual(current.events, []);
  assert.equal(current.truncated, false);
  assert.equal(seqOf(current.cursor), second, 'the current cursor is the end of this repository\'s journal');

  const history = await list({ fromStart: true });
  assert.deepEqual(history.events.map(event => seqOf(event.cursor)), [first, second]);
  assert.ok(history.events.every(event => event.repository === repository), 'other repositories are never returned');
  assert.equal(history.cursor, history.events[1].cursor);
  const [event] = history.events;
  assert.deepEqual(Object.keys(event).sort(), ['cursor', 'domain', 'entityId', 'head', 'occurredAt', 'payload', 'pullRequest', 'repository', 'type'].sort());
  assert.equal(event.pullRequest, 7);
  assert.equal(event.head, 'a'.repeat(40));
});

test('listing after a cursor returns exactly the later events, in order, and pages with truncated', async () => {
  const start = (await list()).cursor;
  const seqs = [await append({ type: 'opened' }), await append(), await append({ type: 'review_scored' }), await append({ type: 'merged' })];
  const all = await list({ afterCursor: start });
  assert.deepEqual(all.events.map(event => seqOf(event.cursor)), seqs);
  assert.deepEqual(all.events.map(event => event.type), ['opened', 'head_changed', 'review_scored', 'merged']);

  const page = await list({ afterCursor: start, limit: 3 });
  assert.equal(page.events.length, 3);
  assert.equal(page.truncated, true);
  assert.equal(seqOf(page.cursor), seqs[2], 'the cursor stops at the last returned event');
  const rest = await list({ afterCursor: page.cursor, limit: 3 });
  assert.deepEqual(rest.events.map(event => seqOf(event.cursor)), [seqs[3]]);
  assert.equal(rest.truncated, false);

  const empty = await list({ afterCursor: rest.cursor });
  assert.deepEqual(empty.events, []);
  assert.equal(empty.cursor, rest.cursor, 'an empty read keeps the cursor');
});

test('filters by domain, type, pull request and plan', async () => {
  const start = (await list()).cursor;
  await append({ type: 'opened', prNumber: 7 });
  await append({ type: 'opened', prNumber: 8 });
  await append({ domain: 'epic_queue', type: 'advanced', planId: 'plan-1' });
  await append({ domain: 'plan_issue', type: 'status_changed', planId: 'plan-2' });
  await append({ type: 'merged', prNumber: 8 });

  const types = async (options: Parameters<typeof list>[0]) => (await list({ afterCursor: start, ...options })).events.map(event => event.type);
  assert.deepEqual(await types({ domains: ['epic_queue', 'plan_issue'] }), ['advanced', 'status_changed']);
  assert.deepEqual(await types({ types: ['merged', 'advanced'] }), ['advanced', 'merged']);
  assert.deepEqual(await types({ pullRequest: 8 }), ['opened', 'merged']);
  assert.deepEqual(await types({ planId: 'plan-2' }), ['status_changed']);
  assert.deepEqual(await types({ domains: ['pull_request'], types: ['opened'], pullRequest: 7 }), ['opened']);
});

test('every cursor error is reported with its code, and an expired cursor differs from an empty result', async () => {
  await rejects(list({ afterCursor: 'not-a-cursor' }), 'CURSOR_INVALID', 400);
  await rejects(list({ afterCursor: 'rec1.%%%' }), 'CURSOR_INVALID', 400);
  await rejects(list({ afterCursor: `rec1.${Buffer.from('{"r":"acme/app","s":-1}').toString('base64url')}` }), 'CURSOR_INVALID', 400);
  await rejects(list({ afterCursor: encodeRepositoryEventCursor(repository, 9_999) }), 'CURSOR_INVALID', 400);
  await rejects(list({ afterCursor: encodeRepositoryEventCursor(otherRepository, 0) }), 'CURSOR_WRONG_REPOSITORY', 400);
  // Repository names are case-insensitive on GitHub.
  assert.deepEqual((await list({ afterCursor: encodeRepositoryEventCursor('ACME/App', 0) })).events, []);

  const old = '2026-01-01T00:00:00.000Z';
  const stale = await append({ occurredAt: old });
  const pruned = await append({ occurredAt: old });
  const kept = await append();
  const beforeStale = encodeRepositoryEventCursor(repository, stale - 1);
  await pruneRepositoryEvents(db, { olderThanDays: 30, now: () => Date.parse('2026-11-12T00:00:00.000Z') });

  // The last pruned position is still a valid resume point: nothing after it was lost.
  const resumed = await list({ afterCursor: encodeRepositoryEventCursor(repository, pruned) });
  assert.deepEqual(resumed.events.map(event => seqOf(event.cursor)), [kept]);
  await rejects(list({ afterCursor: beforeStale }), 'CURSOR_EXPIRED', 410);
  await rejects(list({ afterCursor: encodeRepositoryEventCursor(repository, 0) }), 'CURSOR_EXPIRED', 410);
  await rejects(wait({ afterCursor: beforeStale, timeoutSeconds: 0 }), 'CURSOR_EXPIRED', 410);
  // A repository that was never pruned keeps the start of its journal.
  assert.deepEqual((await list({ repository: otherRepository, afterCursor: encodeRepositoryEventCursor(otherRepository, 0) })).events, []);
  await rejects(list({ limit: 101 }), 'INVALID_INPUT', 400);
});

test('wait returns at once when matching events already exist after the cursor', async () => {
  const start = (await list()).cursor;
  const seq = await append({ type: 'merged' });
  const result = await wait({ afterCursor: start, timeoutSeconds: 30 });
  assert.equal(result.outcome, 'events');
  assert.deepEqual(result.events.map(event => seqOf(event.cursor)), [seq]);
  assert.equal(seqOf(result.cursor), seq);
  assert.ok(result.waitedMs < 1_000, `waited ${result.waitedMs}ms`);
  assert.equal(result.timeoutSeconds, 30);
});

test('wait wakes on a new matching event and ignores non-matching ones', async () => {
  const start = (await list()).cursor;
  const pending = wait({ afterCursor: start, types: ['merged'], timeoutSeconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeRepositoryEventWaiterCount(repository), 1);
  await append({ type: 'head_changed' });
  await append({ repository: otherRepository, type: 'merged' });
  notifyRepositoryEventWaiters(repository);
  notifyRepositoryEventWaiters(otherRepository);
  await new Promise(resolve => setTimeout(resolve, 30));
  const merged = await append({ type: 'merged' });
  notifyRepositoryEventWaiters('ACME/APP');
  const result = await pending;
  assert.equal(result.outcome, 'events');
  assert.deepEqual(result.events.map(event => [event.type, seqOf(event.cursor)]), [['merged', merged]]);
  assert.ok(result.waitedMs < 5_000);
});

test('an append committed in this process wakes waiters at once through the core hook', async () => {
  assert.equal(await installRepositoryEventAppendHook(), true);
  const pending = wait({ timeoutSeconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  // Inside a transaction the wake waits for the commit.
  await db.transaction(async trx => {
    const appended = await appendRepositoryEvent(trx, { repository, domain: 'pull_request', type: 'opened', entityId: 9, prNumber: 9 }, { publish: false });
    assert.equal(appended.status, 'appended');
  });
  const result = await pending;
  assert.equal(result.outcome, 'events');
  assert.deepEqual(result.events.map(event => event.pullRequest), [9]);
  assert.ok(result.waitedMs < 5_000, 'woken by the hook, not the 60s poll');
});

test('wait times out with the unchanged cursor when only non-matching events arrive', async () => {
  const start = (await list()).cursor;
  await append({ type: 'head_changed' });
  const result = await wait({ afterCursor: start, domains: ['epic_queue'], timeoutSeconds: 0.1, pollIntervalMs: 20 });
  assert.equal(result.outcome, 'timeout');
  assert.deepEqual(result.events, []);
  assert.equal(result.cursor, start);
  assert.equal(result.truncated, false);

  const fresh = await wait({ timeoutSeconds: 0 });
  assert.equal(fresh.outcome, 'timeout');
  assert.equal(fresh.cursor, (await list()).cursor, 'without a cursor the wait starts at the current end');
});

test('concurrent waits per owner are limited and released', async () => {
  const controller = new AbortController();
  const open = wait({ timeoutSeconds: 30, signal: controller.signal, maxConcurrentPerOwner: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await rejects(wait({ timeoutSeconds: 0, maxConcurrentPerOwner: 1 }), 'WAIT_LIMIT', 429);
  // Another owner has its own count.
  assert.equal((await wait({ ownerId: '456', timeoutSeconds: 0, maxConcurrentPerOwner: 1 })).outcome, 'timeout');
  controller.abort();
  await rejects(open, 'WAIT_ABORTED', 499);
  assert.equal((await wait({ timeoutSeconds: 0, maxConcurrentPerOwner: 1 })).outcome, 'timeout', 'the slot was released');
});

test('an aborted wait is released at once, and a pre-aborted signal never opens one', async () => {
  const already = new AbortController();
  already.abort();
  await rejects(wait({ signal: already.signal }), 'WAIT_ABORTED', 499);

  const controller = new AbortController();
  const pending = wait({ timeoutSeconds: 30, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeRepositoryEventWaiterCount(repository), 1);
  const startedAt = Date.now();
  controller.abort();
  await rejects(pending, 'WAIT_ABORTED');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(activeRepositoryEventWaiterCount(repository), 0);
});

test('authorization is re-checked before each further read', async () => {
  let allowed = true;
  const pending = wait({ timeoutSeconds: 10, authorize: async () => { if (!allowed) throw new Error('revoked'); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  allowed = false;
  notifyRepositoryEventWaiters(repository);
  await assert.rejects(pending, /revoked/);
});

const OLD = '2026-01-01T00:00:00.000Z';
const prune = () => pruneRepositoryEvents(db, { olderThanDays: 30, now: () => Date.parse('2026-11-12T00:00:00.000Z') });

test('a completely pruned repository still issues resumable cursors without one', async () => {
  await append({ occurredAt: OLD });
  const last = await append({ occurredAt: OLD });
  await append({ repository: otherRepository });
  await prune();

  const current = await list();
  assert.deepEqual(current.events, []);
  assert.equal(seqOf(current.cursor), last, 'the current position is the retention floor, not 0');
  assert.deepEqual((await list({ afterCursor: current.cursor })).events, [], 'the issued cursor is not expired');

  const history = await list({ fromStart: true });
  assert.deepEqual(history.events, []);
  assert.deepEqual((await list({ afterCursor: history.cursor })).events, [], 'an empty fromStart read returns a valid resume point');

  for (const fromStart of [false, true]) {
    const timedOut = await wait({ fromStart, timeoutSeconds: 0 });
    assert.equal(timedOut.outcome, 'timeout');
    assert.deepEqual((await list({ afterCursor: timedOut.cursor })).events, [], `a cursorless wait (fromStart ${fromStart}) times out on a valid cursor`);
  }
  const next = await append();
  assert.deepEqual((await list({ afterCursor: current.cursor })).events.map(event => seqOf(event.cursor)), [next]);
});

test('a complete fromStart page of retained events below the floor resumes at the floor', async () => {
  // Retention deletes by age: an older-stamped event appended later raises the floor past a kept one.
  const kept = await append();
  const pruned = await append({ occurredAt: OLD });
  await prune();
  const history = await list({ fromStart: true });
  assert.deepEqual(history.events.map(event => seqOf(event.cursor)), [kept]);
  assert.equal(seqOf(history.cursor), pruned);
  assert.deepEqual((await list({ afterCursor: history.cursor })).events, []);
});

/** Run retention once, right after the statement matching `sql` is issued on `db`. */
function pruneAfterQuery(sql: RegExp): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onQuery = (query: { sql: string }) => {
      if (!sql.test(query.sql)) return;
      db.off('query', onQuery);
      prune().then(resolve, reject);
    };
    db.on('query', onQuery);
  });
}

test('retention committing during a read never yields a page that skips unread events', async () => {
  const start = (await list()).cursor;
  const unread = await append({ occurredAt: OLD });
  const later = await append();
  // Retention runs as soon as the read has looked at the floor.
  const pruning = pruneAfterQuery(/repository_event_floors/);
  const page = await list({ afterCursor: start });
  await pruning;
  // The page comes from the snapshot the floor was checked in: it still holds the unread event.
  assert.deepEqual(page.events.map(event => seqOf(event.cursor)), [unread, later]);
  await rejects(list({ afterCursor: start }), 'CURSOR_EXPIRED', 410);
});

test('retention pruning past the position of an open wait reports CURSOR_EXPIRED', async () => {
  const start = (await list()).cursor;
  await append({ type: 'head_changed', occurredAt: OLD });
  const cursorWait = wait({ afterCursor: start, types: ['merged'], timeoutSeconds: 10 });
  const freshWait = wait({ ownerId: '456', types: ['merged'], timeoutSeconds: 10 });
  const fromStartWait = wait({ ownerId: '789', fromStart: true, types: ['merged'], timeoutSeconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeRepositoryEventWaiterCount(repository), 3);
  await prune();
  // A newer old-stamped event: the fresh waits' positions are now behind the floor too.
  await append({ type: 'head_changed', occurredAt: OLD });
  await prune();
  notifyRepositoryEventWaiters(repository);
  await rejects(cursorWait, 'CURSOR_EXPIRED', 410);
  await rejects(freshWait, 'CURSOR_EXPIRED', 410);
  await rejects(fromStartWait, 'CURSOR_EXPIRED', 410);
});

test('events stored under another spelling of the repository are read, bounded and pruned as one journal', async () => {
  // The configuration says acme/app; a webhook recorded GitHub's Acme/App.
  const stored = 'Acme/App';
  const before = (await list()).cursor;
  const webhook = await append({ repository: stored, type: 'opened' });
  const configured = await append({ type: 'merged' });

  assert.deepEqual((await list({ fromStart: true })).events.map(event => seqOf(event.cursor)), [webhook, configured]);
  assert.deepEqual((await list({ afterCursor: before })).events.map(event => [event.type, event.repository]), [['opened', repository], ['merged', repository]]);
  assert.equal(seqOf((await list()).cursor), configured);

  const current = (await list()).cursor;
  const pending = wait({ afterCursor: current, timeoutSeconds: 10 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const woke = await append({ repository: stored, type: 'closed' });
  notifyRepositoryEventWaiters(stored);
  assert.deepEqual((await pending).events.map(event => seqOf(event.cursor)), [woke]);

  // Retention records the floor under the stored spelling; it still expires cursors of the configured one.
  const stale = await append({ repository: stored, occurredAt: OLD });
  await prune();
  await rejects(list({ afterCursor: encodeRepositoryEventCursor(repository, stale - 1) }), 'CURSOR_EXPIRED', 410);
  assert.equal(seqOf((await list()).cursor), stale);
});
