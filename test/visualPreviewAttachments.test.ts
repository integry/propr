import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const [{ db }, {
  publishPullRequestCommentVisualPreviews,
  publishPullRequestVisualPreviews
}] = await Promise.all([
  import('@propr/core'),
  import('../src/github/visualPreviewAttachments.js')
]);

after(async () => {
  await db.destroy();
});

const evidence = {
  assets: [{
    relativePath: '.propr/previews/desktop.png',
    absolutePath: '/worktree/.propr/previews/desktop.png',
    type: 'image' as const,
    title: 'Desktop settings'
  }],
  toolSuggestions: []
};

test('edits a pull request with uploaded visual preview attachments', async () => {
  let invocation: { args: string[]; authToken: string; cwd: string } | undefined;

  await publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    commitHash: 'abc123',
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    runCommand: async options => {
      invocation = options;
      return { stdout: '' };
    }
  });

  assert.ok(invocation);
  assert.deepEqual(invocation.args.slice(0, 6), ['pr', 'edit', '42', '--repo', 'integry/propr', '--body']);
  assert.match(invocation.args[6], /!\[Desktop settings\]\(\/worktree\/\.propr\/previews\/desktop\.png\)/);
  assert.deepEqual(invocation.args.slice(-2), ['--attach', '/worktree/.propr/previews/desktop.png']);
  assert.equal(invocation.authToken, 'installation-token');
  assert.equal(invocation.args.includes('installation-token'), false);
});

test('publishes an attached completion comment before removing the transient work comment', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const published = await publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    commitHash: 'abc123',
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        return { data: { body: 'Follow-up complete with uploaded URL' } } as T;
      }
    },
    runCommand: async () => ({ stdout: 'https://github.com/integry/propr/pull/42#issuecomment-200' })
  });

  assert.deepEqual(published, {
    html_url: 'https://github.com/integry/propr/pull/42#issuecomment-200',
    body: 'Follow-up complete with uploaded URL'
  });
  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}/issues/comments/{comment_id}',
    'DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}'
  ]);
  assert.equal(requests[1].options.comment_id, 100);
});

test('removes a partially published attachment comment before surfacing upload failure', async () => {
  const deletedCommentIds: unknown[] = [];
  await assert.rejects(() => publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    commitHash: 'abc123',
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(_endpoint: string, options: Record<string, unknown>) => {
        deletedCommentIds.push(options.comment_id);
        return {} as T;
      }
    },
    runCommand: async () => {
      throw Object.assign(new Error('one attachment failed'), {
        stdout: 'https://github.com/integry/propr/pull/42#issuecomment-201'
      });
    }
  }), /one attachment failed/);

  assert.deepEqual(deletedCommentIds, [201]);
});
