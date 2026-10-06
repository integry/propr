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
    // Further agent work in the stopped run is refused, not run uncapped.
    assert.throws(() => guard.beginExecution(() => assert.fail('a refused execution is never stopped')),
        { name: 'RunCostCapExceededError', message: stops[0] });
    guard.close();
});

test('an execution finishing while its usage is being priced is counted once', async () => {
    const exceeded: unknown[] = [];
    let releasePricing: () => void = () => undefined;
    let pricingStarted: () => void = () => undefined;
    const started = new Promise<void>(resolve => { pricingStarted = resolve; });
    let gate: Promise<void> | null = null;
    const guard = new RunCostGuard({
        taskId: 'task-1', inputs: { override: 10 }, defaultModel: 'test-model',
        readRecordedSpend: async () => 0,
        priceUsage: async (_model, totals) => {
            if (gate) { pricingStarted(); await gate; }
            return totals.outputTokens / 1000;
        },
        onExceeded: snapshot => exceeded.push(snapshot),
        checkIntervalMs: 60_000,
    });
    await guard.start();
    const execution = guard.beginExecution(() => assert.fail('$6 of $10 must not stop the run'))!;
    await guard.check();
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 6000 } } }));
    gate = new Promise<void>(resolve => { releasePricing = resolve; });
    const pending = guard.check();
    await started;
    // The container exits while the live tally is still being priced.
    const finished = execution.finish();
    gate = null;
    releasePricing();
    assert.equal(await pending, null);
    assert.equal(await finished, null);
    assert.equal(exceeded.length, 0);
    assert.equal(guard.exceeded, false);
    guard.close();
});

test('usage that crosses the cap just before the execution exits still ends it at the cap', async () => {
    const exceeded: Array<{ spentUsd: number }> = [];
    const guard = guardFor(() => 0, { override: 2 }, snapshot => exceeded.push(snapshot as { spentUsd: number }));
    await guard.start();
    const execution = guard.beginExecution(() => assert.fail('a finished execution is not stopped again'))!;
    assert.equal(await guard.check(), null);
    // No periodic check runs between this usage and the exit.
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 2500 } } }));
    const message = await execution.finish();
    assert.equal(message, runCostCapStopMessage({ capUsd: 2, source: 'override' }, 2.5));
    assert.equal(await execution.finish(), message, 'finishing twice reports the same outcome');
    assert.equal(guard.exceeded, true);
    assert.equal(exceeded.length, 1);
    assert.equal(exceeded[0].spentUsd, 2.5);
    guard.close();
});

test('analysis recorded during the run counts beside usage reported just before an execution exits', async () => {
    let recorded = 0;
    const exceeded: Array<{ spentUsd: number }> = [];
    const guard = guardFor(() => recorded, { override: 2 }, snapshot => exceeded.push(snapshot as { spentUsd: number }));
    await guard.start();
    const execution = guard.beginExecution(() => assert.fail('a finished execution is not stopped again'))!;
    // Task-attributed analysis is recorded after the guard started.
    recorded = 0.5;
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 300 } } }));
    assert.equal(await guard.check(), null, '$0.50 recorded + $0.30 live is under the $2 cap');
    // The last usage arrives right before the exit; its execution row is not written yet.
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'b', usage: { output_tokens: 1400 } } }));
    const message = await execution.finish();
    assert.equal(message, runCostCapStopMessage({ capUsd: 2, source: 'override' }, 2.2));
    assert.equal(exceeded.length, 1);
    assert.equal(exceeded[0].spentUsd, 0.5 + 1.7);
    guard.close();
});

