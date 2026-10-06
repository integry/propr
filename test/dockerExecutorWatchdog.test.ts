import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Redis as RedisClient } from 'ioredis';

class FakeRedis {
    status = 'ready';
    on() { return this; }
    async eval(_script: string, _keys: number, _data: string, _meta: string, text: string) { return text.length; }
    async get() { return null; }
    async quit() { return 'OK'; }
    disconnect() {}
}
mock.module('ioredis', { namedExports: { Redis: FakeRedis, default: FakeRedis } });
const { executeDockerCommand } = await import('../packages/core/src/claude/docker/dockerExecutor.js');
const { startExecutionWatchdog } = await import('../packages/core/src/claude/docker/dockerExecutionWatchdog.js');
const { ACQUIRE_WORKFLOW_SLOT, RELEASE_WORKFLOW_SLOT, releaseRepositoryWorkflowSlot, withRepositoryWorkflowSlot } = await import('../packages/core/src/workflow/workflowConcurrency.js');
const { resolveAgentTerminationReason } = await import('../packages/core/src/agents/termination.js');
const { taskTerminalReasonForAgentTermination } = await import('../src/jobs/agentTerminalReason.js');
type AgentWatchdogTrip = import('../packages/core/src/claude/docker/agentActivityWatchdog.js').AgentWatchdogTrip;

const FAST = { stallTimeoutMs: 300, toolStallTimeoutMs: 1_500, degenerateOutputLimit: 5 };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A streamed agent run whose process prints `script` output, then stays alive.
 * Output records are passed as process arguments (`process.argv[1..]`), never spliced into the script source.
 */
function runAgent(script: string, options: Record<string, unknown> = {}, data: string[] = []) {
    const trips: Array<{ taskId: string; trip: AgentWatchdogTrip }> = [];
    const execution = executeDockerCommand(process.execPath, ['-e', `${script}; setTimeout(() => {}, 60_000);`, ...data], {
        taskId: 'watchdog-task', streamToRedis: true, preserveOutputOnTimeout: true, timeout: 30_000,
        watchdog: FAST, onWatchdogTrip: (taskId: string, trip: AgentWatchdogTrip) => { trips.push({ taskId, trip }); },
        ...options,
    });
    return { execution, trips };
}

test('a silent agent is stopped with partial output and a stalled termination', async () => {
    const startedAt = Date.now();
    const record = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the code' }] } });
    const { execution, trips } = runAgent('process.stdout.write(process.argv[1])', {}, [`${record}\n`]);
    const result = await execution;
    assert.ok(Date.now() - startedAt < 10_000, 'the watchdog stops the run long before the deadline');
    assert.equal(result.timedOut, undefined);
    assert.equal(result.watchdogTrip?.rule, 'inactivity');
    assert.match(result.stdout, /Reading the code/, 'partial work is preserved like a timed-out run');
    assert.match(result.stderr, /Agent watchdog stopped the run \(stalled\)/);
    assert.equal(resolveAgentTerminationReason({ watchdogTrip: result.watchdogTrip, error: result.stderr }), 'stalled');
    assert.equal(trips.length, 1, 'the trip is reported once');
    assert.equal(trips[0].taskId, 'watchdog-task');
});

test('output keeps a long-running agent alive; only true silence counts', async () => {
    const { execution, trips } = runAgent(`
        let count = 0;
        const timer = setInterval(() => {
            process.stderr.write('npm test: still running\\n');
            if (++count === 8) { clearInterval(timer); process.exit(0); }
        }, 100);`);
    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.equal(result.watchdogTrip, undefined);
    assert.equal(trips.length, 0);
});

test('a silent tool call gets the longer tool threshold', async () => {
    const tool = JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'npm ci' } });
    const done = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } });
    const { execution, trips } = runAgent(`
        process.stdout.write(process.argv[1]);
        setTimeout(() => { process.stdout.write(process.argv[2]); process.exit(0); }, 800);`, {}, [`${tool}\n`, `${done}\n`]);
    const result = await execution;
    assert.equal(result.exitCode, 0, '800ms of silence is past the stall threshold but within the tool threshold');
    assert.equal(trips.length, 0);
});

