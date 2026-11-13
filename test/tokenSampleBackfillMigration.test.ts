import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { DEFAULT_TOKEN_OUTLIER_SETTINGS } from '@propr/shared';
import {
    TOKEN_SAMPLES_TABLE, readTokenBaseline, recordTokenUsageSample, type TokenUsageSample,
} from '../packages/core/src/utils/tokenOutlierAlert.ts';

const migrations = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
const BACKFILL = '20261113000000_backfill_llm_execution_token_samples.js';
const NOW = new Date('2026-11-13T12:00:00.000Z');
const MODEL = 'claude-opus-5-5';

let db: Knex;

/** A database migrated up to, but not including, the backfill: an instance mid-upgrade. */
async function migrateToBeforeBackfill(): Promise<void> {
    for (;;) {
        const [, pending] = await db.migrate.list({ directory: migrations }) as [unknown, Array<{ file: string }>];
        if (pending[0]?.file === BACKFILL) return;
        assert.ok(pending.length > 0, 'the backfill migration is pending');
        await db.migrate.up({ directory: migrations });
    }
}

beforeEach(async () => {
    await db?.destroy();
    db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await migrateToBeforeBackfill();
});

after(async () => {
    await db?.destroy();
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

let sequence = 0;

interface HistoricalRun {
    repository?: string;
    taskType?: string;
    model?: string;
    success?: boolean;
    tokens?: number;
    /** The `llm_logs` execution types of the run's calls; none when omitted. */
    logged?: string[];
    session?: string | null;
    withTask?: boolean;
}

/** An execution recorded by the code before the sample table, with its task and logged calls. */
async function historicalRun(run: HistoricalRun = {}): Promise<number> {
    sequence++;
    const taskId = `task-${sequence}`;
    const session = run.session === undefined ? `session-${sequence}` : run.session;
    await db('tasks').insert({ task_id: taskId, repository: run.repository ?? 'Acme/Widgets', task_type: run.taskType ?? 'issue' });
    const tokens = run.tokens ?? 100_000;
    const [row] = await db('llm_executions').insert({
        task_id: run.withTask === false ? null : taskId, session_id: session,
        start_time: new Date(NOW.getTime() - (1000 - sequence) * 60_000).toISOString(),
        model_name: run.model ?? MODEL, success: run.success ?? true,
        input_tokens: Math.round(tokens * 0.9), output_tokens: tokens - Math.round(tokens * 0.9),
    }).returning('execution_id');
    for (const executionType of run.logged ?? ['implementation']) {
        await db('llm_logs').insert({ execution_type: executionType, model_name: run.model ?? MODEL, session_id: session, task_id: taskId });
    }
    return Number((row as { execution_id: number }).execution_id ?? row);
}

async function upgrade(): Promise<void> {
    await db.migrate.latest({ directory: migrations });
}

const key = { repository: 'acme/widgets', model: MODEL, executionType: 'issue' };

async function recordNew(overrides: Partial<TokenUsageSample> = {}) {
    const [row] = await db('llm_executions').insert({ task_id: null, start_time: NOW.toISOString(), model_name: MODEL, success: true })
        .returning('execution_id');
    const executionId = Number((row as { execution_id: number }).execution_id ?? row);
    return recordTokenUsageSample({
        executionId, taskId: null, repository: 'acme/widgets', model: MODEL, executionType: 'issue',
        success: true, totalTokens: 100_000, number: 42, kind: 'issue', ...overrides,
    }, {
        database: db, now: () => NOW,
        loadSettings: async () => ({ ...DEFAULT_TOKEN_OUTLIER_SETTINGS }),
        notify: async () => 'delivered' as const,
    });
}

test('an outlier right after the upgrade is measured against the executions recorded before it', async () => {
    for (let index = 0; index < 20; index++) await historicalRun();
    await upgrade();

    const result = await recordNew({ taskId: 'after-upgrade', totalTokens: 10_000_000 });
    assert.equal(result.evaluation.status, 'outlier');
    assert.equal(result.evaluation.status === 'outlier' && result.evaluation.baselineTokens, 100_000);
    assert.equal(result.evaluation.samples, 20);
    assert.equal(result.alerted, true);
});

test('backfilled samples keep the repository, model and execution type of the run that recorded them', async () => {
    await historicalRun();
    await historicalRun({ taskType: 'goal' });
    await historicalRun({ taskType: 'pr-comment', tokens: 200_000 });
    await historicalRun({ taskType: 'merge_conflict', tokens: 300_000 });
    await historicalRun({ taskType: 'pr-comment', logged: ['pr-review'], tokens: 400_000 });
    await historicalRun({ taskType: 'issue', logged: ['context-analysis'], tokens: 500_000 });
    await historicalRun({ repository: 'acme/gadgets', tokens: 600_000 });
    await historicalRun({ model: 'gpt-5.5', tokens: 700_000 });
    await upgrade();

    const samples = await db(TOKEN_SAMPLES_TABLE).orderBy('execution_id')
        .select('repository', 'model_name', 'execution_type', 'total_tokens', 'success', 'task_id', 'alerted_at');
    assert.deepEqual(samples.map(row => [row.repository, row.model_name, row.execution_type, Number(row.total_tokens)]), [
        ['acme/widgets', MODEL, 'issue', 100_000],
        ['acme/widgets', MODEL, 'issue', 100_000],
        ['acme/widgets', MODEL, 'pr_comment', 200_000],
        ['acme/widgets', MODEL, 'merge_conflict', 300_000],
        ['acme/widgets', MODEL, 'pr-review', 400_000],
        ['acme/widgets', MODEL, 'context-analysis', 500_000],
        ['acme/gadgets', MODEL, 'issue', 600_000],
        ['acme/widgets', 'gpt-5.5', 'issue', 700_000],
    ]);
    assert.ok(samples.every(row => Boolean(row.success) && row.alerted_at === null), 'copied as successful, never as alerts');
    assert.ok(samples.every(row => typeof row.task_id === 'string' && row.task_id.startsWith('task-')), 'each sample keeps its task');
    assert.deepEqual(await readTokenBaseline(db, key, 20), [100_000, 100_000]);
});

test('executions whose baseline key cannot be attributed are not copied', async () => {
    await historicalRun({ success: false });
    await historicalRun({ logged: [] });
    await historicalRun({ session: null });
    await historicalRun({ session: 'unknown' });
    await historicalRun({ withTask: false });
    await historicalRun({ taskType: 'agent-run' });
    await historicalRun({ taskType: 'pr-comment', logged: ['implementation', 'pr-review'] });
    const noTokens = await historicalRun();
    await db('llm_executions').where({ execution_id: noTokens }).update({ input_tokens: null });
    await upgrade();

    assert.equal(Number((await db(TOKEN_SAMPLES_TABLE).count({ count: '*' }).first())?.count), 0);
});

test('each key keeps at most the largest baseline window, most recent first', async () => {
    for (let index = 0; index < 205; index++) await historicalRun({ tokens: 100_000 + index });
    await upgrade();

    const samples = await db(TOKEN_SAMPLES_TABLE).orderBy('execution_id', 'desc').select('total_tokens');
    assert.equal(samples.length, 200);
    assert.equal(Number(samples[0].total_tokens), 100_204);
    assert.equal(Number(samples[199].total_tokens), 100_005);
});

test('without history the first runs after the upgrade still wait for the minimum', async () => {
    await upgrade();
    const result = await recordNew({ totalTokens: 10_000_000 });
    assert.deepEqual(result.evaluation, { status: 'insufficient_history', samples: 0 });
});
