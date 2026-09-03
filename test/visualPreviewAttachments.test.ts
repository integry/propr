import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const [{ db }, {
  publishPullRequestCommentVisualPreviews,
  publishPullRequestVisualPreviews,
  resolveVisualPreviewUploadToken
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

test('resolves the dedicated visual preview upload credential', () => {
  assert.equal(resolveVisualPreviewUploadToken({
    GITHUB_VISUAL_PREVIEW_TOKEN: '  gho_preview-token  '
  }), 'gho_preview-token');
});

test('explains why the GitHub App credential cannot be used for attachments', () => {
  assert.throws(
    () => resolveVisualPreviewUploadToken({}),
    /GitHub App installation tokens cannot upload attachments/
  );
});

test('edits a pull request with uploaded visual preview attachments', async () => {
  let invocation: { args: string[]; authToken: string; cwd: string } | undefined;
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];

  await publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        return { data: { body: '![Desktop settings](https://github.com/user-attachments/assets/asset-id)' } } as T;
      }
    },
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
  assert.deepEqual(requests.map(request => request.endpoint), ['GET /repos/{owner}/{repo}/pulls/{pull_number}']);
});

test('rejects a pull request upload when GitHub leaves a local path in the body', async () => {
  await assert.rejects(() => publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    octokit: {
      request: async <T>() => ({ data: { body: '![Desktop settings](/worktree/.propr/previews/desktop.png)' } }) as T
    },
    runCommand: async () => ({ stdout: '' })
  }), /did not replace a local visual preview path/);
});

test('publishes an attached completion comment before removing the transient work comment', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const published = await publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
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

test('deletes an uploaded comment whose fetched body still contains a local path', async () => {
  const deletedCommentIds: unknown[] = [];
  await assert.rejects(() => publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Follow-up complete',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        if (endpoint.startsWith('GET ')) {
          return { data: { body: '![Desktop settings](/worktree/.propr/previews/desktop.png)' } } as T;
        }
        deletedCommentIds.push(options.comment_id);
        return {} as T;
      }
    },
    runCommand: async () => ({ stdout: 'https://github.com/integry/propr/pull/42#issuecomment-202' })
  }), /did not replace a local visual preview path/);

  assert.deepEqual(deletedCommentIds, [202]);
});
