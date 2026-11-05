import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const llmResponses: (string | Error)[] = [];
const runLightweightLLMAnalysis = mock.fn(async () => {
    const next = llmResponses.shift();
    if (next === undefined) throw new Error('no scripted LLM response left');
    if (next instanceof Error) throw next;
    return next;
});
const claudeService = await import('../packages/core/src/claude/claudeService.js');
await mock.module('../packages/core/src/claude/claudeService.js', { namedExports: { ...claudeService, runLightweightLLMAnalysis } });

type RepairCall = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let repairResult: unknown = undefined;
const runPlanFileAgent = mock.fn(async (_options: RepairCall) => {
    if (repairResult instanceof Error) throw repairResult;
    return repairResult;
});
const planFileAgent = await import('../packages/core/src/services/taskPlanning/planFileAgent.js');
await mock.module('../packages/core/src/services/taskPlanning/planFileAgent.js', { namedExports: { ...planFileAgent, runPlanFileAgent } });

const estimation = await import('../packages/core/src/utils/llmEstimation.js');
await mock.module('../packages/core/src/utils/llmEstimation.js', {
    namedExports: { ...estimation, estimateLlmDuration: async () => ({ estimatedDurationMs: 1000, isHistoricalEstimate: false, sampleCount: 0 }) },
});
const configManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: { ...configManager, loadSettings: async () => ({ planner_generation_model: 'codex:gpt-6-astra' }) },
});
const configuredModel = await import('../packages/core/src/config/configuredModel.js');
let defaultModelError: Error | undefined;
await mock.module('../packages/core/src/config/configuredModel.js', {
    // With no argument this resolves the configured default coding model.
    namedExports: {
        ...configuredModel,
        resolveConfiguredModel: async (model?: string) => {
            if (model) return model;
            if (defaultModelError) throw defaultModelError;
            return 'claude:claude-opus-5';
        },
    },
});
const routes: unknown[] = [];
const routingSession = { select: async () => ({ physicalAgentAlias: 'codex', physicalModel: 'gpt-6-astra' }), fork() { return routingSession; } };
const agentRegistry = await import('../packages/core/src/agents/AgentRegistry.js');
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        ...agentRegistry,
        AgentRegistry: {
            getInstance: () => ({
                ensureInitialized: async () => undefined,
                beginRoutingSession: (route: unknown) => { routes.push(route); return routingSession; },
            }),
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
// Unescaped quotes inside a string value: no parser pass can recover this.
const usageLimit = () => Object.assign(new Error('usage limit reached'), { name: 'UsageLimitError' });
// Edit instructions instead of a full plan trigger the complete-plan follow-up.
const incomplete = JSON.stringify({ action: 'modified', summary: 'Edits', plan: [{ number: 1, action: 'retain' }] });
const broken = `Here is the refined plan:\n{\n  "action": "modified",\n  "summary": "Removed the "JSON" backend",\n  "plan": ${JSON.stringify(refined)}\n}\n`;

beforeEach(() => {
    llmResponses.length = 0;
    routes.length = 0;
    repairResult = undefined;
    defaultModelError = undefined;
    runLightweightLLMAnalysis.mock.resetCalls();
    runPlanFileAgent.mock.resetCalls();
});

describe('plan refinement JSON repair', () => {
    test('repairs malformed JSON in place with the file agent, never by asking a model again', async () => {
        llmResponses.push(broken);
        repairResult = { action: 'modified', summary: 'Removed the "JSON" backend', plan: refined };

        const result = await refinePlan(options);

        assert.deepEqual(result.plan, refined);
        assert.equal(result.summary, 'Removed the "JSON" backend');
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1, 'no model call is used to repair JSON');
        assert.equal(runPlanFileAgent.mock.callCount(), 1);
        const call = runPlanFileAgent.mock.calls[0].arguments[0];
        const original = broken.slice(broken.indexOf('{'), broken.lastIndexOf('}') + 1);
        assert.equal(call.purpose, 'repair');
        assert.equal(call.document, true);
        assert.equal(call.original, original, 'the agent repairs exactly the JSON that failed to parse');
        assert.deepEqual(call.files, { 'plan.json': original, 'original.txt': original });
        assert.equal(call.model, 'claude:claude-opus-5', 'repair uses the default coding model');
        assert.equal(call.executionType, 'plan-refinement');
        assert.match(call.prompt, /validate-plan\.mjs --document/);
        assert.deepEqual(routes.at(-1), { requestedAgentAlias: 'claude', requestedModel: 'claude-opus-5' });
    });

    test('parses recoverable JSON without starting a repair', async () => {
        llmResponses.push(`{\n  "action": "modified",\n  "summary": "Line one.\n\nLine two",\n  "plan": ${JSON.stringify(refined)}\n}`);
        const result = await refinePlan(options);
        assert.equal(result.summary, 'Line one.\n\nLine two');
        assert.equal(runPlanFileAgent.mock.callCount(), 0);
    });

    test('fails and keeps the plan when the in-place repair fails', async () => {
        llmResponses.push(broken);
        repairResult = new Error('Plan repair did not produce a valid plan: plan.json does not match original.txt');
        await assert.rejects(refinePlan(options), /in-place repair failed: Plan repair did not produce a valid plan/);
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
    });

    test('does not start a repair when the response holds no JSON at all', async () => {
        llmResponses.push('I could not refine this plan.');
        await assert.rejects(refinePlan(options), /Failed to parse refined plan: No JSON object or array/);
        assert.equal(runPlanFileAgent.mock.callCount(), 0);
    });

    test('parses a single-quoted task array with literal newlines without a repair', async () => {
        llmResponses.push("[{'title':'History store','body':'line one\nline two','implementation':'c'},{'title':'Trend chart','body':'b','implementation':'i'}]");
        const result = await refinePlan(options);
        assert.equal(result.plan[0].body, 'line one\nline two');
        assert.equal(runPlanFileAgent.mock.callCount(), 0);
    });

    test('fails without starting an agent when the validator cannot read the original', async () => {
        // A truncated document: no repair of it could pass validation.
        llmResponses.push(`{"action": "modified", "summary": "Cut "short", "plan": [{"title": "A"}`);
        await assert.rejects(refinePlan(options), /cannot be repaired in place: original\.txt: cannot establish original content/);
        assert.equal(runPlanFileAgent.mock.callCount(), 0);
    });

    test('salvages an answer the model started over with the file agent', async () => {
        const response = JSON.stringify({ action: 'modified', summary: 'Dropped the JSON backend', plan: refined }, null, 2);
        // Cut off mid-string, then restarted with a reworded summary.
        const spliced = response.slice(0, response.indexOf('history store')) + response.replace('Dropped the JSON backend', 'Dropped the JSON history file');
        llmResponses.push(spliced);
        repairResult = JSON.parse(response.replace('Dropped the JSON backend', 'Dropped the JSON history file'));

        const result = await refinePlan(options);

        assert.deepEqual(result.plan, refined);
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1, 'no model call is used to repair JSON');
        const call = runPlanFileAgent.mock.calls[0].arguments[0];
        assert.equal(call.document, true);
        assert.equal(call.salvage, true);
        assert.equal(call.original, spliced);
        assert.match(call.prompt, /started the whole answer over/);
        assert.match(call.prompt, /validate-plan\.mjs --document --salvage/);
    });

    test('reports a missing default model as a failed repair', async () => {
        llmResponses.push(broken);
        defaultModelError = Object.assign(new Error('No default model is configured'), { name: 'NoDefaultModelConfiguredError' });
        await assert.rejects(refinePlan(options), (error: Error) => {
            assert.equal(error.name, 'PlanningFailedError');
            assert.match(error.message, /in-place repair failed: No default model is configured/);
            return true;
        });
        assert.equal(runPlanFileAgent.mock.callCount(), 0);
    });

    test('does not attribute the repair to a made-up draft id', async () => {
        llmResponses.push(broken);
        repairResult = { action: 'modified', summary: 'Removed the "JSON" backend', plan: refined };
        await refinePlan({ ...options, draftId: undefined });
        assert.equal(runPlanFileAgent.mock.calls[0].arguments[0].draftId, undefined);
    });

    test('keeps a usage limit from the complete-plan follow-up repair', async () => {
        llmResponses.push(incomplete, broken);
        repairResult = usageLimit();
        await assert.rejects(refinePlan(options), { name: 'UsageLimitError' });
        assert.equal(runPlanFileAgent.mock.callCount(), 1);
    });

    test('keeps a usage limit from the complete-plan follow-up request', async () => {
        llmResponses.push(incomplete, usageLimit());
        await assert.rejects(refinePlan(options), { name: 'UsageLimitError' });
    });
});
