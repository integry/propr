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

// Each listed sequence fails the batch holding it once, then lets it through.
const transientFailures = new Set<number>();
const failingDb = Object.assign((table: string) => {
    const builder = realDb(table);
    if (table !== 'llm_execution_details') return builder;
    const insert = builder.insert.bind(builder);
    builder.insert = ((rows: Array<{ sequence_number: number }>) => {
        const failing = rows.find(row => transientFailures.has(row.sequence_number));
        if (failing) {
            transientFailures.delete(failing.sequence_number);
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

const { persistToDatabase, recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');
const { insertConversationDetails } = await import('../packages/core/src/utils/llmMetricsDetails.js');

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
beforeEach(async () => { transientFailures.clear(); logged.warn.length = 0; logged.error.length = 0; await stopFailing(); });
after(async () => { await realDb.destroy(); });

for (const scenario of [
    { name: 'successful batches', log: events(101), complete: true },
    { name: 'an empty log', log: [], complete: true },
    { name: 'an absent log', log: undefined, complete: true },
    { name: 'an exhausted second batch', log: events(101), complete: false },
]) {
    test(`persistToDatabase returns detail completion status for ${scenario.name}`, async () => {
        if (!scenario.complete) await failAtSequence(100);
        const sessionId = `status-${++counter}`;
        const result = await persistToDatabase({ conversationLog: scenario.log }, null, {
            sessionId, conversationId: null, executionTimeMs: 1000, model: 'm', success: true, numTurns: 1, costUsd: 0,
        });
        const row = await realDb('llm_executions').where({ session_id: sessionId }).first();
        assert.ok(row);
        assert.deepEqual(result, { executionId: row.execution_id, taskId: null, detailsPersisted: scenario.complete });
    });
}

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

test('transient failures in several batches are each retried and every event is stored exactly once', async () => {
    for (const sequence of [50, 250, 450]) transientFailures.add(sequence);
    const execution = await record(events(600));
    assert.ok(execution);
    assert.equal(transientFailures.size, 0, 'every failure was hit');
    const rows = await detailRows(execution.execution_id);
    assert.deepEqual(rows.map(row => row.sequence_number), Array.from({ length: 600 }, (_, index) => index));
    assert.deepEqual(logged.error, []);
    assert.deepEqual(logged.warn.flatMap(entry => (entry as { firstSequence?: number }).firstSequence ?? []), [0, 200, 400], 'each batch retry is logged');
});

test('a persistent insert failure is reported as incomplete details, never as a clean success', async () => {
    await failAtSequence(250);
    const execution = await record(events(600));
    assert.ok(execution, 'the execution summary is kept');
    const stored = await detailRows(execution.execution_id);
    // The two full batches before the failing one are stored, in order and without gaps.
    assert.deepEqual(stored.map(row => row.sequence_number), Array.from({ length: 200 }, (_, index) => index));
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

test('a direct insert of 2,000 rows is split into SQLite-safe batches', async () => {
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
