import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { AGENT_TASK_STEERING } from '@propr/shared';
import { closeConnection } from '../src/db/connection.js';
import { executeDockerCommand } from '../src/claude/docker/dockerExecutor.js';
import type { LiveInputMessage, LiveInputSource } from '../src/claude/docker/dockerLiveInput.js';
import type { PromptHandoff } from '../src/claude/docker/dockerPromptHandoff.js';
import { CodexAppServerTaskSession } from '../src/agents/impl/codexAppServerTask.js';
import { buildCodexAppServerTaskDockerArgs } from '../src/agents/impl/utils/codexDockerArgsBuilder.js';
import { parseCodexStreamOutput } from '../src/codex/codexHelpers.js';
import {
    ANTIGRAVITY_INVOCATION_EXIT_EVENT,
    AntigravityTaskSteeringSession,
    buildAntigravitySteerableShellCommand,
    parseAntigravityTaskOutput,
} from '../src/agents/impl/antigravityTaskSteering.js';

// The Codex argument builder loads configuration through the database.
after(async () => { await closeConnection(); });

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

test('Codex and Antigravity task runs advertise the input mechanisms their goals use', () => {
    assert.equal(AGENT_TASK_STEERING.codex, 'live');
    assert.equal(AGENT_TASK_STEERING.antigravity, 'next-step');
});

/** A Codex App Server that runs one turn and finishes it with the text of a steer it accepted. */
const FAKE_CODEX_APP_SERVER = `
const readline = require('node:readline');
const mode = process.env.FAKE_CODEX_MODE || 'accept';
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
const thread = 'thread-1';
const turn = 'turn-1';
const finish = text => {
  send({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test', aggregatedOutput: 'ok', exitCode: 0, status: 'completed' } } });
  send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg-1', text } } });
  send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningOutputTokens: 5 } } } });
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  process.stderr.write(JSON.stringify({ method: message.method, params: message.params }) + '\\n');
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start' && mode === 'thread-fail') { send({ id: message.id, error: { code: -32603, message: 'not logged in' } }); }
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: thread, model: message.params.model } } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turn, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } });
    send({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'cmd-1', command: 'npm test' } } });
    if (mode === 'crash') setTimeout(() => process.exit(0), 50);
  } else if (message.method === 'turn/steer') {
    if (mode === 'reject') {
      send({ id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
      finish('Finished without the steer');
    } else {
      send({ id: message.id, result: { turnId: turn } });
      finish('Steered: ' + message.params.input[0].text);
    }
  }
}).on('close', () => process.exit(0));
`;

