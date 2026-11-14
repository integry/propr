/**
 * The task timeline row of an agent-capacity wait names the agent and the
 * ceiling it waits on, even when the refusal carries no ceiling, and a wait for
 * another agent gets its own row instead of rewording the old one.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pino from 'pino';
import { persistAgentCapacityDeferral } from '../src/jobs/agentCapacityDeferral.js';
import { recordCapacityDeferral } from '../src/jobs/capacityDeferral.js';

const previous = { ...process.env };
before(() => {
    // Admission with ceilings; Redis deliberately unreachable (every capacity call is best effort).
    Object.assign(process.env, {
        PROPR_AGENT_RUN_LIMIT: '3', PROPR_INSTANCE_ID: 'timeline-row', PROPR_AGENT_RUN_ALIAS_LIMITS: 'local-llama=1,cloud=2',
        REDIS_HOST: '127.0.0.1', REDIS_PORT: '1',
    });
});
after(async () => {
    // The core import graph opens the database pool; its reaper would keep this file alive.
    await (await import('@propr/core')).closeConnection();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
});

type Row = { state: string; reason: string; metadata?: Record<string, unknown> };
function timeline() {
    const history: Row[] = [{ state: 'queued', reason: 'Queued' }];
    const stateManager = {
        getTaskState: async () => ({ state: 'queued', createdAt: 'c', updatedAt: 'u', correlationId: 'x', version: history.length, history }),
        updateHistoryMetadata: async (_task: string, state: string, metadata: Record<string, unknown>) => {
            const row = history.findLast(entry => entry.state === state)!;
            row.metadata = { ...row.metadata, ...metadata };
        },
        updateTaskStateIfCurrent: async (_task: string, _expected: unknown, state: string, update: { reason: string; historyMetadata: Record<string, unknown> }) => {
            history.push({ state, reason: update.reason, metadata: update.historyMetadata });
            return true;
        },
    };
    return { history, stateManager };
}
const log = pino({ level: 'silent' });
const refusal = (aliases: string[], ceilings?: Record<string, number>) => Object.assign(new Error('Waiting for agent capacity'), { name: 'AgentCapacityError', aliases, ...(ceilings ? { ceilings } : {}) });

test('the row names the agent and its configured ceiling when the refusal carries none', async () => {
    const { history, stateManager } = timeline();
    const job = { data: {} as Record<string, unknown>, updateData: async (data: Record<string, unknown>) => { job.data = data; }, queueName: 'q', id: 'J1' };
    await persistAgentCapacityDeferral({ job, error: refusal(['local-llama']), correlatedLogger: log, stateManager: stateManager as never, taskId: 'task-1', now: 1_000 });
    const rows = history.filter(row => row.metadata?.agentCapacityDeferrals);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'Waiting for agent capacity: local-llama (limit 1)');
    assert.deepEqual(rows[0].metadata!.agentCapacityAliases, ['local-llama']);
    assert.deepEqual(rows[0].metadata!.agentCapacityCeilings, { 'local-llama': 1 });

    // The same wait again: updated in place.
    await persistAgentCapacityDeferral({ job, error: refusal(['local-llama'], { 'local-llama': 1 }), correlatedLogger: log, stateManager: stateManager as never, taskId: 'task-1', now: 2_000 });
    assert.equal(history.filter(row => row.metadata?.agentCapacityDeferrals).length, 1);
    assert.equal(history.at(-1)!.metadata!.agentCapacityDeferrals, 2);

    // Now it waits for another agent: a new row says so.
    await persistAgentCapacityDeferral({ job, error: refusal(['cloud']), correlatedLogger: log, stateManager: stateManager as never, taskId: 'task-1', now: 3_000 });
    const waits = history.filter(row => row.metadata?.agentCapacityDeferrals);
    assert.deepEqual(waits.map(row => row.reason), ['Waiting for agent capacity: local-llama (limit 1)', 'Waiting for agent capacity: cloud (limit 2)']);
    assert.equal(waits[1].metadata!.agentCapacityDeferrals, 3, 'one wait, one count');
});

test('repository capacity rows keep updating in place', async () => {
    const { history, stateManager } = timeline();
    for (const deferrals of [1, 2, 3]) {
        await recordCapacityDeferral({ kind: 'repository', stateManager: stateManager as never, taskId: 't', correlatedLogger: log, deferrals, retryAt: 10_000, reason: 'Waiting for repository capacity' });
    }
    const rows = history.filter(row => row.metadata?.repositoryWorkflowDeferrals);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata!.repositoryWorkflowDeferrals, 3);
});
