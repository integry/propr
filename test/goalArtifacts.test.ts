import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverRepositoryArtifacts, validateGoalArtifacts } from '../packages/core/src/goals/goalArtifacts.ts';

test('goal artifacts are repository-scoped and final PR identity is branch/base/draft fenced', async () => {
  const output = [
    'Issue https://github.com/acme/widget/issues/8',
    'PR https://github.com/acme/widget/pull/7',
    'Unrelated https://github.com/other/widget/pull/99',
  ].join('\n');
  assert.deepEqual(discoverRepositoryArtifacts('acme/widget', output).map(item => item.number), [8, 7]);

  const octokit = {
    async request(route: string, params: Record<string, unknown>) {
      if (route.endsWith('/issues/{issue_number}')) {
        return { data: { number: params.issue_number, html_url: `https://github.com/acme/widget/issues/${params.issue_number}`, state: 'open' } };
      }
      if (route.endsWith('/pulls/{pull_number}')) {
        return { data: { number: params.pull_number, html_url: `https://github.com/acme/widget/pull/${params.pull_number}`, state: 'open', draft: false } };
      }
      if (route.endsWith('/pulls')) {
        assert.equal(params.head, 'acme:goal/native-transport');
        assert.equal(params.base, 'main');
        return { data: [
          { number: 9, html_url: 'https://github.com/acme/widget/pull/9', state: 'open', draft: true, merged_at: null, head: { ref: 'goal/native-transport' }, base: { ref: 'main' } },
          { number: 10, html_url: 'https://github.com/acme/widget/pull/10', state: 'open', draft: false, merged_at: null, head: { ref: 'goal/native-transport' }, base: { ref: 'main' } },
          { number: 11, html_url: 'https://github.com/acme/widget/pull/11', state: 'open', draft: true, merged_at: null, head: { ref: 'different' }, base: { ref: 'main' } },
        ] };
      }
      throw new Error(`Unexpected route ${route}`);
    },
  };
  const result = await validateGoalArtifacts({
    context: { repository: 'acme/widget', branchName: 'goal/native-transport', baseBranch: 'main' },
    existing: [
      { type: 'pull_request', number: 99, url: 'https://github.com/other/widget/pull/99' },
      { type: 'issue', number: 0, url: 'https://github.com/acme/widget/issues/0' },
    ],
    output,
    octokit: octokit as never,
  });

  assert.equal(result.finalPr?.number, 9);
  assert.deepEqual(result.artifacts.map(item => `${item.type}:${item.number}`), [
    'issue:8', 'pull_request:7', 'pull_request:9',
  ]);
  assert.deepEqual(result.stats, { issues: 1, openIssues: 1, pullRequests: 2, openPullRequests: 2 });
});

test('goal completion has no final PR when no exact open draft matches the saved branch', async () => {
  const octokit = {
    async request(route: string) {
      if (route.endsWith('/pulls')) {
        return { data: [
          { number: 12, html_url: 'https://github.com/acme/widget/pull/12', state: 'open', draft: false, merged_at: null, head: { ref: 'goal/native-transport' }, base: { ref: 'main' } },
        ] };
      }
      throw new Error(`Unexpected route ${route}`);
    },
  };
  const result = await validateGoalArtifacts({
    context: { repository: 'acme/widget', branchName: 'goal/native-transport', baseBranch: 'main' },
    existing: [],
    output: 'Provider claimed success with https://github.com/other/widget/pull/99',
    octokit: octokit as never,
  });
  assert.equal(result.finalPr, undefined);
  assert.deepEqual(result.artifacts, []);
});
