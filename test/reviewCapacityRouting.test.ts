/**
 * PR reviews can use several aliases in one job: every reviewer is routed
 * capacity-aware before the starting comment, and any saturated reviewer defers
 * the whole job with one refusal naming each saturated alias.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AgentCapacityError } from '../packages/core/src/agents/agentCapacity.ts';
import { routeReviewAssignments } from '../src/jobs/prReviewRunner.ts';
import { isAgentCapacityRefusal } from '../src/jobs/agentCapacityDeferral.ts';

after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
});

const log = { warn() {}, info() {} } as never;
const assignments = [
    { agentAlias: 'cloud', model: 'opus', label: 'Cloud' },
    { agentAlias: 'local-llama', model: 'llama', label: 'Local' },
    { agentAlias: 'pool', model: 'smart', label: 'Pool' },
];

function registry(saturated: Set<string>, missing = new Set<string>()) {
    const requests: Array<{ requestedAgentAlias: string; deferOnCapacity?: boolean }> = [];
    return { requests, value: { beginRoutingSession: (options: { requestedAgentAlias: string; requestedModel: string; deferOnCapacity?: boolean }) => {
        requests.push(options);
        return { select: async () => {
            if (missing.has(options.requestedAgentAlias)) throw new Error(`Agent not found: ${options.requestedAgentAlias}`);
            const physical = options.requestedAgentAlias === 'pool' ? 'pool-member' : options.requestedAgentAlias;
            if (options.deferOnCapacity && saturated.has(physical)) throw new AgentCapacityError([physical], { [physical]: 1 });
            return { physicalAgentAlias: physical, physicalModel: options.requestedModel };
        } };
    } } };
}

test('every reviewer is routed capacity-aware; a saturated reviewer defers the whole review', async () => {
    const { value, requests } = registry(new Set(['local-llama', 'pool-member']));
    await assert.rejects(routeReviewAssignments(value as never, assignments, 7, log), (error: unknown) => {
        assert.ok(isAgentCapacityRefusal(error));
        assert.deepEqual((error as { aliases: string[] }).aliases, ['local-llama', 'pool-member']);
        assert.match((error as Error).message, /Waiting for agent capacity/);
        return true;
    });
    assert.ok(requests.every(request => request.deferOnCapacity), 'routing never picks a saturated agent to wait on');
});

test('with capacity every reviewer routes; an unavailable reviewer still fails alone without deferring', async () => {
    const { value } = registry(new Set(), new Set(['pool']));
    const outcomes = await routeReviewAssignments(value as never, assignments, 7, log);
    assert.deepEqual(outcomes.map(outcome => outcome.status), ['routed', 'routed', 'failed']);
});
