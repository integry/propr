import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { AntigravityAgent } from '../packages/core/src/agents/impl/AntigravityAgent.js';
import { buildAntigravityConversationLog } from '../packages/core/src/agents/impl/utils/antigravityConversationLog.js';
import type { AntigravityOutputEvent } from '../packages/core/src/agents/impl/utils/antigravityOutputParser.js';
import { ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR } from '../packages/core/src/agents/impl/utils/antigravityTranscriptPaths.js';
import type { AgentConfig, AgentExecutionResult } from '../packages/core/src/agents/types.js';

process.env.NODE_ENV = 'test';

const FIXTURE = fs.readFileSync(new URL('./fixtures/antigravity/agy-1.5-transcript-tools.jsonl', import.meta.url), 'utf8');
const ENTRYPOINT = '/home/node/antigravity-entrypoint.sh';

after(async () => {
    await closeConnection();
});

interface AgentInternals {
    createTransientTranscriptPath(taskId?: string): string;
    cleanupTransientTranscript(transcriptPath: string | undefined): void;
    buildDockerArgs(params: Record<string, unknown>): string[];
    persistImplementationLog(options: { agentResult: AgentExecutionResult }): Promise<void>;
    processExecutionResult(options: Record<string, unknown>): Promise<AgentExecutionResult>;
}

function createAgent(configPath: string): AgentInternals {
    const config: AgentConfig = {
        id: 'antigravity-test', type: 'antigravity', alias: 'antigravity', enabled: true,
        dockerImage: 'propr/agent:latest', configPath,
        supportedModels: ['antigravity-gemini-3.8-flash'], defaultModel: 'antigravity-gemini-3.8-flash',
    };
    return new AntigravityAgent(config) as unknown as AgentInternals;
}

async function withTranscriptRoot<T>(fn: (root: string, sandbox: string) => Promise<T> | T): Promise<T> {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-agy-transcript-'));
    const previous = process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT;
    const root = path.join(sandbox, 'host', 'transcripts');
    process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT = root;
    try {
        return await fn(root, sandbox);
    } finally {
        if (previous === undefined) delete process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT;
        else process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT = previous;
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
}

function mountsOf(args: string[]): Array<{ host: string; container: string; mode: string }> {
    return args.flatMap((arg, index) => {
        if (args[index - 1] !== '-v') return [];
        const [host, container, mode = 'rw'] = arg.split(':');
        return [{ host, container, mode }];
    });
}

function envOf(args: string[]): Map<string, string> {
    const env = new Map<string, string>();
    args.forEach((arg, index) => {
        if (args[index - 1] !== '-e') return;
        const separator = arg.indexOf('=');
        env.set(arg.slice(0, separator), arg.slice(separator + 1));
    });
    return env;
}

const isWithin = (child: string, parent: string) => child === parent || child.startsWith(`${parent.replace(/\/$/, '')}/`);

function taskDockerArgs(agent: AgentInternals, sandbox: string, transcriptPath: string): string[] {
    const worktreePath = path.join(sandbox, 'worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    return agent.buildDockerArgs({
        worktreePath, githubToken: 'test-token', modelName: 'antigravity-gemini-3.8-flash', reasoningLevel: 'medium',
        issueNumber: 3830, taskId: 'probe-1', transcriptPath, streamOutput: true,
    });
}