function requests(stderr: string): Array<{ method: string; params: Record<string, unknown> }> {
    return stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

/** Records how a prompt carrying earlier operator input was settled. */
class HandoffSpy implements PromptHandoff {
    received_ = 0;
    notReceived_ = 0;
    async beforeStart(): Promise<void> {}
    received(): void { this.received_ += 1; }
    notReceived(): void { this.notReceived_ += 1; }
}

async function runCodex(source: QueueSource, mode: 'accept' | 'reject' | 'crash' | 'thread-fail', promptHandoff = new HandoffSpy()) {
    const session = new CodexAppServerTaskSession({ prompt: 'Implement the issue.', model: 'gpt-test', source, pollIntervalMs: 10 });
    const previous = process.env.FAKE_CODEX_MODE;
    process.env.FAKE_CODEX_MODE = mode;
    try {
        const result = await executeDockerCommand(process.execPath, ['-e', FAKE_CODEX_APP_SERVER], { timeout: 10_000, liveInput: session, promptHandoff });
        return { result, session, promptHandoff, parsed: parseCodexStreamOutput(result.stdout) };
    } finally {
        if (previous === undefined) delete process.env.FAKE_CODEX_MODE;
        else process.env.FAKE_CODEX_MODE = previous;
    }
}

describe('Codex task steering through App Server', () => {
    test('delivers a steer into the active turn and reports the run as codex exec records', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Use the existing helper instead.' });
        const { result, session, parsed, promptHandoff } = await runCodex(source, 'accept');
        assert.equal(promptHandoff.received_, 1, 'the started turn shows the agent received its prompt');

        const sent = requests(result.stderr);
        assert.deepEqual(sent.map(request => request.method), ['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/steer']);
        assert.equal(sent[2]!.params.model, 'gpt-test');
        assert.equal(sent[2]!.params.ephemeral, true);
        assert.deepEqual(sent[3]!.params.input, [{ type: 'text', text: 'Implement the issue.', text_elements: [] }]);
        assert.equal(sent[4]!.params.expectedTurnId, 'turn-1');
        assert.equal(sent[4]!.params.clientUserMessageId, 'steer-1');
        assert.deepEqual(source.acknowledged, ['steer-1']);
        assert.deepEqual(source.released, []);

        assert.equal(session.completed, true);
        assert.equal(result.exitCode, 0);
        assert.equal(parsed.success, true);
        assert.equal(parsed.sessionId, 'thread-1');
        assert.equal(parsed.model, 'gpt-test');
        assert.equal(parsed.result, 'Steered: Use the existing helper instead.');
        assert.deepEqual(parsed.tokenUsage, { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40, reasoning_output_tokens: 5 });
        assert.match(parsed.logs, /\[Command\] npm test/);
        // Only exec records reach the run output: no JSON-RPC traffic.
        for (const line of result.stdout.trim().split('\n')) {
            assert.equal(typeof (JSON.parse(line) as { type?: unknown }).type, 'string', line);
        }
    });

    test('returns a steer the App Server rejected to the pending queue', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Too late for this turn' });
        const { session, parsed } = await runCodex(source, 'reject');
        assert.deepEqual(source.claimed, ['steer-1']);
        assert.deepEqual(source.acknowledged, []);
        assert.deepEqual(source.released, ['steer-1']);
        assert.equal(session.completed, true);
        assert.equal(parsed.success, true);
    });

    test('the App Server handshake alone does not count as the agent receiving its prompt', async () => {
        const { result, promptHandoff, parsed } = await runCodex(new QueueSource(), 'thread-fail');
        assert.ok(result.stdout.length > 0);
        assert.equal(promptHandoff.received_, 0);
        assert.equal(parsed.success, false);
        assert.match(parsed.error ?? '', /could not start the task thread: not logged in/);
    });

    test('a run whose App Server exits before the turn completes fails', async () => {
        const { session, parsed } = await runCodex(new QueueSource(), 'crash');
        assert.equal(session.completed, false);
        assert.equal(parsed.success, false);
        assert.match(parsed.error ?? '', /exited before the task turn completed/);
    });

    test('a steerable container serves App Server with the task configuration overrides', () => {
        const configPath = mkdtempSync(path.join(tmpdir(), 'propr-codex-config-'));
        try {
            const args = buildCodexAppServerTaskDockerArgs(
                { alias: 'codex-default', type: 'codex', dockerImage: 'codex-image', configPath } as Parameters<typeof buildCodexAppServerTaskDockerArgs>[0],
                { worktreePath: '/tmp/worktree', githubToken: 'token', issueNumber: 7, reasoningLevel: 'high', modelName: 'gpt-test' },
            );
            const codex = args.lastIndexOf('codex');
            const cli = args.slice(codex);
            assert.equal(cli.at(-1), 'app-server');
            assert.equal(cli.includes('exec'), false);
            assert.equal(cli.includes('--model'), false, 'the model is chosen when the thread starts');
            assert.ok(cli.includes('model_reasoning_effort="high"'));
            assert.ok(cli.includes('features.multi_agent=false'));
        } finally {
            rmSync(configPath, { recursive: true, force: true });
        }
    });
});

/**
 * A stand-in `agy --print`: reports its conversation, runs steps, and ends
 * its turn with an empty ERROR result on Ctrl+C, as the CLI does.
 */
