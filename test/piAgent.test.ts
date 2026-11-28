import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAgent } from '../packages/core/src/agents/impl/PiAgent.js';
import { createAgentFromConfig } from '../packages/core/src/agents/createAgentFromConfig.js';
import { buildPiExecutionResult } from '../packages/core/src/agents/impl/utils/piExecutionResult.js';
import { agentResultToMetricsResult } from '../packages/core/src/agents/impl/utils/failedAgentExecution.js';
import { buildPiCliArgs, buildPiDockerArgs, forwardablePiEnvVars, PI_CONTAINER_RUNTIME_HOME, PI_CONTAINER_SESSION_DIR } from '../packages/core/src/agents/impl/utils/piDockerArgsBuilder.js';
import { isSuccessfulPiResult, parsePiOutput, parsePiJsonLines } from '../packages/core/src/agents/impl/utils/piOutputParser.js';
import { resolvePiThinkingLevel, toPiCliModel, toPiOpenRouterId, toProprPiModelId } from '../packages/core/src/agents/impl/piModelIds.js';
import { resolvePiReasoningLevel } from '../packages/core/src/config/configManagerReasoning.js';
import { getAgentTypeFromModel, getModelShortName, getOpenRouterId, resolveModelAlias } from '../packages/core/src/config/modelAliases.js';
import { AgentActivityWatchdog, type AgentWatchdogTrip } from '../packages/core/src/claude/docker/agentActivityWatchdog.js';
import { classifyAgentOutputLine } from '../packages/core/src/claude/docker/agentOutputActivity.js';
import type { AgentConfig } from '../packages/core/src/agents/types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { getPiLoginProviders, normalizePiModelId } from '../packages/shared/src/agentLogin.js';

after(async () => {
    await closeConnection();
});

const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/pi/pi-1.6.1-json-tool-task.jsonl'), 'utf8');
const MODEL = 'pi-openrouter/mistralai/devstral-2512';

function piConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '/nonexistent/propr-pi-test/agent', supportedModels: [MODEL], defaultModel: MODEL, ...overrides,
    };
}

