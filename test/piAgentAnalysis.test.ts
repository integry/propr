import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The container run is replaced by recorded Pi 1.6.1 output; every other export stays real.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/pi');
const SCOUT_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'pi-1.6.1-json-scout-mcp.jsonl'), 'utf8');
const TASK_FIXTURE = fs.readFileSync(path.join(FIXTURES, 'pi-1.6.1-json-tool-task.jsonl'), 'utf8');
interface DockerRun { args: string[]; options: Record<string, unknown> }
const runs: DockerRun[] = [];
let nextResult: { stdout: string; stderr?: string; exitCode?: number; timedOut?: boolean } = { stdout: SCOUT_FIXTURE };
const realDockerExecutor = await import('../packages/core/src/claude/docker/dockerExecutor.js');
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: {
    ...realDockerExecutor,
    executeDockerCommand: async (command: string, args: string[], options: Record<string, unknown>) => {
        if (command === 'docker') runs.push({ args, options });
        return { stderr: '', exitCode: 0, timedOut: false, ...(command === 'docker' ? nextResult : { stdout: '' }) };
    },
} });

const { PiAgent } = await import('../packages/core/src/agents/impl/PiAgent.js');
const { PI_MCP_CONFIG_ENV } = await import('../packages/core/src/agents/impl/utils/piDockerArgsBuilder.js');
const { REPOSITORY_SCOUT_CONTAINER_ROOT } = await import('../packages/core/src/agents/impl/utils/repositoryScoutMcpServer.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
type AgentTaskOptions = import('../packages/core/src/agents/types.js').AgentTaskOptions;

after(async () => {
    await closeConnection();
});

const MODEL = 'pi-openrouter/mistralai/devstral-2512';
const TOKEN = 'tok-propr-mcp-secret';
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-analysis-'));
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

function createAgent() {
    return new PiAgent({ id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest', configPath: '/nonexistent/propr-pi-test/agent', supportedModels: [MODEL], defaultModel: MODEL });
}

function lastRun(): DockerRun {
    assert.ok(runs.length > 0, 'a container ran');
    return runs[runs.length - 1];
}

function piArgs(args: string[]): string[] {
    return args.slice(args.lastIndexOf('propr/agent:latest') + 1);
}

beforeEach(() => {
    runs.length = 0;
    nextResult = { stdout: SCOUT_FIXTURE };
});

describe('PiAgent.analyze', () => {
    test('a review, summary or commit-subject analysis runs tool-less on an empty read-only workspace', async () => {
        const result = await createAgent().analyze('Summarize this change', { executionType: 'pr-summary', suppressLlmLog: true, skipUsageTracking: true });
        assert.equal(result.success, true);
        const { args, options } = lastRun();
        assert.ok(args.some(arg => arg.endsWith(':/home/node/workspace:ro')));
        assert.ok(piArgs(args).includes('--no-tools') && piArgs(args).includes('--no-session'));
        assert.equal(piArgs(args).includes('--tools'), false);
        assert.equal(PI_MCP_CONFIG_ENV in (options.extraEnvVars as Record<string, string>), false);
        assert.match(String(options.stdinData), /Summarize this change[\s\S]*Do not run any commands/);
    });

    test('the repository scout gets only the scout MCP tools, on the repository root, with the generated mcp.json', async () => {
        const result = await createAgent().analyze('Find callers', {
            executionType: 'pr-review-context-scout', readOnlyWorkspacePath: workspace, allowReadOnlyCommands: true, responseFormat: 'json',
            repository: 'integry/propr', suppressLlmLog: true, skipUsageTracking: true,
        });
        assert.equal(result.success, true);
        assert.equal(result.response, 'FINAL ANSWER');
        const { args, options } = lastRun();
        assert.ok(args.includes(`${workspace}:${REPOSITORY_SCOUT_CONTAINER_ROOT}:ro`));
        assert.equal(args.some(arg => arg.includes(':/home/node/workspace')), false, 'nothing is mounted at the working directory');
        const pi = piArgs(args);
        assert.ok(pi.includes('--no-builtin-tools') && pi.includes('--no-extensions') && pi.includes('--no-skills') && pi.includes('--no-approve'));
        assert.equal(pi.includes('--no-tools'), false);
        const env = options.extraEnvVars as Record<string, string>;
        assert.deepEqual(Object.keys(JSON.parse(env[PI_MCP_CONFIG_ENV]).mcpServers), ['propr_repository']);
        assert.equal('GH_TOKEN' in env, false, 'the scout is credential-free');
        assert.match(String(options.stdinData), /Use only the repository file read, glob, and text search tools/);
    });

    test('the analysis result reuses the JSON parser: final text, session and summed usage', async () => {
        nextResult = { stdout: TASK_FIXTURE };
        const result = await createAgent().analyze('Plan this', { suppressLlmLog: true, skipUsageTracking: true });
        assert.equal(result.success, true);
        assert.ok(result.response.length > 0);
        assert.equal(result.sessionId, '01a21d71-9198-74eb-978e-565639986934');
        assert.ok((result.tokenUsage?.input_tokens ?? 0) > 0);
    });

    test('a provider error that Pi exits 0 on, an empty answer, an unsettled run or a timeout fails the analysis', async () => {
        const providerError = SCOUT_FIXTURE.replace(/"stopReason":"stop"/g, '"stopReason":"error","errorMessage":"401 Unauthorized"');
        for (const [name, run, error] of [
            ['provider error', { stdout: providerError }, /401 Unauthorized/],
            ['empty answer', { stdout: SCOUT_FIXTURE.replaceAll('FINAL ANSWER', '') }, /empty response/],
            ['unsettled', { stdout: SCOUT_FIXTURE.split('\n').filter(line => !line.includes('agent_settled')).join('\n'), exitCode: 1, stderr: 'boom' }, /before settling: boom/],
            ['timeout', { stdout: SCOUT_FIXTURE, timedOut: true }, /timed out/],
        ] as const) {
            nextResult = run;
            const result = await createAgent().analyze('Review', { suppressLlmLog: true, skipUsageTracking: true });
            assert.equal(result.success, false, name);
            assert.equal(result.response, '', name);
            assert.match(result.error ?? '', error, name);
        }
    });
});

describe('PiAgent.executeTask tool policy', () => {
    function taskOptions(overrides: Partial<AgentTaskOptions> = {}): AgentTaskOptions {
        return { worktreePath: workspace, issueRef: { repoOwner: 'integry', repoName: 'propr', number: 3833 }, prompt: 'Run the automation', model: MODEL, repositoryAccess: 'none', taskId: 'task-3833', ...overrides } as AgentTaskOptions;
    }

    test('the ProPR MCP server reaches Pi through the generated mcp.json, with its token by name only', async () => {
        nextResult = { stdout: TASK_FIXTURE };
        const agent = createAgent();
        (agent as unknown as { persistTaskLog: () => Promise<void> }).persistTaskLog = async () => undefined;
        const toolPolicy = { allowWeb: false, dockerNetwork: 'propr_default', mcpServers: [{ name: 'propr', url: 'http://api:4000/api/mcp', bearerTokenEnv: 'PROPR_MCP_BEARER_TOKEN', bearerToken: TOKEN }] };
        await agent.executeTask(taskOptions({ toolPolicy }));
        const { args, options } = lastRun();
        const env = options.extraEnvVars as Record<string, string>;
        assert.deepEqual(JSON.parse(env[PI_MCP_CONFIG_ENV]), { mcpServers: { propr: { url: 'http://api:4000/api/mcp', headers: { Authorization: 'Bearer ${PROPR_MCP_BEARER_TOKEN}' } } } });
        assert.equal(env.PROPR_MCP_BEARER_TOKEN, TOKEN);
        assert.equal(args.join(' ').includes(TOKEN), false);
        assert.equal(args[args.indexOf('--network') + 1], 'propr_default');
        assert.equal(options.extensionAgentLaunch, false, 'no extension request, no extension launch fence');
        assert.match(String(options.stdinData), /web access is not allowed/, 'Pi has no web switch: the restriction is a prompt notice');
    });

    test('a run without a tool policy keeps the bridge network and writes no mcp.json', async () => {
        nextResult = { stdout: TASK_FIXTURE };
        const agent = createAgent();
        (agent as unknown as { persistTaskLog: () => Promise<void> }).persistTaskLog = async () => undefined;
        await agent.executeTask(taskOptions());
        const { args, options } = lastRun();
        assert.equal(PI_MCP_CONFIG_ENV in (options.extraEnvVars as Record<string, string>), false);
        assert.equal(args[args.indexOf('--network') + 1], 'bridge');
    });

    test('explicitly added extensions without an isolated task run are refused before any launch', async () => {
        await assert.rejects(createAgent().executeTask(taskOptions({ taskId: undefined, extensions: { autoApply: false, servers: ['docs'], skills: [] } })), /isolated task run/);
        assert.equal(runs.length, 0);
    });

});
