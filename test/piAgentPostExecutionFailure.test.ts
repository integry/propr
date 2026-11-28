import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The container run is replaced by the recorded Pi 1.6.1 trace; every other export stays real.
const FIXTURE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/pi/pi-1.6.1-json-tool-task.jsonl'), 'utf8');
const realDockerExecutor = await import('../packages/core/src/claude/docker/dockerExecutor.js');
let piRuns = 0;
let failNextRun = false;
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: {
    ...realDockerExecutor,
    executeDockerCommand: async (command: string) => {
        if (command === 'docker') piRuns += 1;
        if (command === 'docker' && failNextRun) { failNextRun = false; throw new Error('docker daemon unavailable'); }
        return { stdout: command === 'docker' ? FIXTURE : '', stderr: '', exitCode: 0, timedOut: false };
    },
} });

const { PiAgent } = await import('../packages/core/src/agents/impl/PiAgent.js');
const { failedExecutionResult } = await import('../packages/core/src/agents/impl/utils/failedAgentExecution.js');
const { parsePiOutput } = await import('../packages/core/src/agents/impl/utils/piOutputParser.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
type AgentExecutionResult = import('../packages/core/src/agents/types.js').AgentExecutionResult;
type AgentTaskOptions = import('../packages/core/src/agents/types.js').AgentTaskOptions;

after(async () => {
    await closeConnection();
});

const MODEL = 'pi-openrouter/mistralai/devstral-2512';
const PARSED = parsePiOutput(FIXTURE);
const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pi-post-exec-'));
after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));

function createAgent(persist: (response: AgentExecutionResult) => Promise<void>) {
    const agent = new PiAgent({
        id: 'pi-test', type: 'pi', alias: 'pi-test', enabled: true, dockerImage: 'propr/agent:latest',
        configPath: '/nonexistent/propr-pi-test/agent', supportedModels: [MODEL], defaultModel: MODEL,
    });
    // The log store is the caller's concern here: capture what the agent would write.
    (agent as unknown as { persistTaskLog: typeof persist }).persistTaskLog = persist;
    return agent;
}

function taskOptions(overrides: Partial<AgentTaskOptions> = {}): AgentTaskOptions {
    return {
        worktreePath, issueRef: { repoOwner: 'integry', repoName: 'propr', number: 3832 }, prompt: 'add subtract(a, b)',
        model: MODEL, reasoningLevel: 'high', repositoryAccess: 'none', taskId: 'task-3832', ...overrides,
    } as AgentTaskOptions;
}

function assertKeepsRun(result: AgentExecutionResult, error: string) {
    assert.equal(result.success, false);
    assert.equal(result.error, error);
    assert.equal(result.sessionId, PARSED.sessionId);
    assert.deepEqual(result.tokenUsage, PARSED.tokenUsage);
    assert.ok(PARSED.costUsd !== undefined);
    assert.equal(result.cost, PARSED.costUsd);
    assert.equal(result.providerCostUsd, PARSED.costUsd, 'the provider cost still replaces ProPR pricing');
    assert.deepEqual(result.conversationLog, PARSED.conversationLog);
    assert.equal(result.providerModel, 'openrouter/mistralai/devstral-2512');
    assert.equal(result.modelUsed, MODEL);
    assert.equal(result.reasoningLevel, 'high');
    assert.equal(result.prompt?.includes('add subtract(a, b)'), true);
    assert.ok(result.executionId);
}

describe('Pi run that fails after the container finished', () => {
    beforeEach(() => { piRuns = 0; });

    test('a rejecting session callback keeps the run and still writes its log row, failed', async () => {
        const written: AgentExecutionResult[] = [];
        const agent = createAgent(async response => { written.push(response); });
        const result = await agent.executeTask(taskOptions({ onSessionId: async () => { throw new Error('session store unavailable'); } }));

        assert.equal(piRuns, 1);
        assertKeepsRun(result, 'session store unavailable');
        assert.equal(written.length, 1, 'the log row the callback skipped is written once');
        assert.equal(written[0], result);
    });

    test('a failing log write keeps the run in the returned result', async () => {
        let attempts = 0;
        const agent = createAgent(async () => { attempts += 1; throw new Error('llm_logs insert failed'); });
        const result = await agent.executeTask(taskOptions());

        assertKeepsRun(result, 'llm_logs insert failed');
        assert.ok(attempts >= 1);
    });

    test('a run that throws before Pi produced output keeps the prompt and writes no run row', async () => {
        const written: AgentExecutionResult[] = [];
        const agent = createAgent(async response => { written.push(response); });
        failNextRun = true;
        const result = await agent.executeTask(taskOptions());

        assert.equal(result.success, false);
        assert.equal(result.error, 'docker daemon unavailable');
        assert.equal(result.tokenUsage, undefined);
        assert.equal(result.providerCostUsd, undefined);
        assert.equal(result.sessionId, undefined);
        assert.equal(result.prompt?.includes('add subtract(a, b)'), true);
        assert.equal(written.length, 0);
    });
});

describe('shared failed-execution result', () => {
    test('keeps a completed run\'s provider cost', () => {
        const completed = { success: true, executionTimeMs: 1, modelUsed: MODEL, modifiedFiles: [], commitMessage: null, cost: 0.002, providerCostUsd: 0.002 } as AgentExecutionResult;
        const failed = failedExecutionResult(new Error('later step failed'), { completed, model: MODEL, executionTimeMs: 5 });
        assert.equal(failed.providerCostUsd, 0.002);
        assert.equal(failed.cost, 0.002);
        assert.equal(failedExecutionResult(new Error('no run'), { model: MODEL, executionTimeMs: 5 }).providerCostUsd, undefined);
    });
});
