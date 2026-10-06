import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
    MAX_RUN_COST_CAP_USD, parseCostCapUsd, remainingRunBudget, resolveRunCostCap, runCostCapStopMessage,
} from '../src/budget/runCostCap.js';
import { RunUsageTally } from '../src/budget/runUsageTally.js';
import { RunCostGuard, runCostCapTerminalReason, runWithRunCostGuard } from '../src/budget/runCostGuard.js';
import { resolveAgentTerminationReason, taskTerminalReasonForAgentTermination } from '../src/agents/termination.js';
import { buildTaskStateTransition } from '../src/utils/workerStateTransition.js';
import type { TaskStateData } from '../src/utils/workerStateManager.types.js';
import { closeConnection } from '../src/db/connection.js';

// The pricing import chain opens the SQLite connection, which otherwise keeps the process alive.
after(async () => { await closeConnection(); });

test('cap precedence: task override, then workflow.yml, then the instance default', () => {
    assert.deepEqual(resolveRunCostCap({ override: 2, workflow: 5, instanceDefault: 10 }), { capUsd: 2, source: 'override' });
    assert.deepEqual(resolveRunCostCap({ workflow: 5, instanceDefault: 10 }), { capUsd: 5, source: 'workflow' });
    assert.deepEqual(resolveRunCostCap({ instanceDefault: 10 }), { capUsd: 10, source: 'instance_default' });
    assert.deepEqual(resolveRunCostCap({ instanceDefault: '7.5' }), { capUsd: 7.5, source: 'instance_default' });
    assert.equal(resolveRunCostCap({}), null);
    // Empty and 0 mean "no cap at this level"; the next level still applies.
    assert.equal(resolveRunCostCap({ instanceDefault: 0 }), null);
    assert.equal(resolveRunCostCap({ instanceDefault: '' }), null);
    assert.deepEqual(resolveRunCostCap({ override: 0, workflow: 3 }), { capUsd: 3, source: 'workflow' });
});

test('malformed or negative caps are treated as no cap, never as a $0 cap', () => {
    for (const value of [-1, -0.01, 'abc', '5usd', '1e3', Number.NaN, Number.POSITIVE_INFINITY, true, {}, []]) {
        assert.equal(parseCostCapUsd(value, 'test'), undefined, JSON.stringify(value));
        assert.equal(resolveRunCostCap({ override: value }), null, JSON.stringify(value));
    }
    // A typo at one level falls through to the next valid one.
    assert.deepEqual(resolveRunCostCap({ override: 'oops', workflow: -3, instanceDefault: 4 }), { capUsd: 4, source: 'instance_default' });
    assert.equal(parseCostCapUsd(MAX_RUN_COST_CAP_USD * 10, 'test'), MAX_RUN_COST_CAP_USD);
});

test('retries share the budget: the next attempt only gets what earlier attempts left', () => {
    assert.equal(remainingRunBudget(5, 0), 5);
    assert.equal(remainingRunBudget(5, 3.25), 1.75);
    assert.equal(remainingRunBudget(5, 5), 0);
    assert.equal(remainingRunBudget(5, 9), 0);
    assert.equal(remainingRunBudget(5, Number.NaN), 5);
});

test('usage tally counts streamed Claude messages once and Codex turns cumulatively', () => {
    const claude = new RunUsageTally();
    const message = (outputTokens: number) => JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: outputTokens, cache_read_input_tokens: 100 } } });
    claude.observeLine(message(5));
    claude.observeLine(message(20));
    claude.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'msg_2', usage: { input_tokens: 1, output_tokens: 2 } } }));
    claude.observeLine(JSON.stringify({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 999999, output_tokens: 999999 } }));
    claude.observeLine('not json usage');
    assert.equal(claude.model, 'claude-sonnet-4-5');
    assert.deepEqual(claude.totals, { inputTokens: 11, outputTokens: 22, cacheCreationTokens: 0, cacheReadTokens: 100 });
    assert.equal(claude.reportedCostUsd, 0.42);

    const codex = new RunUsageTally('gpt-5');
    for (let turn = 0; turn < 2; turn++) codex.observeLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } }));
    assert.deepEqual(codex.totals, { inputTokens: 1200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 800 });
});

function guardFor(recorded: () => number, cap: { override?: unknown; workflow?: unknown; instanceDefault?: unknown }, onExceeded: (snapshot: unknown) => void = () => undefined) {
    return new RunCostGuard({
        taskId: 'task-1',
        inputs: cap,
        defaultModel: 'test-model',
        readRecordedSpend: async () => recorded(),
        // $1 per 1000 output tokens keeps the arithmetic readable.
        priceUsage: async (_model, totals) => totals.outputTokens / 1000,
        onExceeded,
        checkIntervalMs: 60_000,
    });
}

