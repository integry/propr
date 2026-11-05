import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopStalledAttemptContainers } from '../packages/core/src/claude/docker/stalledAttemptContainers.js';
import { resolveMaxStalledCount } from '../packages/core/src/queue/stallPolicy.js';

const correlationId = '5bc82654-715c-49e8-8169-235e4abeb218';
const listing = [
    `a9ef80c4edc9\tclaude-issue-3191-4abeb218-28c2ebb9\tintegry-propr-3191-claude-claude-fable-5-${correlationId}`,
    'b1\tclaude-issue-3192-6ed74109-4e2eec96\tintegry-propr-3192-claude-claude-opus-5-5-c122344c-43f8-4b02-9a58-e6776ed74109',
    'c1\tclaude-pr-255\t27709',
    'd1\tclaude-pr-2556\t277090',
].join('\n');

function harness(stdout = listing, exitCode = 0) {
    const commands: string[][] = [];
    const stopped: string[] = [];
    const list = async (args: string[]) => {
        commands.push(args);
        if (exitCode) throw new Error('daemon unavailable');
        return stdout;
    };
    const stop = (async (id: string) => { stopped.push(id); return { success: true }; }) as never;
    return { commands, stopped, deps: { list, stop } };
}

test('stops only the running containers of the redelivered issue job', async () => {
    const h = harness();
    const result = await stopStalledAttemptContainers({ jobId: 'issue-integry-propr-3191-claude-claude-fable-5-main', correlationId }, h.deps);
    assert.deepEqual(h.stopped, ['a9ef80c4edc9']);
    assert.deepEqual(result, [{ id: 'a9ef80c4edc9', name: 'claude-issue-3191-4abeb218-28c2ebb9' }]);
    assert.deepEqual(h.commands[0].slice(0, 3), ['ps', '--filter', 'label=propr.task.id'], 'only running, task-labelled containers are listed');
});

test('matches a queue-job task ID exactly, never by prefix', async () => {
    const h = harness();
    await stopStalledAttemptContainers({ jobId: '27709' }, h.deps);
    assert.deepEqual(h.stopped, ['c1']);
});

test('leaves a follow-up comment job\'s agent alone for its handoff recovery to adopt', async () => {
    const h = harness();
    assert.deepEqual(await stopStalledAttemptContainers({ jobId: '27709', jobName: 'processPullRequestComment' }, h.deps), []);
    assert.deepEqual(h.commands, [], 'the reaper never even lists containers for a follow-up job');
    assert.deepEqual(h.stopped, []);
});

test('stops nothing without an identity, for a short correlation ID, or when Docker fails', async () => {
    for (const job of [{}, { correlationId: '3191' }]) {
        const h = harness();
        assert.deepEqual(await stopStalledAttemptContainers(job, h.deps), []);
        assert.deepEqual(h.stopped, []);
    }
    const failing = harness('', 1);
    assert.deepEqual(await stopStalledAttemptContainers({ jobId: '27709' }, failing.deps), []);
});

test('allows several worker restarts before a stalled job fails', () => {
    assert.equal(resolveMaxStalledCount({}), 3);
    assert.equal(resolveMaxStalledCount({ WORKER_MAX_STALLED_COUNT: '5' }), 5);
    assert.equal(resolveMaxStalledCount({ WORKER_MAX_STALLED_COUNT: 'x' }), 3);
});