test('a finished execution is not counted again once its row is recorded', async () => {
    let recorded = 0.5;
    const exceeded: Array<{ spentUsd: number }> = [];
    const guard = guardFor(() => recorded, { override: 3 }, snapshot => exceeded.push(snapshot as { spentUsd: number }));
    await guard.start();
    const execution = guard.beginExecution(() => undefined)!;
    execution.observeLine(JSON.stringify({ type: 'assistant', message: { id: 'a', usage: { output_tokens: 1700 } } }));
    assert.equal(await execution.finish(), null, '$0.50 recorded + $1.70 unrecorded is under the $3 cap');
    // The execution's own row is written after it returned.
    recorded = 0.5 + 1.7;
    const unchanged = await guard.check();
    assert.equal(unchanged, null, 'the recorded row replaces the observed usage instead of adding to it');
    // A later analysis call pushes the recorded spend past the cap.
    recorded = 0.5 + 1.7 + 0.9;
    const snapshot = await guard.check();
    assert.ok(snapshot);
    assert.equal(snapshot.spentUsd, 0.5 + 1.7 + 0.9);
    assert.equal(exceeded.length, 1);
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

test('a recorded row retires only one finished execution, so a failed insert still counts', async () => {
    let recorded = 0;
    const exceeded: Array<{ spentUsd: number }> = [];
    const guard = guardFor(() => recorded, { override: 2.5 }, snapshot => exceeded.push(snapshot as { spentUsd: number }));
    await guard.start();
    const usage = (id: string, outputTokens: number) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: outputTokens } } });
    const a = guard.beginExecution(() => undefined)!;
    const b = guard.beginExecution(() => undefined)!;
    a.observeLine(usage('a', 1000));
    b.observeLine(usage('b', 1000));
    // Both finish before either row is written; A's insert then fails.
    assert.equal(await a.finish(), null);
    assert.equal(await b.finish(), null, '$2 observed is under the $2.50 cap');
    recorded = 1;
    const afterInsert = await guard.check();
    assert.equal(afterInsert, null);
    const c = guard.beginExecution(() => undefined)!;
    c.observeLine(usage('c', 750));
    const message = await c.finish();
    assert.equal(message, runCostCapStopMessage({ capUsd: 2.5, source: 'override' }, 2.75));
    assert.equal(exceeded.length, 1);
    assert.equal(exceeded[0].spentUsd, 2.75);
    guard.close();
});

test('finished executions are matched to their own recorded session rows', async () => {
    let recorded: { totalUsd: number; bySessionUsd: Record<string, number> } = { totalUsd: 0, bySessionUsd: {} };
    const exceeded: Array<{ spentUsd: number }> = [];
    const guard = new RunCostGuard({
        taskId: 'task-1', inputs: { override: 2.5 }, defaultModel: 'test-model',
        readRecordedSpend: async () => recorded,
        priceUsage: async (_model, totals) => totals.outputTokens / 1000,
        onExceeded: snapshot => exceeded.push(snapshot as { spentUsd: number }),
        checkIntervalMs: 60_000,
    });
    await guard.start();
    const usage = (session: string, id: string, outputTokens: number) =>
        JSON.stringify({ type: 'assistant', session_id: session, message: { id, usage: { output_tokens: outputTokens } } });
    const a = guard.beginExecution(() => undefined)!;
    const b = guard.beginExecution(() => undefined)!;
    a.observeLine(usage('session-a', 'a', 1000));
    b.observeLine(usage('session-b', 'b', 1000));
    assert.equal(await a.finish(), null);
    assert.equal(await b.finish(), null);
    // A's insert failed and B's succeeded; B's row must not cover A.
    recorded = { totalUsd: 1, bySessionUsd: { 'session-b': 1 } };
    assert.equal(await guard.check(), null);
    // An analysis call without a session does not cover A either, since it follows B's row.
    recorded = { totalUsd: 1.2, bySessionUsd: { 'session-b': 1 } };
    const c = guard.beginExecution(() => undefined)!;
    c.observeLine(usage('session-c', 'c', 500));
    const message = await c.finish();
    assert.ok(message, '$1.20 recorded + $1 unrecorded A + $0.50 C reaches the $2.50 cap');
    assert.equal(exceeded.length, 1);
    assert.ok(Math.abs(exceeded[0].spentUsd - 2.7) < 1e-9, String(exceeded[0].spentUsd));
    guard.close();
});

test('usage tally keeps the session its execution is recorded under', () => {
    const claude = new RunUsageTally();
    claude.observeLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session' }));
    assert.equal(claude.sessionId, 'claude-session');
    const codex = new RunUsageTally();
    codex.observeLine(JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }));
    codex.observeLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
    assert.equal(codex.sessionId, 'codex-thread');
    const gemini = new RunUsageTally();
    gemini.observeLine(JSON.stringify({ event: 'init', conversation_id: 'gemini-conversation' }));
    assert.equal(gemini.sessionId, 'gemini-conversation');
});