test('consecutive whitespace-only deltas stop the run as degenerate output', async () => {
    const delta = (text: string) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
    const lines = [delta(''), delta('ok'), ...Array.from({ length: 5 }, () => delta(' \n'))].join('\n');
    const { execution, trips } = runAgent('setInterval(() => process.stdout.write(process.argv[1]), 20)', {}, [`${lines}\n`]);
    const result = await execution;
    assert.equal(result.watchdogTrip?.rule, 'degenerate_output');
    assert.equal(result.watchdogTrip?.degenerateDeltas, 5);
    assert.equal(resolveAgentTerminationReason({ watchdogTrip: result.watchdogTrip }), 'degenerate_output');
    assert.equal(trips.length, 1);
});

test('a disabled watchdog never stops a run', async () => {
    const { execution, trips } = runAgent('setTimeout(() => process.exit(0), 700)', {
        watchdog: { stallTimeoutMs: 0, toolStallTimeoutMs: 0, degenerateOutputLimit: 0 },
    });
    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.equal(trips.length, 0);
});

test('plain commands do not run the watchdog by default', async () => {
    const result = await executeDockerCommand(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 400)'], { taskId: 'plain', timeout: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.watchdogTrip, undefined);
});

test('the stop path is called exactly once and not after another stop began', async () => {
    let stops = 0;
    const tripped = startExecutionWatchdog({ watchdog: FAST, taskId: 'once', onWatchdogTrip: () => undefined }, () => { stops += 1; return true; });
    await wait(1_000);
    tripped.recordActivity();
    tripped.observeLine(JSON.stringify({ msg: { type: 'agent_message_delta', delta: ' ' } }));
    await wait(500);
    assert.equal(stops, 1);
    assert.equal(tripped.trip?.rule, 'inactivity');
    tripped.stop();

    // A run the deadline or a user is already stopping keeps that outcome.
    const reports: unknown[] = [];
    const refused = startExecutionWatchdog({ watchdog: FAST, taskId: 'refused', onWatchdogTrip: trip => { reports.push(trip); } }, () => false);
    await wait(700);
    assert.equal(refused.trip, null);
    assert.equal(reports.length, 0);
    refused.stop();
});

test('a watchdog stop releases the repository capacity lease', async () => {
    const calls: string[] = [];
    const redis = {
        eval: async (script: string) => {
            if (script === ACQUIRE_WORKFLOW_SLOT) { calls.push('acquire'); return 1; }
            if (script === RELEASE_WORKFLOW_SLOT) { calls.push('release'); return []; }
            calls.push('other');
            return 1;
        },
    } as unknown as RedisClient;
    const result = await withRepositoryWorkflowSlot({
        redis, repository: 'integry/propr', limit: 1, checkCancelled: async () => {}, onLeaseError: error => { throw error; },
    }, async () => {
        const { execution } = runAgent('process.stdout.write("started\\n")');
        const outcome = await execution;
        // As runRepositoryWorkflow does once the agent container has exited.
        await releaseRepositoryWorkflowSlot();
        return outcome;
    });
    assert.equal(result.watchdogTrip?.terminationReason, 'stalled');
    assert.deepEqual(calls, ['acquire', 'release'], 'capacity is released exactly once after the watchdog stop');
});

test('watchdog terminations finish the task with their own terminal reason', () => {
    assert.equal(taskTerminalReasonForAgentTermination('stalled'), 'stalled');
    assert.equal(taskTerminalReasonForAgentTermination('degenerate_output'), 'degenerate_output');
    assert.equal(taskTerminalReasonForAgentTermination('timeout'), 'timed_out');
    assert.equal(taskTerminalReasonForAgentTermination('max_turns'), undefined);
});
