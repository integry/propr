import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

// Refinement repair through the real plan file agent and validator; only the agent run is faked.
const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'propr-refinement-repair-'));
process.env.PROPR_PLAN_WORKSPACE_ROOT = workspaceRoot;
after(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const llmResponses: string[] = [];
const runLightweightLLMAnalysis = mock.fn(async () => {
    const next = llmResponses.shift();
    if (next === undefined) throw new Error('no scripted LLM response left');
    return next;
});
const claudeService = await import('../packages/core/src/claude/claudeService.js');
await mock.module('../packages/core/src/claude/claudeService.js', { namedExports: { ...claudeService, runLightweightLLMAnalysis } });

const estimation = await import('../packages/core/src/utils/llmEstimation.js');
await mock.module('../packages/core/src/utils/llmEstimation.js', {
    namedExports: { ...estimation, estimateLlmDuration: async () => ({ estimatedDurationMs: 1000, isHistoricalEstimate: false, sampleCount: 0 }) },
});
const configManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: { ...configManager, loadSettings: async () => ({ planner_generation_model: 'codex:gpt-6-astra' }) },
});
const configuredModel = await import('../packages/core/src/config/configuredModel.js');
await mock.module('../packages/core/src/config/configuredModel.js', {
    namedExports: { ...configuredModel, resolveConfiguredModel: async (model?: string) => model ?? 'claude:claude-opus-5' },
});
const modelAliases = await import('../packages/core/src/config/modelAliases.js');
await mock.module('../packages/core/src/config/modelAliases.js', {
    namedExports: { ...modelAliases, resolveModelAlias: (model: string) => model },
});
const llmLogger = await import('../packages/core/src/utils/llmLogger.js');
await mock.module('../packages/core/src/utils/llmLogger.js', {
    namedExports: {
        ...llmLogger,
        buildAnalysisWorkRef: (executionType: string, taskId: string | undefined, repository: string) => ({ workType: 'plan', planDraftId: taskId, workRepository: repository, executionType }),
        withTaskLogAttribution: (metadata: Record<string, unknown>, attribution: unknown) => ({ ...metadata, proprLogAttribution: attribution }),
    },
});

type TaskOptions = { worktreePath: string; prompt: string; taskId?: string; metadata?: Record<string, unknown> };
let edit: (workspace: string) => void = () => undefined;
const agentCalls: TaskOptions[] = [];
const routingSession = {
    select: async () => ({ physicalAgentAlias: 'claude', physicalModel: 'claude-opus-5' }),
    fork() { return routingSession; },
    executeTask: async (options: TaskOptions) => {
        agentCalls.push(options);
        edit(options.worktreePath);
        return { success: true, modifiedFiles: [], logs: '', executionTimeMs: 1 };
    },
};
const agentRegistry = await import('../packages/core/src/agents/AgentRegistry.js');
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        ...agentRegistry,
        AgentRegistry: {
            getInstance: () => ({ ensureInitialized: async () => undefined, beginRoutingSession: () => routingSession }),
        },
    },
});

const { refinePlan } = await import('../packages/core/src/services/taskPlanning/refinement.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => { await closeConnection(); });

const issue = (title: string) => ({ title, body: `${title} body`, implementation: `${title} implementation` });
const currentPlan = [issue('History store'), issue('Trend chart')];
const options = { currentPlan, instruction: 'Drop the JSON backend', worktreePath: '/tmp', repository: 'integry/propr', githubToken: 't', draftId: 'draft-1' };
const refined = [issue('SQLite history store'), issue('Trend chart')];
const broken = `{\n  "action": "modified",\n  "summary": "Removed the "JSON" backend",\n  "plan": ${JSON.stringify(refined)}\n}`;
const fixed = JSON.stringify({ action: 'modified', summary: 'Removed the "JSON" backend', plan: refined });

beforeEach(() => {
    llmResponses.length = 0;
    agentCalls.length = 0;
    edit = () => undefined;
});

describe('plan refinement repair through the plan file agent', () => {
    test('accepts a syntax-only repair of the refinement document', async () => {
        edit = workspace => {
            assert.equal(readFileSync(path.join(workspace, 'plan.json'), 'utf8'), broken);
            writeFileSync(path.join(workspace, 'plan.json'), fixed);
        };
        llmResponses.push(broken);

        const result = await refinePlan(options);

        assert.deepEqual(result.plan, refined);
        assert.equal(result.summary, 'Removed the "JSON" backend');
        assert.equal(agentCalls.length, 1);
        assert.match(agentCalls[0].prompt, /validate-plan\.mjs --document/);
        assert.equal(agentCalls[0].taskId, 'draft-1');
    });

    test('rejects a content change even when the agent also edits the workspace original', async () => {
        const reworded = JSON.stringify({ action: 'modified', summary: 'Rewrote everything', plan: refined });
        edit = workspace => {
            writeFileSync(path.join(workspace, 'plan.json'), reworded);
            writeFileSync(path.join(workspace, 'original.txt'), reworded);
        };
        llmResponses.push(broken);

        await assert.rejects(refinePlan(options), /in-place repair failed: .*does not match original\.txt/);
        assert.equal(agentCalls.length, 1);
    });
});
