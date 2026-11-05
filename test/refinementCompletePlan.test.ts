import { after, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';

const llmResponses: string[] = [];
const prompts: string[] = [];
const runLightweightLLMAnalysis = mock.fn(async ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
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
    namedExports: { ...configuredModel, resolveConfiguredModel: async (model: string) => model },
});
const routingSession = { select: async () => ({ physicalAgentAlias: 'codex', physicalModel: 'gpt-6-astra' }), fork() { return routingSession; } };
const agentRegistry = await import('../packages/core/src/agents/AgentRegistry.js');
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        ...agentRegistry,
        AgentRegistry: { getInstance: () => ({ ensureInitialized: async () => undefined, beginRoutingSession: () => routingSession }) },
    },
});

const { refinePlan, incompletePlanItems } = await import('../packages/core/src/services/taskPlanning/refinement.js');
const { closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => { await closeConnection(); });

const issue = (title: string) => ({ title, body: `${title} body`, implementation: `${title} implementation` });
const currentPlan = [issue('Operation lifecycle'), issue('Submission progress'), issue('Optional expectedHead')];
const options = { currentPlan, instruction: 'Add task media retrieval', worktreePath: '/tmp', repository: 'integry/propr', githubToken: 't', draftId: 'draft-1' };
// What the broken refinement actually returned: edits, not a plan.
const edits = JSON.stringify({
    action: 'modified',
    summary: 'Added media retrieval',
    changes: [
        { number: 1, action: 'extend', scope: 'media references', requirements: ['...'] },
        { number: 3, action: 'retain', instruction: 'issue 3 remains unchanged' },
    ],
});
const editsAsPlan = JSON.stringify({
    action: 'modified',
    summary: 'Added media retrieval',
    plan: [{ number: 1, action: 'extend', scope: 'media' }, { number: 2, action: 'retain', instruction: 'unchanged' }, issue('Media retrieval')],
});

beforeEach(() => {
    llmResponses.length = 0;
    prompts.length = 0;
    runLightweightLLMAnalysis.mock.resetCalls();
});

describe('plan refinement returns complete plans only', () => {
    test('identifies entries that are not complete issues', () => {
        assert.deepEqual(incompletePlanItems([issue('a'), { number: 2, action: 'retain' }, { title: 'x', body: ' ', implementation: 'y' }, null]), [2, 3, 4]);
        assert.deepEqual(incompletePlanItems(currentPlan), []);
    });

    test('asks once for the full plan when the model returns edits, and uses it', async () => {
        const refined = [...currentPlan, issue('Media retrieval')];
        llmResponses.push(editsAsPlan, JSON.stringify({ action: 'modified', summary: 'Added media retrieval', plan: refined }));
        const result = await refinePlan(options);
        assert.deepEqual(result.plan, refined);
        assert.equal(result.action, 'modified');
        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 2);
        assert.match(prompts[1], /EVERY issue of the refined plan in full/);
        assert.match(prompts[1], /Operation lifecycle body/, 'the repair sees the current plan');
    });

    test('fails and leaves the plan alone when the full plan never arrives', async () => {
        llmResponses.push(editsAsPlan, editsAsPlan);
        await assert.rejects(refinePlan(options), /mixed complete tasks with edit operations/);
    });

    test('merges a valid edit list without asking the model to repeat the plan', async () => {
        llmResponses.push(JSON.stringify({
            action: 'modified',
            summary: 'Added media retrieval',
            plan: [
                { action: 'retain', index: 0 },
                { action: 'extend', index: 1, body: 'More submission detail' },
                { action: 'add', ...issue('Media retrieval') },
            ],
        }));

        const result = await refinePlan(options);

        assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
        assert.equal(result.merged, true);
        assert.equal(result.operations, 3);
        assert.match(result.summary, /^Applied 3 edits to the existing plan\./);
        assert.deepEqual(result.plan.map(task => task.title), [
            'Operation lifecycle', 'Submission progress', 'Optional expectedHead', 'Media retrieval',
        ]);
        assert.equal(result.plan[1].body, 'Submission progress body\n\nMore submission detail');
    });

    test('a `changes` list is never taken for the plan', async () => {
        llmResponses.push(edits);
        await assert.rejects(refinePlan(options), /not a valid array/);
    });

    for (const action of ['answered', 'clarify'] as const) {
        test(`${action} keeps the current plan whatever came back`, async () => {
            llmResponses.push(JSON.stringify({ action, summary: 'It covers three areas.', plan: [{ number: 1, action: 'retain' }] }));
            const result = await refinePlan(options);
            assert.equal(result.action, action);
            assert.deepEqual(result.plan, currentPlan);
            assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
        });

        test(`${action} keeps an incomplete current plan without a repair call`, async () => {
            const incomplete = [{ title: 'Add metrics', body: 'Emit counters' }];
            llmResponses.push(JSON.stringify({ action, summary: 'Use a counter.', plan: [issue('Unrequested change')] }));
            const result = await refinePlan({ ...options, currentPlan: incomplete });
            assert.equal(result.action, action);
            assert.deepEqual(result.plan, incomplete);
            assert.equal(result.merged, false);
            assert.equal(runLightweightLLMAnalysis.mock.callCount(), 1);
        });

        test(`${action} during repair also preserves an incomplete current plan`, async () => {
            const incomplete = [{ title: 'Add metrics', body: 'Emit counters' }];
            llmResponses.push(editsAsPlan, JSON.stringify({ action, summary: 'Use a counter.', plan: incomplete }));
            const result = await refinePlan({ ...options, currentPlan: incomplete });
            assert.equal(result.action, action);
            assert.deepEqual(result.plan, incomplete);
            assert.equal(runLightweightLLMAnalysis.mock.callCount(), 2);
        });

        for (const [description, plan] of [
            ['a different complete plan', [issue('Unrequested replacement')]],
            ['an incomplete plan', [{ number: 1, action: 'retain' }]],
        ] as const) {
            test(`${action} from completeness repair keeps the current plan when returning ${description}`, async () => {
                const summary = action === 'answered' ? 'It covers three areas.' : 'Which area should change?';
                llmResponses.push(editsAsPlan, JSON.stringify({ action, summary, plan }));

                const result = await refinePlan(options);

                assert.equal(result.action, action);
                assert.equal(result.summary, summary);
                assert.deepEqual(result.plan, currentPlan);
                assert.equal(runLightweightLLMAnalysis.mock.callCount(), 2);
            });
        }
    }
});
