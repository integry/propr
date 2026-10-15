import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up } from '../src/db/migrations/20260922000000_add_task_submissions.js';
import { up as identityMigration } from '../src/db/migrations/20260922010000_preserve_task_submission_identity.js';
import { closeConnection } from '../src/db/connection.js';
import { insertTaskSubmission } from '../src/services/taskSubmissionService.js';
import { recordIssueRetryRunReceipt, acceptedRunTrigger, type TriggerLabelEvent, type IssueRetryRequest } from '../src/services/issueRetryRequest.js';

// The submission's dispatch receipt is a watermark every dispatch, carried-request settlement and follow-up
// reconciliation advances: a write applies only while the receipt is still the one its writer read, and only
// for a later trigger, as the issue's history orders them, never by comparing event IDs.

after(closeConnection);

const at = (second: number) => `2026-10-15T10:00:${String(second).padStart(2, '0')}Z`;
/** Trigger events whose IDs do not sort in history order, so only the history can order them. */
const E0 = { id: 900, event: 'labeled', created_at: at(0), label: { name: 'AI' } };
const E1 = { id: 50, event: 'labeled', created_at: at(1), label: { name: 'AI' } };
const E2 = { id: 7, event: 'labeled', created_at: at(2), label: { name: 'AI' } };
const E3 = { id: 1000, event: 'labeled', created_at: at(3), label: { name: 'AI' } };

async function withSubmission(retryEventId: string | null, body: (database: Knex, id: string) => Promise<void>) {
  const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await up(database);
    await identityMigration(database);
    const row = await insertTaskSubmission(database, { user_id: 'alice', submission_key: 'request-1', payload_hash: 'hash', repository: 'owner/repo', payload: '{}', attachments: '[]' });
    await database('task_submissions').where({ id: row.id }).update({ issue_number: 14, dispatch_complete: true, state: 'queued', retry_event_id: retryEventId });
    await body(database, row.id);
  } finally {
    await database.destroy();
  }
}
const receiptOf = async (database: Knex, id: string) => (await database('task_submissions').where({ id }).first('retry_event_id', 'state', 'error')) as { retry_event_id: string | null; state: string; error: string | null };

/** A history reader that counts its reads, returning `events` as GitHub shows them at the time. */
function reader(events: () => TriggerLabelEvent[]) {
  const reads = { count: 0 };
  return { reads, history: async () => { reads.count++; return events(); } };
}

test('a receipt write advances the receipt it read to a later trigger', async () => {
  await withSubmission(String(E0.id), async (database, id) => {
    const { history } = reader(() => [E0, E1]);
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E1.id), { observedEventId: String(E0.id), history }), 'recorded');
    assert.equal((await receiptOf(database, id)).retry_event_id, String(E1.id));
  });
});

test('a stale write of an earlier trigger meets a newer receipt, which it orders on the fresh history and keeps', async () => {
  await withSubmission(String(E0.id), async (database, id) => {
    // The writer read E0 and a history of E0 and E1; another dispatch has since consumed E2 and its run failed.
    await database('task_submissions').where({ id }).update({ retry_event_id: String(E2.id), state: 'failed', error: 'run failed' });
    const { reads, history } = reader(() => [E0, E1, E2]);
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E1.id), { observedEventId: String(E0.id), events: [E0, E1], history }), 'covered');
    assert.deepEqual(await receiptOf(database, id), { retry_event_id: String(E2.id), state: 'failed', error: 'run failed' }, 'nothing of the newer receipt is overwritten');
    assert.equal(reads.count, 1, 'the conflict is ordered on the history read afresh, which shows the newer receipt');
  });
});

test('a write that meets an intermediate receipt still advances to its later trigger', async () => {
  await withSubmission(String(E0.id), async (database, id) => {
    await database('task_submissions').where({ id }).update({ retry_event_id: String(E1.id) });
    const { history } = reader(() => [E0, E1, E2, E3]);
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E3.id), { observedEventId: String(E0.id), events: [E0, E1, E2, E3], history, admitted: true }), 'recorded');
    assert.equal((await receiptOf(database, id)).retry_event_id, String(E3.id));
  });
});

