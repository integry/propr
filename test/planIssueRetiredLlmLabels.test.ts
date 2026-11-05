import { after, test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const core = await import('@propr/core');
const mockQueueAdd = mock.fn(async () => undefined);
const mockUpdatePlanIssue = mock.fn(async () => null);
await mock.module('@propr/core', {
  namedExports: {
    ...core,
    getIssueQueue: async () => ({ add: mockQueueAdd }),
    updatePlanIssue: mockUpdatePlanIssue
  }
});

const { getAttachedLlmLabels, handleMultiAgentImplementation } = await import('../packages/api/routes/planIssueHelpers.ts');

after(async () => {
  await core.closeConnection();
});

const RETIRED_MODEL = 'opencode-muse-spark-1.3-contributor-free';
const RETIRED_LABEL = 'llm-opencode-muse-spark13-free';

function createOctokit() {
  const removed: string[] = [];
  const added: string[] = [];
  const request = mock.fn(async (route: string, params: { name?: string; labels?: string[] }) => {
    if (route.startsWith('DELETE')) removed.push(params.name!);
    if (route.startsWith('POST')) added.push(...params.labels!);
    return { data: [] };
  });
  return { octokit: { request } as never, removed, added };
}

const labelLogger = core.logger.withCorrelation('retired-llm-labels-test');

test('getAttachedLlmLabels includes the label a retired OpenCode model was published under', async () => {
  assert.deepStrictEqual(await getAttachedLlmLabels(RETIRED_MODEL), ['llm-opencode-big-pickle', RETIRED_LABEL]);
  assert.deepStrictEqual(await getAttachedLlmLabels('opencode/muse-spark-1.3-contributor-free'), ['llm-opencode-big-pickle', RETIRED_LABEL]);
  assert.deepStrictEqual(await getAttachedLlmLabels('opencode-big-pickle'), ['llm-opencode-big-pickle']);
});

test('changing a retired OpenCode selection removes the retired label already on the issue', async () => {
  const { octokit, removed, added } = createOctokit();

  await handleMultiAgentImplementation({
    octokit, owner: 'owner', repo: 'repo', issueNumber: 7, userId: 'user-1',
    implementLabel: 'AI', epicLabelName: null, autoMerge: false, labelLogger,
    draftId: 'draft-1',
    planIssue: { agent_alias: null, model_name: RETIRED_MODEL },
    models: [{ agent_alias: null as never, model_name: 'gpt-5.6-sol' }]
  });

  assert.ok(removed.includes(RETIRED_LABEL), `removed ${JSON.stringify(removed)}`);
  assert.ok(removed.includes('llm-opencode-big-pickle'));
  assert.ok(!added.some(label => label.startsWith('llm-opencode')), `added ${JSON.stringify(added)}`);
});

test('selecting the successor of a retired OpenCode model keeps the successor and removes the retired label', async () => {
  const { octokit, removed, added } = createOctokit();

  await handleMultiAgentImplementation({
    octokit, owner: 'owner', repo: 'repo', issueNumber: 8, userId: 'user-1',
    implementLabel: 'AI', epicLabelName: null, autoMerge: false, labelLogger,
    draftId: 'draft-1',
    planIssue: { agent_alias: null, model_name: RETIRED_MODEL },
    models: [{ agent_alias: null as never, model_name: 'opencode-big-pickle' }]
  });

  assert.ok(removed.includes(RETIRED_LABEL), `removed ${JSON.stringify(removed)}`);
  assert.ok(!removed.includes('llm-opencode-big-pickle'));
  assert.ok(added.includes('llm-opencode-big-pickle'));
});
