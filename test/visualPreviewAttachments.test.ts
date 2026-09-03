import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.PROPR_DEMO_MODE = 'true';

const [{ db }, {
  publishPullRequestCommentVisualPreviews,
  publishPullRequestVisualPreviews,
  resolveVisualPreviewUploadToken,
  isVisualPreviewUploadAuthenticationError,
  uploadVisualPreviewAsset,
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

test('resolves the dedicated visual preview upload credential', async () => {
  assert.equal(await resolveVisualPreviewUploadToken({
    GITHUB_VISUAL_PREVIEW_TOKEN: '  gho_preview-token  '
  }), 'gho_preview-token');
});

test('explains why the GitHub App credential cannot be used for attachments', async () => {
  let caught: unknown;
  try {
    await resolveVisualPreviewUploadToken({});
  } catch (error) {
    caught = error;
  }
  assert.match((caught as Error).message, /GitHub App installation tokens cannot upload attachments/);
  assert.equal(isVisualPreviewUploadAuthenticationError(caught), true);
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

test('uploads media before updating the existing work comment without creating another comment', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const uploads: Array<{ absolutePath: string; authToken: string; repositoryId: number }> = [];
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
        if (endpoint === 'GET /repos/{owner}/{repo}') {
          return { data: { id: 987 } } as T;
        }
        if (endpoint.startsWith('PATCH ')) {
          return { data: {
            html_url: 'https://github.com/integry/propr/pull/42#issuecomment-100',
            body: options.body,
          } } as T;
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }
    },
    uploadAsset: async options => {
      uploads.push(options);
      return 'https://github.com/user-attachments/assets/asset-id';
    },
  });

  assert.equal(published.html_url, 'https://github.com/integry/propr/pull/42#issuecomment-100');
  assert.match(published.body, /https:\/\/github\.com\/user-attachments\/assets\/asset-id/);
  assert.doesNotMatch(published.body, /\/worktree\/\.propr\/previews/);
  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  ]);
  assert.equal(requests[1].options.comment_id, 100);
  assert.deepEqual(uploads, [{
    absolutePath: '/worktree/.propr/previews/desktop.png',
    authToken: 'installation-token',
    repositoryId: 987,
  }]);
});

test('does not update the work comment when a direct attachment upload fails', async () => {
  const requests: string[] = [];
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
      request: async <T>(endpoint: string) => {
        requests.push(endpoint);
        return { data: { id: 987 } } as T;
      }
    },
    uploadAsset: async () => { throw new Error('attachment upload failed'); },
  }), /attachment upload failed/);

  assert.deepEqual(requests, ['GET /repos/{owner}/{repo}']);
});

test('rejects an updated work comment whose response still contains a local path', async () => {
  const requests: string[] = [];
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
        requests.push(endpoint);
        if (endpoint === 'GET /repos/{owner}/{repo}') {
          return { data: { id: 987 } } as T;
        }
        return { data: {
          html_url: 'https://github.com/integry/propr/pull/42#issuecomment-100',
          body: '![Desktop settings](/worktree/.propr/previews/desktop.png)',
          comment_id: options.comment_id,
        } } as T;
      }
    },
    uploadAsset: async () => 'https://github.com/user-attachments/assets/asset-id',
  }), /did not replace a local visual preview path/);

  assert.deepEqual(requests, [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  ]);
});

test('uploads an attachment directly to the repository-scoped GitHub endpoint', async t => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'propr-upload-test-'));
  const assetPath = path.join(temporaryDirectory, 'desktop.png');
  const assetBody = Buffer.from('preview bytes');
  await writeFile(assetPath, assetBody);
  t.after(async () => rm(temporaryDirectory, { recursive: true, force: true }));

  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://uploads.github.com');
    assert.equal(url.pathname, '/user-attachments/assets');
    assert.equal(url.searchParams.get('name'), 'desktop.png');
    assert.equal(url.searchParams.get('content_type'), 'image/png');
    assert.equal(url.searchParams.get('repository_id'), '987');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer preview-token');
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), assetBody);
    return new Response(JSON.stringify({
      url: 'https://github.com/user-attachments/assets/direct-asset-id',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  });

  assert.equal(await uploadVisualPreviewAsset({
    absolutePath: assetPath,
    authToken: 'preview-token',
    repositoryId: 987,
  }), 'https://github.com/user-attachments/assets/direct-asset-id');
});