function valueAfter(args: string[], flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function mounts(args: string[]): string[] {
    return args.flatMap((arg, index) => (arg === '-v' ? [args[index + 1]] : []));
}

describe('Pi JSON output parser (Pi 1.6.1 fixture)', () => {
    const parsed = parsePiOutput(FIXTURE);

    test('reads the session id from the session header', () => {
        assert.equal(parsed.sessionId, '01a21d71-9198-74eb-978e-565639986934');
    });

    test('takes the summary from the last assistant message_end text', () => {
        assert.equal(parsed.summary, 'Done. Added subtract(a, b) to math.js, exported it, and added a test; node --test passes.');
        assert.equal(parsed.providerModel, 'openrouter/mistralai/devstral-2512');
    });

    test('a settled, unaborted run that exited 0 with a stop reason of "stop" succeeds', () => {
        assert.equal(parsed.settled, true);
        assert.equal(parsed.aborted, false);
        assert.equal(parsed.stopReason, 'stop');
        assert.equal(isSuccessfulPiResult(0, parsed), true);
        assert.equal(isSuccessfulPiResult(1, parsed), false, 'a non-zero exit fails the run');
    });

    test('sums per-response usage across every assistant message', () => {
        assert.deepEqual(parsed.tokenUsage, { input_tokens: 1583 + 2202, output_tokens: 65 + 164, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    });

    test('uses the provider cost when every response reports totalFromProvider', () => {
        assert.ok(parsed.costUsd !== undefined);
        assert.ok(Math.abs(parsed.costUsd - (0.000755568 + 0.001196712)) < 1e-12);
    });

    test('builds Claude-shaped conversation events', () => {
        const log = parsed.conversationLog;
        assert.equal(log[0].type, 'user');
        assert.match(log[0].message.content[0].text ?? '', /add subtract\(a, b\)/);

        const toolUses = log.flatMap(entry => entry.message.content.filter(item => item.type === 'tool_use'));
        assert.deepEqual(toolUses.map(item => [item.id, item.name]), [['HEFIeQfFW', 'read'], ['7Rc4Yw8fp', 'read'], ['4vK53wBZb', 'bash']]);
        assert.deepEqual(toolUses[2].input, { command: 'cat missing.txt', timeout: 5 });
        const firstAssistant = log.find(entry => entry.type === 'assistant')!;
        assert.equal(firstAssistant.message.id, 'gen-1795790312-9VMDdqzYpui5kDqt0P0f');
        assert.deepEqual(firstAssistant.message.usage, { input_tokens: 1583, output_tokens: 65, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

        const results = log.flatMap(entry => entry.message.content.filter(item => item.type === 'tool_result'));
        // turn_end repeats the bash result; each call appears once.
        assert.deepEqual(results.map(item => [item.tool_use_id, item.is_error]), [['4vK53wBZb', true], ['6UNoPXH4u', false], ['HEFIeQfFW', false]]);
        assert.match(results[0].content ?? '', /No such file or directory/);
        const failedEntry = log.find(entry => entry.message.content.some(item => item.tool_use_id === '4vK53wBZb'))!;
        assert.equal(failedEntry.isError, true, 'the failed bash call is a failed persisted event');

        const last = log.at(-1)!;
        assert.equal(last.type, 'assistant');
        assert.deepEqual(last.message.content, [{ type: 'text', text: parsed.summary }]);
    });

    test('keeps thinking blocks as thinking content', () => {
        const output = [
            JSON.stringify({ type: 'session', id: 's1', timestamp: '2026-11-27T00:00:00.000Z' }),
            JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan first.' }, { type: 'text', text: 'Done.' }], provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, cost: { total: 0.01 } }, stopReason: 'stop', timestamp: 1 } }),
            JSON.stringify({ type: 'agent_settled', aborted: false }),
        ].join('\n');
        const result = parsePiOutput(output);
        assert.deepEqual(result.conversationLog[0].message.content, [{ type: 'thinking', thinking: 'Plan first.' }, { type: 'text', text: 'Done.' }]);
        assert.deepEqual(result.tokenUsage, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 });
        assert.equal(result.costUsd, undefined, 'a total not marked totalFromProvider leaves cost to ProPR pricing');
    });

    test('splits records on LF only', () => {
        const text = 'line\u2028separator';
        const events = parsePiJsonLines(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\r\n`);
        assert.equal(events.length, 1);
        assert.equal((events[0].message?.content as Array<{ text: string }>)[0].text, text);
    });
});

describe('Pi run outcome', () => {
    test('a provider error stops the run even though Pi exits 0', () => {
        // Pi 1.6.1 with a rejected OpenRouter key.
        const output = [
            JSON.stringify({ type: 'session', version: 3, id: 'err-session', timestamp: '2026-11-27T16:37:51.458Z', cwd: '/home/node/workspace' }),
            JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Say hi' }], timestamp: 1795797471505 } }),
            JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'openrouter', model: 'mistralai/devstral-2512', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: 'error', errorMessage: '401: {"message":"Missing Authentication header","code":401}', timestamp: 1795797471582 } }),
            JSON.stringify({ type: 'agent_end', messages: [], willRetry: false }),
            JSON.stringify({ type: 'agent_settled', aborted: false }),
        ].join('\n');
        const { response } = buildPiExecutionResult({ result: { stdout: output, stderr: '', exitCode: 0 }, modelUsed: MODEL, executionTimeMs: 10 });
        assert.equal(response.success, false);
        assert.match(response.error ?? '', /401/);
        assert.equal(response.sessionId, 'err-session');
    });

    test('an aborted or unsettled run fails', () => {
        const aborted = FIXTURE.replace('"aborted":false', '"aborted":true');
        assert.equal(isSuccessfulPiResult(0, parsePiOutput(aborted)), false);
        assert.match(buildPiExecutionResult({ result: { stdout: aborted, stderr: '', exitCode: 0 }, modelUsed: MODEL, executionTimeMs: 1 }).response.error ?? '', /aborted/);
        const unsettled = FIXTURE.split('\n').filter(line => !line.includes('agent_settled')).join('\n');
        const { response } = buildPiExecutionResult({ result: { stdout: unsettled, stderr: 'killed', exitCode: 137 }, modelUsed: MODEL, executionTimeMs: 1 });
        assert.equal(response.success, false);
        assert.match(response.error ?? '', /before settling: killed/);
    });

    test('builds the agent result recorded for metrics from the fixture', () => {
        const { response } = buildPiExecutionResult({ result: { stdout: FIXTURE, stderr: '', exitCode: 0 }, modelUsed: MODEL, thinkingLevel: 'high', prompt: 'p', executionTimeMs: 42 });
        assert.equal(response.success, true);
        assert.equal(response.error, undefined);
        assert.equal(response.modelUsed, MODEL, 'the ProPR id keeps labels and pricing');
        assert.equal(response.providerModel, 'openrouter/mistralai/devstral-2512');
        assert.equal(response.reasoningLevel, 'high');
        assert.equal(response.sessionId, '01a21d71-9198-74eb-978e-565639986934');
        assert.equal(response.summary, parsePiOutput(FIXTURE).summary);
        assert.equal(response.providerCostUsd, response.cost);
        assert.deepEqual(response.tokenUsage, { input_tokens: 3785, output_tokens: 229, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
        assert.equal(response.conversationLog?.length, 6);
        assert.equal(agentResultToMetricsResult(response).providerCostUsd, response.providerCostUsd, 'metrics record the provider cost');
    });

    test('a watchdog stop fails an otherwise successful run', () => {
        const watchdogTrip = { rule: 'inactivity', terminationReason: 'stalled', threshold: 1, message: 'stalled' } as AgentWatchdogTrip;
        const { response } = buildPiExecutionResult({ result: { stdout: FIXTURE, stderr: '', exitCode: 0, watchdogTrip }, modelUsed: MODEL, executionTimeMs: 1 });
        assert.equal(response.success, false);
        assert.equal(response.terminationReason, 'stalled');
    });
});

describe('Pi Docker args', () => {
    test('runs pi in JSON mode with model, thinking, session dir and --no-approve', () => {
        assert.deepEqual(buildPiCliArgs({ modelName: MODEL, thinkingLevel: 'high', mode: 'execute' }), [
            'pi', '-p', '--mode', 'json', '--model', 'openrouter/mistralai/devstral-2512', '--thinking', 'high', '--session-dir', PI_CONTAINER_SESSION_DIR, '--no-approve',
        ]);
        // A thinking suffix on the ProPR id never reaches --model: one level is sent, as --thinking.
        assert.deepEqual(buildPiCliArgs({ modelName: 'pi-anthropic/claude-opus-5-5:low', mode: 'execute' }).slice(4, 8), ['--model', 'anthropic/claude-opus-5-5', '--thinking', 'low']);
        const overridden = buildPiCliArgs({ modelName: 'pi-anthropic/claude-opus-5-5:low', thinkingLevel: 'max', mode: 'execute' });
        assert.equal(valueAfter(overridden, '--model'), 'anthropic/claude-opus-5-5');
        assert.equal(valueAfter(overridden, '--thinking'), 'max');
        assert.equal(overridden.filter(arg => arg === '--thinking').length, 1);
        assert.equal(buildPiCliArgs({ modelName: MODEL, mode: 'execute' }).includes('--thinking'), false, 'no level leaves the model default');
    });

    test('task runs mount the workspace and an existing Pi dir, pass the prompt on stdin, and keep secrets out of argv', () => {
        const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-agent-'));
        try {
            const config = piConfig({ envVars: { OPENROUTER_API_KEY: 'sk-or-secret', PI_CODING_AGENT_DIR: '/tmp/evil', PROPR_PI_SOURCE_DIR: '/', GH_TOKEN: 'ghp_user', 'BAD-NAME': 'x' } });
            const { args, secretEnv } = buildPiDockerArgs({ config, worktreePath: '/tmp/git-processor/worktrees/w1', configPath: piDir, modelName: MODEL, thinkingLevel: 'medium', issueNumber: 7, taskId: 'task-1', gitMountArgs: [] }, 'ghs_scoped');
            const joined = args.join(' ');
            assert.ok(args.includes('-i'), 'stdin stays open for the prompt');
            assert.equal(valueAfter(args, '--user'), '0:0', 'the entrypoint starts as root only to seed the disposable home');
            assert.ok(args.includes('/opt/propr/pi-entrypoint.sh'));
            assert.match(args[args.indexOf('-lc') + 1], /^export PROPR_PI_NODE_PATH="\$PATH"\nexport PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\n/);
            assert.ok(mounts(args).includes('/tmp/git-processor/worktrees/w1:/home/node/workspace:rw'));
            assert.ok(mounts(args).includes(`${piDir}:/root/propr-pi-source:rw`));
            assert.ok(args.includes('PROPR_PI_SOURCE_DIR=/root/propr-pi-source'));
            assert.ok(args.includes('PROPR_AGENT_TYPE=pi'));
            assert.ok(args.includes(`PROPR_PI_RUNTIME_HOME=${PI_CONTAINER_RUNTIME_HOME}`));
            assert.ok(args.includes('--no-approve'));
            assert.equal(valueAfter(args, '--session-dir'), PI_CONTAINER_SESSION_DIR);
            assert.ok(PI_CONTAINER_SESSION_DIR.startsWith(`${PI_CONTAINER_RUNTIME_HOME}/`), 'sessions live in the node-owned disposable home');
            assert.deepEqual(secretEnv, { OPENROUTER_API_KEY: 'sk-or-secret', GH_TOKEN: 'ghs_scoped', GITHUB_TOKEN: 'ghs_scoped' });
            assert.ok(!joined.includes('sk-or-secret') && !joined.includes('ghs_scoped') && !joined.includes('ghp_user'));
            assert.ok(args.includes('OPENROUTER_API_KEY') && args.includes('GH_TOKEN'));
            assert.ok(!joined.includes('/tmp/evil') && !args.includes('PROPR_PI_SOURCE_DIR=/'));
        } finally {
            fs.rmSync(piDir, { recursive: true, force: true });
        }
    });

    test('never creates root-owned paths: no missing host dir mount, nothing mounted into the disposable home', () => {
        const missing = path.join(os.tmpdir(), `propr-pi-missing-${process.pid}`, 'agent');
        const { args } = buildPiDockerArgs({ config: piConfig({ envVars: { ANTHROPIC_API_KEY: 'k' } }), worktreePath: '/tmp/w', configPath: missing, modelName: MODEL, issueNumber: 1, gitMountArgs: [] }, '');
        assert.equal(mounts(args).some(mount => mount.includes('/root/propr-pi-source')), false, 'Docker would create a missing host dir as root');
        assert.equal(fs.existsSync(missing), false);
        assert.equal(mounts(args).some(mount => mount.split(':')[1]?.startsWith(PI_CONTAINER_RUNTIME_HOME)), false);
        assert.equal(args.includes('GH_TOKEN'), false, 'no token, no token variable');
    });

    test('analysis runs are read-only, keep no session and run no writing tool', () => {
        const { args } = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/a', modelName: MODEL, issueNumber: 0, mode: 'analysis', gitMountArgs: [] }, '');
        assert.ok(mounts(args).includes('/tmp/a:/home/node/workspace:ro'));
        assert.ok(args.includes('--no-session') && args.includes('--no-tools') && args.includes('--no-approve'));
        assert.equal(args.includes('--session-dir'), false);
        assert.ok(args.includes('PROPR_REPO_SETUP=0'));
        // The scout alone gets tools: only the repository MCP server's (test/piScoutAndExtensions.test.ts).
        const inspected = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/a', modelName: MODEL, issueNumber: 0, mode: 'analysis', repositoryInspection: true, gitMountArgs: [] }, '').args;
        assert.equal(valueAfter(inspected, '--tools')?.split(',').every(tool => tool.startsWith('mcp__propr_repository__')), true);
    });

    test('analysis and scout use the same protected credential source as tasks', () => {
        const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-analysis-source-'));
        try {
            for (const repositoryInspection of [false, true]) {
                const { args } = buildPiDockerArgs({ config: piConfig(), worktreePath: '/tmp/a', configPath: piDir, modelName: MODEL, issueNumber: 0, mode: 'analysis', repositoryInspection, gitMountArgs: [] }, '');
                assert.deepEqual(mounts(args).filter(mount => mount.startsWith(`${piDir}:`)), [`${piDir}:/root/propr-pi-source:rw`]);
                assert.ok(args.includes('PROPR_PI_SOURCE_DIR=/root/propr-pi-source'));
            }
        } finally {
            fs.rmSync(piDir, { recursive: true, force: true });
        }
    });

    test('rejects a credential source also exposed through a writable workspace, git or goal mount', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-source-overlap-'));
        try {
            const source = path.join(root, 'agent');
            const alias = path.join(root, 'alias');
            fs.mkdirSync(source);
            fs.symlinkSync(source, alias);
            const params = { config: piConfig(), configPath: alias, worktreePath: '/tmp/w', modelName: MODEL, issueNumber: 1, gitMountArgs: [] };
            assert.throws(() => buildPiDockerArgs({ ...params, worktreePath: root }, ''), /credential source overlaps/);
            assert.throws(() => buildPiDockerArgs({ ...params, gitMountArgs: ['-v', `${source}:/somewhere:rw`] }, ''), /credential source overlaps/);
            assert.throws(() => buildPiDockerArgs({ ...params, goalSession: { hostDir: root, sessionId: 'goal' } }, ''), /credential source overlaps/);
            assert.doesNotThrow(() => buildPiDockerArgs({ ...params, worktreePath: root, mode: 'analysis' }, ''));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('forwards only safe, non-reserved agent env vars', () => {
        assert.deepEqual(forwardablePiEnvVars({ OPENAI_API_KEY: 'a', PROPR_X: 'b', HOME: '/root', GITHUB_TOKEN: 'c', MULTI: 'x\ny', PI_OFFLINE: '0' }), { OPENAI_API_KEY: 'a', PI_OFFLINE: '0' });
    });
});

describe('Pi agent type wiring', () => {
    test('createAgentFromConfig builds a PiAgent', () => {
        assert.ok(createAgentFromConfig(piConfig()) instanceof PiAgent);
    });

    test('model ids map between ProPR and Pi', () => {
        assert.deepEqual(toPiCliModel('pi-openrouter/qwen/qwen3-coder:free'), { model: 'openrouter/qwen/qwen3-coder:free', provider: 'openrouter' });
        assert.deepEqual(toPiCliModel('pi:pi-anthropic/claude-opus-5-5:xhigh'), { model: 'anthropic/claude-opus-5-5', provider: 'anthropic', thinking: 'xhigh' });
        // IDs are normalized when created (UI, API, CLI): provider lowercased, model part as typed.
        assert.equal(normalizePiModelId(' Pi-OpenRouter/Qwen/Qwen3-Coder:HIGH '), 'pi-openrouter/Qwen/Qwen3-Coder:HIGH');
        assert.equal(normalizePiModelId('pi:pi-Anthropic/claude-opus-5-5'), 'pi:pi-anthropic/claude-opus-5-5');
        assert.equal(normalizePiModelId('claude-opus-5-5'), 'claude-opus-5-5');
        // So the login, the credential check and --model agree on the provider.
        const id = normalizePiModelId('pi-OpenRouter/qwen/qwen3-coder');
        assert.equal(getPiLoginProviders([id])[0], toPiCliModel(id).provider);
        // Provider ids are lowercase wherever they are compared; the model part keeps its case.
        assert.deepEqual(toPiCliModel('pi-OpenRouter/Qwen/Qwen3-Coder'), { model: 'openrouter/Qwen/Qwen3-Coder', provider: 'openrouter' });
        assert.equal(toProprPiModelId('anthropic/claude-sonnet-5-5'), 'pi-anthropic/claude-sonnet-5-5');
        assert.equal(toPiOpenRouterId('pi-openrouter/qwen/qwen3-coder:free'), 'qwen/qwen3-coder:free');
        assert.throws(() => toPiCliModel('pi-claude'), /provider and model/);
    });

    test('model labels, aliases and pricing resolve to the underlying model', () => {
        assert.equal(getAgentTypeFromModel('pi-anthropic/claude-opus-5-5'), 'pi');
        assert.equal(getModelShortName('pi-anthropic/claude-opus-5-5:high'), 'Claude Opus 5.5');
        assert.equal(getModelShortName('pi-openrouter/qwen/qwen3-coder:free'), 'Qwen3 Coder');
        assert.equal(resolveModelAlias('pi-devstral2'), MODEL);
        assert.equal(getOpenRouterId(MODEL), 'mistralai/devstral-2512');
        assert.equal(getOpenRouterId('pi-openrouter/qwen/qwen3-coder'), 'qwen/qwen3-coder');
    });

    test('one thinking level wins: task level, then the agent’s model setting, then the model suffix, then the global default', () => {
        const suffixed = 'pi-anthropic/claude-opus-5-5:high';
        // An explicit per-model suffix beats the global default (the reported bug: `:high` with a global `low`).
        assert.equal(resolvePiThinkingLevel({ modelId: suffixed, globalDefault: 'low' }), 'high');
        assert.equal(resolvePiThinkingLevel({ modelId: 'pi-anthropic/claude-opus-5-5', globalDefault: 'low' }), 'low');
        assert.equal(resolvePiThinkingLevel({ modelId: suffixed, agentModel: 'xhigh', globalDefault: 'low' }), 'xhigh');
        // A task's explicit reasoning label beats both.
        assert.equal(resolvePiThinkingLevel({ modelId: suffixed, explicit: 'medium', agentModel: 'xhigh', globalDefault: 'low' }), 'medium');
        assert.equal(resolvePiThinkingLevel({ modelId: 'pi-anthropic/claude-opus-5-5' }), null);
        assert.equal(resolvePiThinkingLevel({ modelId: 'not-a-pi-model', globalDefault: 'max' }), 'max');
    });

    test('ProPR reasoning levels map to Pi thinking levels', () => {
        assert.equal(resolvePiReasoningLevel(''), null);
        assert.equal(resolvePiReasoningLevel('auto'), null);
        assert.equal(resolvePiReasoningLevel('low'), 'low');
        assert.equal(resolvePiReasoningLevel('xhigh'), 'xhigh');
        assert.equal(resolvePiReasoningLevel('max'), 'max');
        assert.equal(resolvePiReasoningLevel('ultra'), 'max');
        assert.equal(resolvePiReasoningLevel('ultracode'), 'max');
    });
});

describe('Pi activity detection', () => {
    const SETTINGS = { stallTimeoutMs: 1_000, toolStallTimeoutMs: 5_000, degenerateOutputLimit: 3 };

    function harness() {
        let now = 0;
        const watchdog = new AgentActivityWatchdog(SETTINGS, { now: () => now, onTrip: () => undefined });
        return { watchdog, advance: (ms: number) => { now += ms; return watchdog.check(); } };
    }

    test('classifies Pi tool calls, executions and results', () => {
        const lines = FIXTURE.split('\n');
        const kinds = (needle: string) => classifyAgentOutputLine(lines.find(line => line.includes(needle))!);
        assert.deepEqual(kinds('"toolcall_start"'), [{ kind: 'tool_start', id: 'HEFIeQfFW' }]);
        assert.deepEqual(kinds('"tool_execution_start"'), [{ kind: 'tool_start', id: 'HEFIeQfFW' }]);
        assert.deepEqual(kinds('"toolCallId":"4vK53wBZb","toolName":"bash","result"'), [{ kind: 'tool_end', id: '4vK53wBZb' }]);
        assert.deepEqual(kinds('"role":"toolResult"'), [{ kind: 'tool_end', id: 'HEFIeQfFW' }]);
        assert.deepEqual(kinds('"stopReason":"toolUse"').map(activity => activity.kind), ['tool_start', 'tool_start', 'tool_start']);
        assert.deepEqual(classifyAgentOutputLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi' } })), [{ kind: 'text', text: 'Hi' }]);
        assert.deepEqual(classifyAgentOutputLine(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: ' ' } })), [{ kind: 'activity' }]);
    });

    test('a long tool run is held to the tool threshold, and the final answer closes open calls', () => {
        const { watchdog, advance } = harness();
        const lines = FIXTURE.split('\n').filter(Boolean);
        const toolStart = lines.findIndex(line => line.includes('"tool_execution_start"'));
        for (const line of lines.slice(0, toolStart + 1)) watchdog.observeLine(line);
        assert.equal(watchdog.openTools, 3);
        assert.equal(advance(3_000), null, 'a quiet tool is not a stall below the tool threshold');
        for (const line of lines.slice(toolStart + 1)) watchdog.observeLine(line);
        assert.equal(watchdog.openTools, 0);
        assert.equal(advance(999), null);
        assert.equal(advance(1)?.rule, 'inactivity');
    });
});