const FAKE_AGY = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const resumed = args.includes('--conversation');
const conversation = resumed ? args[args.indexOf('--conversation') + 1] : 'conv-1';
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ args, prompt }) + '\\n');
if (process.env.FAKE_AGY_FAIL_START === '1') { process.stdout.write('error: not logged in\\n'); process.exit(4); }
if (resumed && process.env.FAKE_AGY_FAIL_RESUME === '1') process.exit(3);
const send = record => process.stdout.write(JSON.stringify(record) + '\\n');
send({ event: 'init', conversation_id: conversation, init: { model: 'gemini-test' } });
let step = 0;
const steps = resumed ? 2 : Number(process.env.FAKE_AGY_STEPS || 50);
const finish = (status, response) => {
  send({ event: 'result', result: { conversation_id: conversation, status, response, usage: { input_tokens: 10 * (step + 1), output_tokens: 5 } } });
  process.exit(status === 'SUCCESS' ? 0 : 130);
};
process.on('SIGINT', () => finish('ERROR', ''));
const tick = () => {
  if (step >= steps) return finish('SUCCESS', 'Handled: ' + prompt);
  send({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step, state: 'RUNNING', step_type: 'agent_response' } });
  setTimeout(() => {
    send({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step, state: 'DONE', step_type: 'agent_response', text_delta: 'step ' + step } });
    step += 1;
    setTimeout(tick, 40);
  }, 40);
};
tick();
`;

describe('Antigravity task steering at the next step boundary', () => {
    let binDir: string;
    let logPath: string;
    const originalPath = process.env.PATH;

    before(() => {
        binDir = mkdtempSync(path.join(tmpdir(), 'propr-fake-agy-'));
        writeFileSync(path.join(binDir, 'agy'), FAKE_AGY);
        chmodSync(path.join(binDir, 'agy'), 0o755);
        process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
    });
    after(() => {
        process.env.PATH = originalPath;
        delete process.env.FAKE_AGY_LOG;
        delete process.env.FAKE_AGY_FAIL_RESUME;
        delete process.env.FAKE_AGY_STEPS;
        delete process.env.FAKE_AGY_FAIL_START;
        rmSync(binDir, { recursive: true, force: true });
    });

    async function runAntigravity(source: QueueSource, env: Record<string, string> = {}) {
        logPath = path.join(binDir, `invocations-${Date.now()}-${Math.random()}.jsonl`);
        Object.assign(process.env, { FAKE_AGY_LOG: logPath, FAKE_AGY_FAIL_RESUME: '0', FAKE_AGY_FAIL_START: '0', FAKE_AGY_STEPS: '50', ...env });
        const session = new AntigravityTaskSteeringSession({ prompt: 'Implement the issue.\nWith details.', source, pollIntervalMs: 10 });
        const promptHandoff = new HandoffSpy();
        const result = await executeDockerCommand('bash', ['-c', buildAntigravitySteerableShellCommand(), 'propr-antigravity', '--output-format', 'stream-json'], {
            timeout: 20_000,
            liveInput: session,
            promptHandoff,
        });
        const invocations = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; prompt: string });
        return { result, invocations, promptHandoff };
    }

    test('interrupts at a finished step and resumes the conversation with the steer', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Use the existing helper instead.' });
        const { result, invocations, promptHandoff } = await runAntigravity(source);
        assert.equal(promptHandoff.received_, 1);

        assert.equal(invocations.length, 2);
        assert.equal(invocations[0]!.prompt, 'Implement the issue.\nWith details.');
        assert.deepEqual(invocations[0]!.args, ['--dangerously-skip-permissions', '--output-format', 'stream-json']);
        assert.equal(invocations[1]!.prompt, 'Use the existing helper instead.');
        assert.deepEqual(invocations[1]!.args, ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--conversation', 'conv-1', '--disable-slash-commands']);
        assert.deepEqual(source.acknowledged, ['steer-1']);
        assert.deepEqual(source.released, []);

        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.includes(ANTIGRAVITY_INVOCATION_EXIT_EVENT), false, 'control records are not run output');
        const parsed = parseAntigravityTaskOutput(result.stdout);
        assert.equal(parsed.protocolError, undefined);
        assert.equal(parsed.terminalStatus, 'success');
        assert.equal(parsed.conversationId, 'conv-1');
        assert.equal(parsed.summary, 'Handled: Use the existing helper instead.');
    });

    test('a run nobody steers ends after its single invocation', async () => {
        const source = new QueueSource();
        const { result, invocations } = await runAntigravity(source, { FAKE_AGY_STEPS: '2' });
        assert.equal(invocations.length, 1);
        assert.equal(result.exitCode, 0);
        assert.deepEqual(source.acknowledged, []);
        const parsed = parseAntigravityTaskOutput(result.stdout);
        assert.equal(parsed.terminalStatus, 'success');
        assert.equal(parsed.summary, 'Handled: Implement the issue.\nWith details.');
    });

    test('output before the CLI accepted its prompt does not count as the agent receiving it', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Never claimed' });
        const { result, invocations, promptHandoff } = await runAntigravity(source, { FAKE_AGY_FAIL_START: '1' });
        assert.equal(invocations.length, 1);
        assert.match(result.stdout, /not logged in/);
        assert.equal(result.exitCode, 4);
        assert.equal(promptHandoff.received_, 0);
        assert.deepEqual(source.claimed, [], 'no steer is claimed for an agent that never ran');
    });

    test('returns a steer to the queue when the resumed invocation never accepted it, and still ends the run', async () => {
        const source = new QueueSource();
        source.pending.push({ id: 'steer-1', text: 'Use the existing helper instead.' });
        const { result, invocations } = await runAntigravity(source, { FAKE_AGY_FAIL_RESUME: '1' });
        assert.equal(invocations.length, 2);
        assert.deepEqual(source.acknowledged, []);
        assert.deepEqual(source.released, ['steer-1']);
        assert.equal(result.exitCode, 3);
    });
});

describe('Antigravity task output of a resumed conversation', () => {
    const line = (record: Record<string, unknown>): string => JSON.stringify(record);
    const init = (conversation: string): string => line({ event: 'init', conversation_id: conversation, init: { model: 'gemini-test' } });
    const result = (conversation: string, status: string, response: string): string =>
        line({ event: 'result', result: { conversation_id: conversation, status, response, usage: { input_tokens: 30, output_tokens: 9 } } });

    test('takes the outcome from the last invocation and ignores the interrupts before it', () => {
        const parsed = parseAntigravityTaskOutput([init('conv-1'), result('conv-1', 'ERROR', ''), init('conv-1'), result('conv-1', 'SUCCESS', 'Done')].join('\n'));
        assert.equal(parsed.terminalStatus, 'success');
        assert.equal(parsed.protocolError, undefined);
        assert.equal(parsed.summary, 'Done');
        assert.deepEqual(parsed.tokenUsage, { input_tokens: 30, output_tokens: 9 });
    });

    test('rejects a resume that reported another conversation', () => {
        const parsed = parseAntigravityTaskOutput([init('conv-1'), result('conv-1', 'ERROR', ''), init('conv-2'), result('conv-2', 'SUCCESS', 'Done')].join('\n'));
        assert.match(parsed.protocolError ?? '', /resumed conversation "conv-2" instead of "conv-1"/);
    });
});
