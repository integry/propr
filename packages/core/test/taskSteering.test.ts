import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { TASK_STEER_MAX_PER_RUN } from '@propr/shared';
import { up as createTaskSteers } from '../src/db/migrations/20261006000000_create_task_steers.js';
import { executeDockerCommand } from '../src/claude/docker/dockerExecutor.js';
import { startLiveInput, type LiveInputMessage, type LiveInputSource } from '../src/claude/docker/dockerLiveInput.js';
import { encodeClaudeUserMessage, isClaudeResultRecord } from '../src/agents/impl/utils/claudeStreamInput.js';
import {
    TaskSteerLimitError,
    claimTaskSteers,
    createTaskSteer,
    createTaskSteeringSource,
    formatReplacementRunSteers,
    formatTaskSteersForComment,
    TASK_STEER_COMMENT_MAX_LENGTH,
    listTaskSteers,
    markTaskSteersHandedOff,
} from '../src/services/taskSteeringStore.js';

let db: Knex;

beforeEach(async () => {
    db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('tasks', table => { table.string('task_id', 255).primary(); });
    await db.schema.createTable('task_history', table => {
        table.increments('history_id').primary();
        table.string('task_id', 255).notNullable();
        table.string('state', 50).notNullable();
        table.timestamp('timestamp').notNullable();
        table.text('reason');
        table.json('metadata');
    });
    await db('tasks').insert({ task_id: 'task-1' });
    await createTaskSteers(db);
});

afterEach(async () => {
    await db.destroy();
});

function steer(message: string, runKey: string | null = 'run-1') {
    return createTaskSteer(db, { taskId: 'task-1', runKey, author: 'octocat', authorSource: 'session', message });
}

