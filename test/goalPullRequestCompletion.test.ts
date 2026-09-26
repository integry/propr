import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  buildCompletedGoalPullRequestBody,
  updateCompletedGoalPullRequest,
} from '../src/jobs/goalPullRequestCompletion.ts';

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
});

const goal = {
  goal_id: 'goal-1',
  repository: 'acme/repo',
  objective: 'Ship the polished settings screen',
  branch_name: 'goal/polished-settings',
};

const result = {
  success: true,
  logs: '',
  summary: 'Implemented the focused settings layout.\nChanges are uncommitted.\n.propr/previews/desktop.png',
  modifiedFiles: ['src/settings.ts', 'src/settings.test.ts'],
  cost: 1.25,
  modelUsed: 'gpt-5.6',
  executionTimeMs: 65_000,
  tokenUsage: { input_tokens: 1_200, output_tokens: 300 },
};

test('completed goal PR body summarizes work and execution stats', () => {
  const body = buildCompletedGoalPullRequestBody(goal, result);

  assert.match(body, /^## Goal Implementation Summary/);
  assert.match(body, /Implemented the focused settings layout\./);
  assert.doesNotMatch(body, /uncommitted/i);
  assert.doesNotMatch(body, /\.propr\/previews/);
  assert.match(body, /## Files Changed/);
  assert.match(body, /`src\/settings\.ts`/);
  assert.match(body, /\* \*\*Model:\*\* GPT 5 6/);
  assert.match(body, /\* \*\*Time:\*\* 1m 5s/);
  assert.match(body, /\* \*\*Tokens:\*\* 1,500 \(1,200 in \/ 300 out\)/);
  assert.match(body, /\* \*\*Cost:\*\* \$1\.25/);
  assert.match(body, /\* \*\*Files changed:\*\* 2/);
});

test('completed goal PR update preserves previews already published during execution', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const retries: string[] = [];
  const existingPreview = [
    '<!-- propr-visual-preview -->',
    '## Visual preview',
    '',
    '### Updated settings',
    '![Updated settings](https://github.com/user-attachments/assets/preview)',
  ].join('\n');
  const octokit = {
    request: async (endpoint: string, options: Record<string, unknown>) => {
      requests.push({ endpoint, options });
      if (endpoint.startsWith('GET ')) return { data: { body: `Draft body\n\n---\n\n${existingPreview}` } };
      return { data: {} };
    },
  };

  await updateCompletedGoalPullRequest(goal, 42, result, {
    getOctokit: async () => octokit as never,
    retry: async (operation, operationName) => {
      retries.push(operationName);
      return operation();
    },
  });

  assert.deepEqual(retries, ['get_completed_goal_pr_42', 'update_completed_goal_pr_42']);
  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
  ]);
  const updatedBody = String(requests[1].options.body);
  assert.match(updatedBody, /^## Goal Implementation Summary/);
  assert.match(updatedBody, /https:\/\/github\.com\/user-attachments\/assets\/preview/);
  assert.equal(updatedBody.match(/<!-- propr-visual-preview -->/g)?.length, 1);
  assert.doesNotMatch(updatedBody, /Draft body/);
});