test('crossing the cap stops every live execution once and reports the observed cost', async () => {
    let recorded = 1;
    const exceeded: unknown[] = [];
    const guard = guardFor(() => recorded, { workflow: 3 }, snapshot => exceeded.push(snapshot));
    const start = await guard.start();
    assert.deepEqual(start, { cap: { capUsd: 3, source: 'workflow' }, priorSpentUsd: 1, remainingUsd: 2 });

    const stops: string[] = [];
    const execution = guard.beginExecution(message => stops.push(message))!;
    assert.ok(execution);
    assert.equal(await guard.check(), null);
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 1500 } } }));
    assert.equal(await guard.check(), null, '$1 recorded + $1.50 live is under the $3 cap');
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'b', usage: { output_tokens: 600 } } }));
    const snapshot = await guard.check();
    assert.ok(snapshot);
    assert.equal(snapshot.spentUsd, 1 + 2.1);
    assert.equal(stops.length, 1);
    assert.equal(stops[0], runCostCapStopMessage({ capUsd: 3, source: 'workflow' }, 3.1));
    assert.match(stops[0], /run spend cap of \$3\.00 exceeded/);

    recorded = 50;
    assert.equal(await guard.check(), null);
    assert.equal(stops.length, 1, 'the stop path runs once');
    assert.equal(exceeded.length, 1);
    assert.equal(guard.exceeded, true);
    // Executions that publish partial work afterwards are not stopped again.
    assert.equal(guard.beginExecution(() => assert.fail('must not stop publication')), null);
    guard.close();
});

test('a retry whose earlier attempts used the whole budget stops as soon as it starts', async () => {
    const stops: string[] = [];
    const guard = guardFor(() => 5, { override: 5 });
    await guard.start();
    guard.beginExecution(message => stops.push(message));
    await guard.check();
    assert.equal(stops.length, 1);
    guard.close();
});

test('the workflow cap applies once known, unless a task override already wins', async () => {
    const guard = guardFor(() => 0, { instanceDefault: 10 });
    await guard.start();
    await guard.setWorkflowCap(4);
    assert.deepEqual(guard.cap, { capUsd: 4, source: 'workflow' });
    await guard.setWorkflowCap('typo');
    assert.deepEqual(guard.cap, { capUsd: 10, source: 'instance_default' });

    const overridden = guardFor(() => 0, { override: 1, instanceDefault: 10 });
    await overridden.setWorkflowCap(4);
    assert.deepEqual(overridden.cap, { capUsd: 1, source: 'override' });

    const uncapped = guardFor(() => 0, {});
    assert.equal(uncapped.beginExecution(() => undefined), null, 'an uncapped run is not tracked');
});

test('a run stopped at its cap ends with the cost_cap_exceeded terminal reason', async () => {
    const guard = guardFor(() => 0, { override: 1 });
    await guard.start();
    const stops: string[] = [];
    const execution = guard.beginExecution(message => stops.push(message))!;
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 2000 } } }));
    const current: TaskStateData = {
        taskId: 'task-1', issueRef: { number: 1, repoOwner: 'o', repoName: 'r' }, correlationId: 'c', state: 'claude_execution',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', attempts: 0, history: [],
    };
    await runWithRunCostGuard(guard, async () => {
        assert.equal(runCostCapTerminalReason('task-1', 'failed'), undefined, 'not before the cap is reached');
        await guard.check();
        assert.equal(stops.length, 1);
        assert.equal(runCostCapTerminalReason('task-1', 'completed'), 'cost_cap_exceeded');
        assert.equal(runCostCapTerminalReason('task-1', 'cancelled'), undefined);
        assert.equal(runCostCapTerminalReason('other-task', 'failed'), undefined);
        const failed = buildTaskStateTransition(current, 'failed', { reason: 'Agent processing failed' });
        assert.equal(failed.state.terminalReason, 'cost_cap_exceeded');
        assert.equal(failed.state.history.at(-1)?.metadata?.terminalReason, 'cost_cap_exceeded');
        // An explicit reason from the caller still wins.
        assert.equal(buildTaskStateTransition(current, 'failed', { terminalReason: 'timed_out' }).state.terminalReason, 'timed_out');
    });
    assert.equal(runCostCapTerminalReason('task-1', 'failed'), undefined, 'outside the run there is no active cap');
    guard.close();
});

test('agents report a spend-cap stop as a partial cost_cap termination', () => {
    assert.equal(resolveAgentTerminationReason({ costCapExceeded: true }), 'cost_cap');
    const stderr = `some output\n${runCostCapStopMessage({ capUsd: 2, source: 'override' }, 2.5)}`;
    assert.equal(resolveAgentTerminationReason({ error: stderr }), 'cost_cap');
    assert.equal(taskTerminalReasonForAgentTermination('cost_cap'), 'cost_cap_exceeded');
    assert.equal(taskTerminalReasonForAgentTermination('timeout'), 'timed_out');
    assert.equal(taskTerminalReasonForAgentTermination('max_turns'), undefined);
});