describe('Antigravity task transcript export', () => {
    test('task-mode Docker args mount the run transcript directory read-write outside every read-only mount', async () => {
        await withTranscriptRoot(async (_root, sandbox) => {
            const agent = createAgent(path.join(sandbox, 'config'));
            const transcriptPath = agent.createTransientTranscriptPath('probe-1');
            const args = taskDockerArgs(agent, sandbox, transcriptPath);
            const mounts = mountsOf(args);
            const transcriptMount = mounts.find(mount => mount.container === ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR);
            assert.ok(transcriptMount, 'the transcript directory is mounted');
            assert.equal(transcriptMount.mode, 'rw');
            assert.equal(transcriptMount.host, path.dirname(transcriptPath));
            const containerTranscript = envOf(args).get('PROPR_ANTIGRAVITY_TRANSCRIPT_PATH');
            assert.equal(containerTranscript, `${ANTIGRAVITY_CONTAINER_TRANSCRIPT_DIR}/transcript.jsonl`);
            for (const mount of mounts.filter(candidate => candidate.mode === 'ro')) {
                assert.equal(isWithin(containerTranscript!, mount.container), false, `${containerTranscript} must not be under read-only ${mount.container}`);
            }
            // The shared git tree stays read-only for a worker-owned task.
            assert.ok(mounts.some(mount => mount.container === '/tmp/git-processor' && mount.mode === 'ro'));
            // Task runs stream: live narration, step activity and real usage.
            assert.deepEqual(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2), ['--output-format', 'stream-json']);
            assert.ok(args.includes('--print-timeout'));
            agent.cleanupTransientTranscript(transcriptPath);
            assert.equal(fs.existsSync(path.dirname(transcriptPath)), false);
        });
    });

    test('the entrypoint, run as root as ProPR launches it, exports the transcript to the host', async () => {
        await withTranscriptRoot(async (_root, sandbox) => {
            const agent = createAgent(path.join(sandbox, 'config'));
            fs.mkdirSync(path.join(sandbox, 'config'), { recursive: true });
            const transcriptPath = agent.createTransientTranscriptPath('probe-1');
            const args = taskDockerArgs(agent, sandbox, transcriptPath);
            assert.ok(args.includes('0:0'), 'ProPR launches the container as root');
            assert.equal(envOf(args).get('PROPR_EPHEMERAL_STATE'), '1');

            // Simulate the container filesystem: read-write mounts reach the
            // host, read-only mounts are unwritable, everything else is
            // container-local and discarded with the container.
            const container = path.join(sandbox, 'container');
            const mounts = mountsOf(args).sort((a, b) => a.container.length - b.container.length);
            const placed: string[] = [];
            for (const mount of mounts) {
                if (placed.some(parent => isWithin(mount.container, parent))) continue;
                const target = path.join(container, mount.container);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                if (mount.mode === 'ro') { fs.mkdirSync(target, { recursive: true }); fs.chmodSync(target, 0o555); }
                else fs.symlinkSync(mount.host, target);
                placed.push(mount.container);
            }
            const script = fs.readFileSync(path.join(process.cwd(), 'scripts/antigravity-entrypoint.sh'), 'utf8')
                .replaceAll('/tmp/propr-antigravity-home', `${container}/tmp/propr-antigravity-home`)
                .replaceAll('/home/node', `${container}/home/node`);
            const entrypoint = path.join(sandbox, 'antigravity-entrypoint.sh');
            fs.writeFileSync(entrypoint, script, { mode: 0o755 });

            const bin = path.join(sandbox, 'bin');
            fs.mkdirSync(bin);
            const stub = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
            stub('id', 'if [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi');
            stub('su-exec', 'shift; exec "$@"');
            stub('chown', 'exit 0');
            fs.writeFileSync(path.join(sandbox, 'fixture.jsonl'), FIXTURE);
            stub('agy', [
                'cat >/dev/null',
                'logs="$HOME/.gemini/antigravity-cli/brain/x/.system_generated/logs"',
                'mkdir -p "$logs"',
                `cp ${JSON.stringify(path.join(sandbox, 'fixture.jsonl'))} "$logs/transcript.jsonl"`,
                'echo \'{"event":"result","result":{"conversation_id":"agy-probe","status":"SUCCESS","response":"Done."}}\'',
            ].join('\n'));

            const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, HOME: path.join(sandbox, 'root-home') };
            for (const [key, value] of envOf(args)) env[key] = value.startsWith('/') ? path.join(container, value) : value;
            // A login shell would reset PATH from /etc/profile and lose the stubs.
            const command = args.slice(args.indexOf(ENTRYPOINT) + 1).map(arg => arg === '-lc' ? '-c' : arg);
            const run = spawnSync('/bin/bash', [entrypoint, ...command], { env, input: 'prompt', encoding: 'utf8', timeout: 30000 });

            assert.equal(run.status, 0, run.stderr);
            assert.match(run.stdout, /"event":"result"/);
            assert.ok(fs.existsSync(transcriptPath), `host transcript missing; stderr:\n${run.stderr}`);
            assert.equal(fs.readFileSync(transcriptPath, 'utf8'), FIXTURE);
            assert.doesNotMatch(run.stderr, /could not export/);
        });
    });
});