test('a write of the trigger the receipt already records, or of none, changes nothing', async () => {
  await withSubmission(String(E2.id), async (database, id) => {
    await database('task_submissions').where({ id }).update({ state: 'failed' });
    const { reads, history } = reader(() => [E0, E1, E2]);
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E2.id), { observedEventId: String(E2.id), history }), 'covered');
    assert.equal(await recordIssueRetryRunReceipt(database, id, undefined, { observedEventId: String(E2.id), history }), 'covered');
    assert.deepEqual(await receiptOf(database, id), { retry_event_id: String(E2.id), state: 'failed', error: null });
    assert.equal(reads.count, 0);
  });
});

test('a write whose trigger the history places before the receipt it read is not applied, however its ID sorts', async () => {
  await withSubmission(String(E2.id), async (database, id) => {
    const { history } = reader(() => [E0, E1, E2, E3]);
    // E0's ID sorts after E2's; the history places it first.
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E0.id), { observedEventId: String(E2.id), history }), 'covered');
    assert.equal((await receiptOf(database, id)).retry_event_id, String(E2.id));
  });
});

test('a receipt the history cannot order the trigger against is neither overwritten nor taken to cover it', async () => {
  await withSubmission('unknown-event', async (database, id) => {
    const { reads, history } = reader(() => [E0, E1]);
    await assert.rejects(recordIssueRetryRunReceipt(database, id, String(E1.id), { observedEventId: 'unknown-event', events: [E0, E1], history }), /cannot order/);
    assert.equal((await receiptOf(database, id)).retry_event_id, 'unknown-event');
    assert.equal(reads.count, 1, 'it is first read afresh');
    // A history that cannot be read fails the write the same way.
    await assert.rejects(recordIssueRetryRunReceipt(database, id, String(E1.id), { observedEventId: 'unknown-event', history: async () => { throw new Error('read ECONNRESET'); } }), /ECONNRESET/);
    assert.equal((await receiptOf(database, id)).retry_event_id, 'unknown-event');
  });
});

test('a dispatch\'s own admitted trigger advances the receipt it read without another history read, but a conflict is still ordered', async () => {
  // The consumed trigger is gone from the history, so admission took only the latest event, by its time.
  await withSubmission('gone', async (database, id) => {
    const { reads, history } = reader(() => [E1, E2]);
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E2.id), { observedEventId: 'gone', history, admitted: true }), 'recorded');
    assert.equal(reads.count, 0);
    assert.equal((await receiptOf(database, id)).retry_event_id, String(E2.id));
    // A dispatch that admitted E1 against the same receipt meets E2: its admission says nothing about E2.
    assert.equal(await recordIssueRetryRunReceipt(database, id, String(E1.id), { observedEventId: 'gone', history, admitted: true }), 'covered');
    assert.equal((await receiptOf(database, id)).retry_event_id, String(E2.id));
  });
});

test('the accepted run\'s trigger is the queue\'s record of it, placed on a fresh history when the caller\'s predates it', async () => {
  const request = { id: 1, requesterId: 'user-1', commentId: 5, requestedAt: 0, publishedAt: Date.parse(at(1)), afterEventId: String(E0.id),
    actorId: null, publication: 'possible', resumedAt: null } as IssueRetryRequest;
  const { reads, history } = reader(() => [E0, E1, E2]);
  // The caller selected the request on E1, from a history without E2; another dispatch accepted its run through E2.
  const accepted = await acceptedRunTrigger(request, { receiptEventId: String(E2.id) }, { events: [E0, E1], history });
  assert.equal(accepted.eventId, String(E2.id), 'not the caller\'s own, stale, E1');
  assert.deepEqual(accepted.events, [E0, E1, E2]);
  assert.equal(reads.count, 1);
  // A trigger no history shows is still the run's.
  assert.equal((await acceptedRunTrigger(request, { receiptEventId: 'unshown' }, { events: [E0, E1], history })).eventId, 'unshown');
  // A history that shows it already is used as it is.
  assert.equal((await acceptedRunTrigger(request, { receiptEventId: String(E1.id) }, { events: [E0, E1], history })).eventId, String(E1.id));
  assert.equal(reads.count, 2);
});
