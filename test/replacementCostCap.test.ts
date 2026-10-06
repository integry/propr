import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import knex from 'knex';
import { closeConnection, RunCostCapExceededError } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import { up as addLineage } from '../packages/core/src/db/migrations/20261006000000_add_task_replacement_lineage.js';
import { issueRunCostCapDeps, issueRunCostCapTarget, withRunCostCap, type RunCostCapDeps } from '../src/jobs/runCostCap.js';
import { createTaskReplacementService } from '../src/taskReplacement/service.js';
import { createTaskReplacementStore, recordReplayableIssueTask } from '../src/taskReplacement/store.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
after(async () => { await database.destroy(); await closeConnection(); });

await database.schema.createTable('tasks', table => {
    table.string('task_id').primary();
    table.string('job_id').unique();
    table.string('correlation_id');
    table.string('repository').notNullable();
    table.integer('issue_number');
    table.string('task_type').notNullable();
    table.string('model_name');
    table.timestamp('created_at');
    table.json('initial_job_data');
});
await database.schema.createTable('task_history', table => {
    table.increments('history_id').primary();
    table.string('task_id').notNullable();
    table.string('state').notNullable();
    table.timestamp('timestamp').notNullable();
    table.text('reason');
    table.json('metadata');
});
await database.schema.createTable('llm_executions', table => {
    table.increments('execution_id').primary();
    table.string('task_id').notNullable();
    table.decimal('cost_usd', 10, 6);
});
await addLineage(database);

let instanceDefault = 5;
const baseDeps: RunCostCapDeps = {
    loadInstanceDefault: async () => instanceDefault,
    async readRecordedSpend(taskIds) {
        const row = await database('llm_executions').whereIn('task_id', taskIds).sum({ total: 'cost_usd' }).first() as { total: unknown };
        return Number(row.total) || 0;
    },
    storeCap: async () => {},
    recordExceeded: async () => {},
    checkIntervalMs: 60_000,
};
const noLookups = { findSubmission: async () => undefined, readOverride: async () => undefined };
const issueContext = (taskId: string) => ({ taskId, modelName: 'claude-opus-5-5', correlatedLogger: { warn: () => undefined } as never });

test('a replacement is held to the original run\'s effective cap minus what the lineage spent', async () => {
    const job = {
        repoOwner: 'integry', repoName: 'propr', number: 2739, agentAlias: 'claude', modelName: 'claude-opus-5-5', correlationId: 'original',
    } as IssueJobData;
    await database('tasks').insert({ task_id: 'task-1', repository: 'integry/propr', issue_number: 2739, task_type: 'issue' });
    await recordReplayableIssueTask(database, 'task-1', job);
    // The original run resolves its cap from the instance default, with no task override.
    await withRunCostCap(await issueRunCostCapTarget(job, issueContext('task-1'), undefined, noLookups), async guard => {
        assert.deepEqual(guard.cap, { capUsd: 5, source: 'instance_default' });
    }, issueRunCostCapDeps(database, baseDeps));
    await database('llm_executions').insert({ task_id: 'task-1', cost_usd: 2 });
    await database('task_history').insert({ task_id: 'task-1', state: 'failed', timestamp: '2026-10-06T08:02:00.000Z', metadata: '{}' });

    const enqueued: IssueJobData[] = [];
    const service = createTaskReplacementService({
        store: createTaskReplacementStore(database),
        enqueue: async (_name, data) => { enqueued.push(data); },
        loadMaxProviderReplacements: async () => 2,
        infraLostEnabled: () => true,
    });
    const outcome = await service.complete({ taskId: 'task-1', cause: 'provider_transient' });
    assert.ok(outcome.action === 'dispatched');

    // The instance default changes before the replacement runs; the lineage keeps its original cap.
    instanceDefault = 50;
    const replacementId = outcome.replacementTaskId;
    await withRunCostCap(await issueRunCostCapTarget(enqueued[0], issueContext(replacementId), undefined, noLookups), async guard => {
        assert.equal(guard.cap?.capUsd, 5);
        await database('llm_executions').insert({ task_id: replacementId, cost_usd: 2.5 });
        await guard.admit();
        await database('llm_executions').insert({ task_id: replacementId, cost_usd: 0.5 });
        await assert.rejects(guard.admit(), RunCostCapExceededError, 'the $3 remainder is used up');
    }, issueRunCostCapDeps(database, baseDeps));
});