describe('Antigravity task result processing', () => {
    test('a stream-json run with a transcript keeps every step as Claude-shaped tool calls', async () => {
        await withTranscriptRoot(async (_root, sandbox) => {
            const agent = createAgent(path.join(sandbox, 'config'));
            const transcriptPath = agent.createTransientTranscriptPath('probe-1');
            fs.writeFileSync(transcriptPath, FIXTURE);
            const stdout = [
                JSON.stringify({ event: 'init', conversation_id: 'agy-task', init: { model: 'gemini-3.8-flash-medium', cwd: '/home/node/workspace', tools: [] } }),
                JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-task', step_index: 14, state: 'DONE', step_type: 'RUN_COMMAND', usage: { input_tokens: 900, output_tokens: 20 } } }),
                JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'agy-task', step_index: 73, state: 'DONE', step_type: 'AGENT_RESPONSE', text_delta: 'Done. Added subtract and a test; node --test passes.' } }),
                JSON.stringify({ event: 'result', result: { conversation_id: 'agy-task', status: 'SUCCESS', response: 'Done. Added subtract and a test; node --test passes.', usage: { input_tokens: 41000, output_tokens: 1200, cache_read_tokens: 30000, thinking_tokens: 300 } } }),
            ].join('\n');
            let persisted: AgentExecutionResult | undefined;
            agent.persistImplementationLog = async ({ agentResult }) => { persisted = agentResult; };

            const result = await agent.processExecutionResult({
                result: { stdout, stderr: '', exitCode: 0 }, executionTime: 10,
                issueRef: { number: 3830, repoOwner: 'integry', repoName: 'propr' },
                effectiveModel: 'antigravity-gemini-3.8-flash', requestedCliModel: 'gemini-3.8-flash-medium',
                prompt: 'Add subtract', worktreePath: sandbox, worktreeGitContent: null, transcriptPath,
            });

            assert.equal(result.success, true, result.error);
            assert.equal(result.summary, 'Done. Added subtract and a test; node --test passes.');
            assert.equal(result.sessionId, 'agy-task');
            assert.equal(result.tokenUsage?.input_tokens, 41000);
            assert.equal(result.tokenUsage?.cache_read_input_tokens, 30000);
            const log = result.conversationLog as Array<{ type: string; isError?: boolean; message: { content: Array<Record<string, unknown>> } }>;
            const blocks = log.flatMap(entry => entry.message.content.map(block => ({ entry, block })));
            const toolUses = blocks.filter(({ block }) => block.type === 'tool_use');
            const toolResults = blocks.filter(({ block }) => block.type === 'tool_result');
            assert.deepEqual(toolUses.map(({ block }) => block.name), ['RUN_COMMAND', 'RUN_COMMAND', 'GENERIC', 'LIST_DIRECTORY', 'RUN_COMMAND']);
            assert.deepEqual(toolUses[0].block.input, { command: 'node --test' });
            // Step 23 is still RUNNING: its call is kept, but no result is invented for it.
            assert.deepEqual(toolResults.map(({ block }) => block.tool_use_id), toolUses.filter((_, index) => index !== 1).map(({ block }) => block.id));
            assert.equal(toolUses[1].block.id, 'antigravity-step-23');
            assert.equal(toolResults[0].block.content, '# pass 2\n# fail 0');
            assert.deepEqual(toolResults.map(({ block }) => block.is_error), [false, false, true, false]);
            assert.equal(toolResults[2].entry.isError, true);
            assert.match(String(toolResults[2].block.content), /directory not found/);
            assert.ok(blocks.some(({ block }) => block.type === 'thinking'));
            assert.equal(log.filter(entry => entry.type === 'user' && entry.message.content[0].type === 'text').length, 2);
            assert.ok(log.some(entry => entry.type === 'error' && entry.isError));
            assert.equal(persisted?.conversationLog, result.conversationLog);
            assert.equal(fs.existsSync(transcriptPath), false, 'the transcript is removed once read');
        });
    });

    test('a stream-only run keeps unfinished tool steps as calls without results', () => {
        const update = (step_index: number, state: string, step_type = 'RUN_COMMAND', text_delta?: string) => ({ event: 'step_update', step_update: { conversation_id: 'agy-stream', step_index, state, step_type, ...(text_delta ? { text_delta } : {}) } });
        const events = [
            update(1, 'RUNNING'), update(1, 'DONE', 'RUN_COMMAND', 'ok'),
            update(2, 'RUNNING'),
            update(3, 'RUNNING', 'VIEW_FILE'), update(3, 'CANCELED', 'VIEW_FILE'),
            update(4, 'FAILED'),
        ] as unknown as AntigravityOutputEvent[];
        const log = buildAntigravityConversationLog(events) as Array<{ isError?: boolean; message: { content: Array<Record<string, unknown>> } }>;
        const blocks = log.flatMap(entry => entry.message.content);
        assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.id), [1, 2, 3, 4].map(index => `antigravity-step-agy-stream-${index}`));
        const results = blocks.filter(block => block.type === 'tool_result');
        assert.deepEqual(results.map(block => block.tool_use_id), [1, 3, 4].map(index => `antigravity-step-agy-stream-${index}`));
        assert.deepEqual(results.map(block => block.is_error), [false, true, true]);
    });

    test('a transcript step without a terminal status has no result, unless it reported an error', () => {
        const step = (step_index: number, status: string | undefined, content: string) => ({ source: 'MODEL', type: 'RUN_COMMAND', step_index, ...(status ? { status } : {}), content });
        const log = buildAntigravityConversationLog([
            step(1, 'RUNNING', 'Created At: x\n\nnpm test'),
            step(2, undefined, 'Created At: x\n\nnpm test'),
            step(3, 'RUNNING', 'Created At: x\nEncountered error in step execution: boom'),
            step(4, 'CANCELLED', 'Created At: x\n\nnpm test'),
        ] as AntigravityOutputEvent[]) as Array<{ message: { content: Array<Record<string, unknown>> } }>;
        const blocks = log.flatMap(entry => entry.message.content);
        assert.equal(blocks.filter(block => block.type === 'tool_use').length, 4);
        const results = blocks.filter(block => block.type === 'tool_result');
        assert.deepEqual(results.map(block => [block.tool_use_id, block.is_error]), [['antigravity-step-3', true], ['antigravity-step-4', true]]);
    });

    test('a run whose transcript never arrived keeps its plain summary and still gets one session', async () => {
        await withTranscriptRoot(async (_root, sandbox) => {
            const agent = createAgent(path.join(sandbox, 'config'));
            const transcriptPath = agent.createTransientTranscriptPath('probe-2');
            agent.persistImplementationLog = async () => undefined;
            const plain = await agent.processExecutionResult({
                result: { stdout: 'Plain final answer', stderr: '', exitCode: 0 }, executionTime: 10,
                issueRef: { number: 3830, repoOwner: 'integry', repoName: 'propr' },
                effectiveModel: 'antigravity-gemini-3.8-flash', prompt: 'Add subtract', worktreePath: sandbox, worktreeGitContent: null, transcriptPath,
            });
            assert.equal(plain.summary, 'Plain final answer');
            // The execution row and its log row pair by session for cost attribution.
            assert.match(plain.sessionId ?? '', /^antigravity-run-/);
        });
    });
});
