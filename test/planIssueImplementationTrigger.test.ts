import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const events: string[] = [];
const updatePlanIssue = mock.fn(async () => null);
const safeRemoveLabel = mock.fn(async (_context, label: string) => {
  events.push(`remove:${label}`);
  return true;
});
const safeAddLabel = mock.fn(async (_context, label: string) => {
  events.push(`add:${label}`);
  return true;
});
const safeUpdateLabels = mock.fn(async (_context, labelsToRemove: string[], labelsToAdd: string[]) => {
  events.push(`labels:remove=${labelsToRemove.join(',')};add=${labelsToAdd.join(',')}`);
  return { success: true, removed: labelsToRemove, added: labelsToAdd, errors: [] };
});

await mock.module('@propr/core', {
  namedExports: {
    getAuthenticatedOctokit: mock.fn(),
    MODEL_INFO_MAP: { 'gpt-test': { githubLabel: 'llm-codex-gpt-test' } },
    safeRemoveLabel,
    safeAddLabel,
    safeUpdateLabels,
    logger: {
      withCorrelation: () => ({ info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() }),
      warn: mock.fn(),
    },
    ensureEpicPR: mock.fn(),
    updatePlanIssue,
    PlanIssueStatus: { PROCESSING: 'processing' },
    AgentRegistry: { getInstance: mock.fn() },
    resolvePlanIssueDefaultSelection: mock.fn(),
    NoDefaultModelConfiguredError: class extends Error {},
    toProprOpenCodeModelId: (model: string) => model,
    buildDynamicLlmLabel: mock.fn(),
    buildAgentModelLlmLabel: mock.fn(),
    getIssueQueue: async () => ({
      add: async () => { events.push('enqueue'); },
    }),
    generateCorrelationId: () => 'correlation-id',
    withRetry: mock.fn(),
    retryConfigs: {},
  },
});

const { handleSingleAgentImplementation } = await import('../packages/api/routes/planIssueHelpers.js');

test('planner publishes the trigger label only after model and epic selectors', async () => {
  events.length = 0;
  updatePlanIssue.mock.resetCalls();
  safeRemoveLabel.mock.resetCalls();
  safeAddLabel.mock.resetCalls();
  safeUpdateLabels.mock.resetCalls();
  safeRemoveLabel.mock.mockImplementation(async (_context, label: string) => {
    events.push(`remove:${label}`);
    return true;
  });
  safeAddLabel.mock.mockImplementation(async (_context, label: string) => {
    events.push(`add:${label}`);
    return true;
  });
  safeUpdateLabels.mock.mockImplementation(async (_context, labelsToRemove: string[], labelsToAdd: string[]) => {
    events.push(`labels:remove=${labelsToRemove.join(',')};add=${labelsToAdd.join(',')}`);
    return { success: true, removed: labelsToRemove, added: labelsToAdd, errors: [] };
  });

  await handleSingleAgentImplementation({
    octokit: {} as never,
    owner: 'integry',
    repo: 'propr-test',
    issueNumber: 888,
    implementLabel: 'AI',
    epicLabelName: 'base-888-epic-project-version-1v8',
    autoMerge: true,
    labelLogger: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() } as never,
    draftId: 'draft-id',
    planIssue: { agent_alias: null, model_name: 'gpt-test' },
  });

  assert.deepStrictEqual(events, [
    'remove:AI',
    'labels:remove=AI-processing,AI-done;add=llm-codex-gpt-test,base-888-epic-project-version-1v8,auto-merge',
    'add:AI',
    'enqueue',
  ]);
  assert.deepStrictEqual(updatePlanIssue.mock.calls[0]?.arguments, [
    'draft-id',
    888,
    { status: 'processing', model_name: 'gpt-test' },
  ]);
});

test('planner does not publish or enqueue a partial selector update', async () => {
  events.length = 0;
  updatePlanIssue.mock.resetCalls();
  safeRemoveLabel.mock.resetCalls();
  safeAddLabel.mock.resetCalls();
  safeUpdateLabels.mock.resetCalls();
  safeUpdateLabels.mock.mockImplementationOnce(async () => ({
    success: false,
    removed: [],
    added: [],
    errors: ['failed base label'],
  }));

  await assert.rejects(
    handleSingleAgentImplementation({
      octokit: {} as never,
      owner: 'integry',
      repo: 'propr-test',
      issueNumber: 888,
      implementLabel: 'AI',
      epicLabelName: 'base-888-epic-project-version-1v8',
      autoMerge: true,
      labelLogger: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() } as never,
      draftId: 'draft-id',
      planIssue: { agent_alias: null, model_name: 'gpt-test' },
    }),
    /Failed to update implementation labels: failed base label/
  );

  assert.deepStrictEqual(events, ['remove:AI']);
  assert.strictEqual(safeAddLabel.mock.callCount(), 0);
  assert.deepStrictEqual(updatePlanIssue.mock.calls, []);
});
