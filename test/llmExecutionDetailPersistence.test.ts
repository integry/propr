import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';

/**
 * Runs the real SQLite driver and migrations: a mocked database cannot show
 * that a long conversation fits SQLite's statement limits.
 */
const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const realDb: Knex = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await realDb.migrate.latest({ directory: migrations });

// Fails the batch holding sequence 250 a set number of times, then lets inserts through.
const transientFailures = { remaining: 0 };
const failingDb = Object.assign((table: string) => {
    const builder = realDb(table);
    if (table !== 'llm_execution_details') return builder;
    const insert = builder.insert.bind(builder);
    builder.insert = ((rows: Array<{ sequence_number: number }>) => {
        if (transientFailures.remaining > 0 && rows.some(row => row.sequence_number === 250)) {
            transientFailures.remaining--;
            return { onConflict: () => ({ ignore: () => Promise.reject(new Error('simulated transient failure')) }) };
        }
        return insert(rows as never);
    }) as never;
    return builder;
}, realDb);

const logged: { warn: unknown[]; error: unknown[] } = { warn: [], error: [] };

await mock.module('ioredis', { namedExports: { Redis: class {
    async setex() {} async lpush() {} async ltrim() {} async sadd() {} async incr() {}
    async get() { return null; } async set() { return 'OK'; } async quit() {}
} } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: failingDb, closeConnection: async () => {} } });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: {
    info() {}, debug() {}, warn(entry: unknown) { logged.warn.push(entry); }, error(entry: unknown) { logged.error.push(entry); },
} });
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: { getModelPricing: async () => null } });

const { recordLLMMetrics, insertConversationDetails } = await import('../packages/core/src/utils/llmMetrics.js');

const issueRef = { repoOwner: 'o', repoName: 'r', number: 1 };
let counter = 0;

const events = (count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'text', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(), text: `event-${index}`,
})) as never;

const record = async (conversationLog: unknown, extra: Record<string, unknown> = {}) => {
    const correlationId = `detail-${++counter}`;
    await recordLLMMetrics({ model: 'm', success: true, executionTime: 1000, sessionId: correlationId, conversationLog, ...extra } as never, issueRef, { correlationId });
    const execution = await realDb('llm_executions').where({ session_id: correlationId }).first();
    return execution as { execution_id: number } | undefined;
};
const detailRows = (executionId: number) => realDb('llm_execution_details').where({ execution_id: executionId }).orderBy('sequence_number');
const failAtSequence = (sequence: number) => realDb.raw(
    `CREATE TRIGGER fail_detail BEFORE INSERT ON llm_execution_details WHEN NEW.sequence_number = ${sequence} BEGIN SELECT RAISE(ABORT, 'simulated detail insert failure'); END`);
const stopFailing = () => realDb.raw('DROP TRIGGER IF EXISTS fail_detail');

before(() => { process.env.NODE_ENV = 'test'; });
beforeEach(async () => { transientFailures.remaining = 0; logged.warn.length = 0; logged.error.length = 0; await stopFailing(); });
after(async () => { await realDb.destroy(); });

for (const count of [50, 500, 5000]) {
    test(`persists all ${count} conversation events in order with their sequence numbers`, async () => {
        const execution = await record(events(count));
        assert.ok(execution, 'the execution row exists');
        const rows = await detailRows(execution.execution_id);
        assert.equal(rows.length, count);
        rows.forEach((row, index) => {
            assert.equal(row.sequence_number, index);
            assert.ok(String(row.metadata).includes(`event-${index}"`), `row ${index} keeps its own event`);
        });
        assert.deepEqual(logged.error, []);
    });
}

test('an empty conversation log persists the execution without details or errors', async () => {
    const execution = await record([]);
    assert.ok(execution);
    assert.equal((await detailRows(execution.execution_id)).length, 0);
    assert.deepEqual(logged.error, []);
});

test('a conversation log that is absent persists only the execution', async () => {
    const execution = await record(undefined);
    assert.ok(execution);
    assert.equal((await detailRows(execution.execution_id)).length, 0);
});

test('a transient insert failure is retried and every event is stored exactly once', async () => {
    transientFailures.remaining = 1;
    const execution = await record(events(600));
    assert.ok(execution);
    assert.equal(transientFailures.remaining, 0, 'the failure was hit');
    const rows = await detailRows(execution.execution_id);
    assert.deepEqual(rows.map(row => row.sequence_number), Array.from({ length: 600 }, (_, index) => index));
    assert.deepEqual(logged.error, []);
    assert.ok(logged.warn.some(entry => (entry as { attempt?: number }).attempt === 1), 'the retry is logged');
});

test('a persistent insert failure is reported as incomplete details, never as a clean success', async () => {
    await failAtSequence(250);
    const execution = await record(events(600));
    assert.ok(execution, 'the execution summary is kept');
    const stored = await detailRows(execution.execution_id);
    // Full batches before the failing one are stored, in order and without gaps.
    assert.ok(stored.length > 0 && stored.length < 600);
    assert.deepEqual(stored.map(row => row.sequence_number), Array.from({ length: stored.length }, (_, index) => index));
    assert.equal(logged.error.length, 1);
    const entry = logged.error[0] as { error: string; detailCount: number; executionId: number };
    assert.match(entry.error, /simulated detail insert failure/);
    assert.equal(entry.detailCount, 600);
    assert.equal(entry.executionId, execution.execution_id);
});

test('repeating the detail insert after a partial failure completes the rows without duplicates', async () => {
    await failAtSequence(250);
    const execution = await record(events(600));
    assert.ok(execution);
    await stopFailing();
    const details = Array.from({ length: 600 }, (_, index) => ({
        execution_id: execution.execution_id, sequence_number: index, event_timestamp: new Date(0).toISOString(), event_type: 'text',
        content: null, duration_ms: null, token_count_input: null, token_count_output: null, cost_usd: null,
        is_error: false, tool_name: null, tool_input: null, tool_use_id: null, metadata: `event-${index}`,
    }));
    await insertConversationDetails(details as never);
    await insertConversationDetails(details as never);
    const rows = await detailRows(execution.execution_id);
    assert.deepEqual(rows.map(row => row.sequence_number), Array.from({ length: 600 }, (_, index) => index));
});

test('batches are bounded below SQLite limits whatever the batch size asked for', async () => {
    const execution = await record([]);
    assert.ok(execution);
    const details = Array.from({ length: 2000 }, (_, index) => ({
        execution_id: String(execution.execution_id), sequence_number: index, event_timestamp: new Date(0).toISOString(), event_type: 'text',
        content: null, duration_ms: null, token_count_input: null, token_count_output: null, cost_usd: null,
        is_error: false, tool_name: null, tool_input: null, tool_use_id: null, metadata: null,
    }));
    await insertConversationDetails(details);
    assert.equal((await detailRows(execution.execution_id)).length, 2000);
});