describe('task steer persistence', () => {
    test('enforces the per-run limit without counting other runs', async () => {
        for (let index = 0; index < TASK_STEER_MAX_PER_RUN; index += 1) await steer(`message ${index}`);
        await assert.rejects(steer('one too many'), TaskSteerLimitError);
        // A replacement run has its own budget.
        await steer('next run', 'run-2');
        assert.equal((await listTaskSteers(db, 'task-1')).length, TASK_STEER_MAX_PER_RUN + 1);
    });

    test('claims each steer at most once, even for concurrent claims', async () => {
        await steer('first');
        await steer('second');
        const [left, right] = await Promise.all([
            claimTaskSteers(db, 'task-1', 'live'),
            claimTaskSteers(db, 'task-1', 'live'),
        ]);
        const claimed = [...left, ...right].map(item => item.message).sort();
        assert.deepEqual(claimed, ['first', 'second']);
        assert.deepEqual(await claimTaskSteers(db, 'task-1', 'live'), []);
    });

    test('carries only undelivered steers into a replacement run after a restart', async () => {
        await steer('delivered live');
        const source = createTaskSteeringSource(db, 'task-1');
        const [live] = await source.claim();
        await source.acknowledge(live!.id);
        await steer('claimed but never written');
        const [unwritten] = await source.claim();
        await source.release([unwritten!.id]);
        await steer('arrived as the container died');

        // Simulated restart: the replacement run claims what is still pending.
        const replacement = await claimTaskSteers(db, 'task-1', 'replacement_prompt');
        assert.deepEqual(replacement.map(item => item.message), ['claimed but never written', 'arrived as the container died']);
        assert.match(formatReplacementRunSteers(replacement), /arrived as the container died/);
        // Its agent process started with that prompt: a second restart delivers nothing again.
        await markTaskSteersHandedOff(db, replacement.map(item => item.id));
        assert.deepEqual(await claimTaskSteers(db, 'task-1', 'replacement_prompt'), []);

        const timeline = await db('task_history').orderBy('history_id');
        assert.deepEqual(timeline.map(row => [row.state, JSON.parse(row.metadata).taskSteer.message]), [['processing', 'delivered live']]);
        assert.match(timeline[0].reason, /Operator input from octocat delivered to the running agent/);

        const all = await listTaskSteers(db, 'task-1');
        assert.deepEqual(all.map(item => item.delivery), ['live', 'replacement_prompt', 'replacement_prompt']);
        assert.ok(all[0]!.acknowledgedAt);
        const comment = formatTaskSteersForComment(all);
        assert.match(comment, /### Operator input during the run/);
        assert.match(comment, /delivered live/);
        assert.match(comment, /delivered in the replacement run prompt/);
    });

    test('a replacement claim abandoned before its prompt reached an agent is reclaimed by the next run', async () => {
        await steer('keep the public API unchanged');
        // The claiming worker dies during preparation: nothing releases the claim.
        const [abandoned] = await claimTaskSteers(db, 'task-1', 'replacement_prompt');
        assert.equal(abandoned!.message, 'keep the public API unchanged');
        // It is still pending to every reader, but no live claim can take it twice.
        const [listed] = await listTaskSteers(db, 'task-1');
        assert.equal(listed!.deliveredAt, null);
        assert.equal(listed!.delivery, null);
        assert.match(formatTaskSteersForComment([listed!]), /not delivered/);
        assert.deepEqual(await claimTaskSteers(db, 'task-1', 'live'), []);

        const [recovered] = await claimTaskSteers(db, 'task-1', 'replacement_prompt');
        assert.equal(recovered!.id, abandoned!.id);
        await markTaskSteersHandedOff(db, [recovered!.id]);
        const [handedOff] = await listTaskSteers(db, 'task-1');
        assert.equal(handedOff!.delivery, 'replacement_prompt');
        assert.ok(handedOff!.deliveredAt);
        // Once an agent process may have received it, it is never replayed.
        assert.deepEqual(await claimTaskSteers(db, 'task-1', 'replacement_prompt'), []);
    });

    test('released steers that were acknowledged stay delivered', async () => {
        await steer('written');
        const source = createTaskSteeringSource(db, 'task-1');
        const [written] = await source.claim();
        await source.acknowledge(written!.id);
        await source.release([written!.id]);
        assert.deepEqual(await claimTaskSteers(db, 'task-1', 'replacement_prompt'), []);
    });
});

describe('task steering in completion comments', () => {
    function steerRecord(index: number, message: string) {
        return {
            id: `steer-${index}`, sequence: index, taskId: 'task-1', runKey: 'run-1', author: 'octocat',
            authorSource: 'session' as const, message, createdAt: '2026-10-06T00:00:00.000Z',
            deliveredAt: '2026-10-06T00:00:01.000Z', delivery: 'live' as const, acknowledgedAt: '2026-10-06T00:00:01.000Z',
        };
    }

    test('bounds the section even when every message is at the accepted limits', () => {
        // Two full runs: 40 messages of 4,000 characters, far over GitHub's 65,536-character comment limit.
        const steers = Array.from({ length: 40 }, (_, index) => steerRecord(index, `${index}:${'x'.repeat(3_996)}`));
        const section = formatTaskSteersForComment(steers, { taskUrl: 'https://propr.example/tasks/task-1' });
        assert.ok(section.length <= TASK_STEER_COMMENT_MAX_LENGTH, `section is ${section.length} characters`);
        assert.match(section, /^### Operator input during the run/);
        assert.match(section, /- \*\*octocat\*\* \(delivered live\):\n> 0:x/);
        assert.match(section, /more messages were omitted; long messages were shortened/);
        assert.match(section, /\[task history\]\(https:\/\/propr\.example\/tasks\/task-1\)/);
    });

    test('respects a caller budget and keeps short sections intact', () => {
        const steers = Array.from({ length: 5 }, (_, index) => steerRecord(index, `message ${index}`));
        assert.doesNotMatch(formatTaskSteersForComment(steers), /omitted|shortened/);
        const bounded = formatTaskSteersForComment(steers, { maxLength: 250 });
        assert.ok(bounded.length <= 250);
        assert.match(bounded, /message 0/);
        assert.match(bounded, /more messages? (was|were) omitted/);
        assert.match(bounded, /See the task history/);
    });
});

/**
 * A fake stream-json agent: echoes every user message it reads as an
 * assistant record, ends its run with a `result` after the second message,
 * and exits only once its stdin closes, like `claude -p --input-format stream-json`.
 */
const FAKE_LIVE_AGENT = `
const readline = require('node:readline');
let received = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  received += 1;
  console.log(JSON.stringify({ type: 'assistant', text: message.message.content }));
  if (received === 2) console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
}).on('close', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'stdin_closed', received }));
});
`;

class QueueSource implements LiveInputSource {
    pending: LiveInputMessage[] = [];
    claimed: string[] = [];
    acknowledged: string[] = [];
    released: string[] = [];
    async claim(): Promise<LiveInputMessage[]> {
        const messages = this.pending.splice(0);
        this.claimed.push(...messages.map(message => message.id));
        return messages;
    }
    async acknowledge(id: string): Promise<void> { this.acknowledged.push(id); }
    async release(ids: string[]): Promise<void> { this.released.push(...ids); }
}

describe('live steering delivery', () => {
    test('writes a steer into the running agent and closes input at its result', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Use the existing helper instead.' });
        const result = await executeDockerCommand(process.execPath, ['-e', FAKE_LIVE_AGENT], {
            timeout: 10_000,
            liveInput: {
                initialInput: encodeClaudeUserMessage('Implement the issue.'),
                source,
                encode: encodeClaudeUserMessage,
                endsInput: isClaudeResultRecord,
                pollIntervalMs: 10,
            },
        });
        const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
        assert.deepEqual(records.filter(record => record.type === 'assistant').map(record => record.text), [
            'Implement the issue.',
            'Use the existing helper instead.',
        ]);
        assert.deepEqual(records.at(-1), { type: 'system', subtype: 'stdin_closed', received: 2 });
        assert.deepEqual(source.claimed, ['steer-1']);
        assert.deepEqual(source.acknowledged, ['steer-1']);
        assert.equal(result.exitCode, 0);
    });

    test('does not claim steers once the run has ended', async () => {
        const source = new QueueSource();
        const agent = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success' }));
}).on('close', () => setTimeout(() => process.exit(0), 100));
`;
        const run = executeDockerCommand(process.execPath, ['-e', agent], {
            timeout: 10_000,
            liveInput: {
                initialInput: encodeClaudeUserMessage('Implement the issue.'),
                source,
                encode: encodeClaudeUserMessage,
                endsInput: isClaudeResultRecord,
                pollIntervalMs: 10,
            },
        });
        // Arrives after the result closed the input; it must stay pending for a later run.
        await new Promise(resolve => setTimeout(resolve, 50));
        source.pending.push({ id: 'late', text: 'Too late' });
        await run;
        assert.deepEqual(source.claimed, []);
        assert.equal(source.pending.length, 1);
    });

    test('stops polling when the agent input fails, and close stays safe afterwards', async () => {
        const source = new QueueSource();
        const stdin = new Writable({
            write(_chunk, _encoding, callback) { callback(new Error('EPIPE: the agent closed its input')); },
        });
        const cleared: unknown[] = [];
        const realClearInterval = globalThis.clearInterval;
        const clearSpy = mock.method(globalThis, 'clearInterval', (timer: Parameters<typeof clearInterval>[0]) => {
            cleared.push(timer);
            realClearInterval(timer);
        });
        let timer: unknown;
        const realSetInterval = globalThis.setInterval;
        const setSpy = mock.method(globalThis, 'setInterval', ((callback: () => void, ms: number) => {
            timer = realSetInterval(callback, ms);
            return timer;
        }) as typeof setInterval);
        try {
            const channel = startLiveInput(stdin, {
                initialInput: encodeClaudeUserMessage('Implement the issue.'),
                source,
                encode: encodeClaudeUserMessage,
                endsInput: isClaudeResultRecord,
                pollIntervalMs: 10,
            }, { taskId: 'task-1' });
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(timer, 'polling started');
            assert.deepEqual(cleared, [timer], 'the stdin error cancels polling');
            // The executor still closes the channel when the process exits.
            channel.close();
            channel.close();
            await channel.settled();
            source.pending.push({ id: 'steer-1', text: 'Never claimed' });
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.deepEqual(source.claimed, []);
        } finally {
            setSpy.mock.restore();
            clearSpy.mock.restore();
        }
    });

    test('reports the prompt handoff once the agent process started', async () => {
        let handoffs = 0;
        const result = await executeDockerCommand(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], {
            timeout: 10_000,
            stdinData: 'Implement the issue.',
            onPromptHandoff: () => { handoffs += 1; },
        });
        assert.equal(result.exitCode, 0);
        assert.equal(handoffs, 1);
    });

    test('does not report a prompt handoff when the agent process fails to start', async () => {
        let handoffs = 0;
        await assert.rejects(executeDockerCommand('/nonexistent/propr-agent-binary', [], {
            timeout: 10_000,
            stdinData: 'Implement the issue.',
            onPromptHandoff: () => { handoffs += 1; },
        }), /ENOENT/);
        assert.equal(handoffs, 0);
    });
});
