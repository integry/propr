import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, getActiveRunCostGuard, runCostCapTerminalReason } from '@propr/core';
import type { RunCostSnapshot } from '@propr/core';
import { budgetExceededEvent, postCostCapNotice, withRunCostCap, type RunCostCapDeps, type RunCostCapTarget } from '../src/jobs/runCostCap.js';

after(async () => { await closeConnection(); });

const target: RunCostCapTarget = { taskId: 'task-cap', repoOwner: 'acme', repoName: 'app', number: 7, kind: 'issue', modelName: 'test-model' };

function harness(options: { recorded?: number; instanceDefault?: unknown } = {}) {
    const timeline: Array<ReturnType<typeof budgetExceededEvent>> = [];
    const stored: unknown[] = [];
    const deps: RunCostCapDeps = {
        loadInstanceDefault: async () => options.instanceDefault ?? 2,
        readRecordedSpend: async taskIds => { assert.ok(taskIds.includes('task-cap')); return options.recorded ?? 0; },
        storeCap: async (_taskId, cap) => { stored.push(cap); },
        recordExceeded: async (_target, snapshot) => { timeline.push(budgetExceededEvent(snapshot)); },
        // $1 per 1000 output tokens.
        priceUsage: async (_model, totals) => totals.outputTokens / 1000,
        checkIntervalMs: 60_000,
    };
    return { deps, timeline, stored };
}

const usageLine = (id: string, outputTokens: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: outputTokens } } });

test('a run past its cap is stopped once, records budget.exceeded and ends as cost_cap_exceeded', async () => {
    const { deps, timeline, stored } = harness({ recorded: 0.5 });
    const stops: string[] = [];
    let terminalReason: string | undefined;
    await withRunCostCap(target, async guard => {
        // Stands in for the Docker executor, which registers every agent container it starts.
        const execution = getActiveRunCostGuard()!.beginExecution(message => stops.push(message))!;
        execution.observeLine(usageLine('m1', 1000));
        await guard.check();
        assert.equal(stops.length, 0, '$0.50 recorded + $1.00 live is under the $2 cap');
        execution.observeLine(usageLine('m2', 800));
        await guard.check();
        await guard.check();
        execution.finish();
        terminalReason = runCostCapTerminalReason(target.taskId, 'completed');
    }, deps);

    assert.equal(stops.length, 1, 'the stop path is invoked once');
    assert.match(stops[0], /run spend cap of \$2\.00 exceeded/);
    assert.equal(terminalReason, 'cost_cap_exceeded');
    assert.deepEqual(stored, [{ capUsd: 2, source: 'instance_default' }]);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].metadata.event, 'budget.exceeded');
    assert.deepEqual(timeline[0].metadata.budget, { capUsd: 2, spentUsd: 2.3, priorSpentUsd: 0.5, percent: 115, source: 'instance_default' });
    assert.match(timeline[0].reason, /Spend cap reached: estimated \$2\.30 of \$2\.00 \(cap from instance default\)/);
});

test('the per-task override wins over the workflow and instance caps', async () => {
    const { deps, stored } = harness();
    await withRunCostCap({ ...target, override: 9, workflowCap: 4 }, async guard => {
        assert.deepEqual(guard.cap, { capUsd: 9, source: 'override' });
    }, deps);
    assert.deepEqual(stored, [{ capUsd: 9, source: 'override' }]);
});

test('a malformed instance default leaves runs uncapped instead of stopping them at $0', async () => {
    const { deps, timeline } = harness({ instanceDefault: 'ten dollars' });
    await withRunCostCap(target, async guard => {
        assert.equal(guard.cap, null);
        assert.equal(getActiveRunCostGuard()!.beginExecution(() => assert.fail('uncapped runs are never stopped')), null);
    }, deps);
    assert.equal(timeline.length, 0);
});

test('the GitHub notice names the cap, the spend and where the cap came from', async () => {
    const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
    const octokit = { request: async <T>(endpoint: string, options: Record<string, unknown>) => { requests.push({ endpoint, options }); return {} as T; } };
    const snapshot = { cap: { capUsd: 5, source: 'workflow' }, spentUsd: 5.123 } as Pick<RunCostSnapshot, 'cap' | 'spentUsd'>;
    await postCostCapNotice({ repoOwner: 'acme', repoName: 'app', number: 7 }, octokit, snapshot, { warn: () => undefined });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.issue_number, 7);
    const body = String(requests[0].options.body);
    assert.match(body, /Spend cap reached/);
    assert.match(body, /\$5\.12, reaching its \$5\.00 spend cap \(from \.propr\/workflow\.yml\)/);
    assert.ok(body.split('\n').length <= 5, 'the notice stays short');
});
