import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { PreviewArtifactV1 } from '@propr/shared';

process.env.PROPR_DEMO_MODE = 'true';

const [{ db }, { storeManagedVisualPreviewOriginals }, {
  publishPullRequestCommentVisualPreviews,
  publishPullRequestVisualPreviews,
  resolveVisualPreviewUploadToken,
  isVisualPreviewUploadAuthenticationError,
  uploadVisualPreviewAsset,
}] = await Promise.all([
  import('@propr/core'),
  import('../src/github/managedVisualPreviewStorage.js'),
  import('../src/github/visualPreviewAttachments.js')
]);

after(async () => {
  await db.destroy();
  await rm(fixtureDirectory, { recursive: true, force: true });
});

const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'propr-attachment-fixture-'));
const fixturePath = path.join(fixtureDirectory, 'desktop.png');
await writeFile(fixturePath, 'preview');

const evidence = {
  assets: [{
    relativePath: '.propr/previews/desktop.png',
    absolutePath: fixturePath,
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

test('publishes a private-safe hybrid image from GitHub and authenticated finalized managed metadata', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const managedViewerUrl = 'https://connect.example.test/previews/artifact-1';

  await publishPullRequestVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    taskId: 'task-2282',
    body: 'Implementation summary',
    evidence,
    authToken: 'installation-token',
    worktreePath: '/worktree',
    trustedConnectOrigin: 'https://connect.example.test',
    storeOriginals: async () => [{
      version: 1, assetIndex: 0, relativePath: evidence.assets[0].relativePath, stored: true,
      artifact: {
        version: 1, artifactId: 'artifact-1', state: 'ready', taskId: 'task-2282', repository: 'integry/propr',
        pullRequestNumber: 42, displayFilename: 'desktop.png', sizeBytes: 7, contentType: 'image/png', sha256: 'a'.repeat(64),
        viewerUrl: managedViewerUrl, retentionExpiresAt: '2099-01-01T00:00:00Z',
      },
    }],
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => {
        requests.push({ endpoint, options });
        if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { id: 987 } } as T;
        return { data: { body: options.body } } as T;
      }
    },
    uploadAsset: async () => 'https://github.com/user-attachments/assets/asset-id',
  });

  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
  ]);
  const publishedBody = String(requests[1].options.body);
  assert.match(publishedBody, /github\.com\/user-attachments\/assets\/asset-id/);
  assert.match(publishedBody, /connect\.example\.test\/previews\/artifact-1/);
  assert.doesNotMatch(publishedBody, /objects\.example|X-Amz-|[?&]token=/);
  assert.equal(publishedBody.includes(fixturePath), false);
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
      request: async <T>() => ({ data: { body: `![Desktop settings](${fixturePath})` } }) as T
    },
    uploadAsset: async () => 'https://github.com/user-attachments/assets/asset-id'
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
  assert.equal(published.body.includes(fixturePath), false);
  assert.deepEqual(requests.map(request => request.endpoint), [
    'GET /repos/{owner}/{repo}',
    'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
  ]);
  assert.equal(requests[1].options.comment_id, 100);
  assert.deepEqual(uploads, [{
    absolutePath: fixturePath,
    authToken: 'installation-token',
    repositoryId: 987,
  }]);
});

test('uploads comment attachments serially to bound in-memory upload buffers', async () => {
  let activeUploads = 0;
  let maximumActiveUploads = 0;
  const assets = Array.from({ length: 8 }, (_, index) => ({
    ...evidence.assets[0],
    relativePath: `.propr/previews/preview-${index}.png`,
    title: `Preview ${index}`,
  }));

  await publishPullRequestCommentVisualPreviews({
    owner: 'integry',
    repo: 'propr',
    pullRequestNumber: 42,
    body: 'Follow-up complete',
    evidence: { assets, toolSuggestions: [] },
    authToken: 'installation-token',
    worktreePath: '/worktree',
    startingCommentId: 100,
    octokit: {
      request: async <T>(endpoint: string, options: Record<string, unknown>) => endpoint === 'GET /repos/{owner}/{repo}'
        ? { data: { id: 987 } } as T
        : { data: { html_url: 'https://github.com/integry/propr/pull/42#issuecomment-100', body: options.body } } as T,
    },
    uploadAsset: async ({ absolutePath }) => {
      activeUploads += 1;
      maximumActiveUploads = Math.max(maximumActiveUploads, activeUploads);
      await new Promise(resolve => setTimeout(resolve, 1));
      activeUploads -= 1;
      return `https://github.com/user-attachments/assets/${path.basename(absolutePath, '.png')}`;
    },
  });

  assert.equal(maximumActiveUploads, 1);
});

test('updates the work comment with a safe fallback when a direct attachment upload fails', async () => {
  const requests: string[] = [];
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
        requests.push(endpoint);
        return endpoint === 'GET /repos/{owner}/{repo}'
          ? { data: { id: 987 } } as T
          : { data: { html_url: 'https://github.com/comment/100', body: options.body } } as T;
      }
    },
    uploadAsset: async () => { throw new Error('attachment upload failed'); },
  });

  assert.deepEqual(requests, ['GET /repos/{owner}/{repo}', 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}']);
  assert.match(published.body, /could not be uploaded to GitHub/);
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
          body: `![Desktop settings](${fixturePath})`,
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

test('direct upload rejects oversized images for paid plans and oversized videos for unresolved auto before network access', async () => {
  const { truncate } = await import('node:fs/promises');
  const { MIB, resolveGitHubAttachmentCapacity } = await import('@propr/shared');
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-upload-capacity-'));
  const originalFetch = globalThis.fetch;
  try {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(JSON.stringify({ url: 'https://github.com/user-attachments/assets/paid-video' }));
    };
    for (const extension of ['png', 'jpg', 'gif', 'svg', 'webp', 'mp4', 'mov', 'webm', 'pdf']) {
      const absolutePath = path.join(directory, `preview.${extension}`);
      await writeFile(absolutePath, '');
      await truncate(absolutePath, 10 * MIB + 1);
      const isVideo = ['mp4', 'mov', 'webm'].includes(extension);
      await assert.rejects(uploadVisualPreviewAsset({ absolutePath, authToken: 'existing', repositoryId: 1 }), /limit|Unsupported/);
      if (isVideo) {
        await uploadVisualPreviewAsset({ absolutePath, authToken: 'existing', repositoryId: 1, capacity: resolveGitHubAttachmentCapacity('auto', 'paid') });
        await truncate(absolutePath, 100 * MIB + 1);
      }
      await assert.rejects(uploadVisualPreviewAsset({ absolutePath, authToken: 'existing', repositoryId: 1, capacity: resolveGitHubAttachmentCapacity('paid') }), /limit|Unsupported/);
    }
    assert.equal(requests, 3, 'only eligible paid videos reached the upload endpoint');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized media is not sent to the GitHub attachment uploader', async () => {
  const { truncate } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-pr-capacity-'));
  try {
    const absolutePath = path.join(directory, 'preview.mp4');
    await writeFile(absolutePath, '');
    await truncate(absolutePath, 11 * 1024 * 1024);
    let publishedBody = '';
    await publishPullRequestVisualPreviews({
      owner: 'integry', repo: 'propr', pullRequestNumber: 42, body: '', authToken: 'existing', worktreePath: directory,
      evidence: { assets: [{ relativePath: '.propr/previews/preview.mp4', absolutePath, type: 'video', title: 'Preview' }], toolSuggestions: [] },
      storeOriginals: async () => [],
      uploadAsset: async () => { assert.fail('must not upload oversized media'); },
      octokit: { request: async <T>(_endpoint: string, options: Record<string, unknown>) => {
        publishedBody = String(options.body);
        return { data: { body: options.body } } as T;
      } },
    });
    assert.match(publishedBody, /does not fit the resolved GitHub inline limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publishers store and link prepared originals without uploading GitHub-ineligible media', async t => {
  const { prepareVisualPreviewEvidence, cleanupPreparedVisualPreviewEvidence } = await import('@propr/core');
  const { MIB, resolveGitHubAttachmentCapacity } = await import('@propr/shared');
  const { simpleGit } = await import('simple-git');
  const worktree = await mkdtemp(path.join(tmpdir(), 'propr-managed-original-'));
  t.after(async () => rm(worktree, { recursive: true, force: true }));
  const git = simpleGit(worktree);
  await git.init();
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
  await writeFile(path.join(worktree, 'README.md'), 'fixture');
  await git.add('README.md');
  await git.commit('initial');
  await mkdir(path.join(worktree, '.propr/previews'), { recursive: true });
  const relativePath = '.propr/previews/original.png';
  const originalPath = path.join(worktree, relativePath);
  await writeFile(originalPath, 'original evidence');
  await truncate(originalPath, 11 * MIB);
  const originalBytes = await readFile(originalPath);
  const prepared = await prepareVisualPreviewEvidence({
    worktreePath: worktree, taskId: 'managed-original',
    settings: { enabled: true, types: ['image'], originalEvidenceCapability: { maxBytes: 500 * MIB, allowedContentTypes: ['image/png'] } },
  });
  t.after(async () => cleanupPreparedVisualPreviewEvidence(prepared));
  assert.equal(prepared.evidence.assets.length, 1);
  const asset = prepared.evidence.assets[0];
  assert.equal(asset.sizeBytes, originalBytes.length);
  assert.deepEqual(asset.githubInline, { eligible: false, reason: 'size-limit-exceeded', limitBytes: 10 * MIB });
  await assert.rejects(access(originalPath));
  assert.equal((await git.status()).files.length, 0);

  // Both publishers pass the complete staged original and task context to storage
  // before selecting GitHub inline publication.
  const storeOriginals = t.mock.fn(async (
    originals: typeof prepared.evidence,
    context: { taskId: string; repository: string; pullRequestNumber?: number },
  ) => {
    assert.equal(originals.originalCapacity?.source, 'managed-storage');
    assert.deepEqual(context, { taskId: 'managed-original', repository: 'integry/propr', pullRequestNumber: 42 });
    assert.deepEqual(await readFile(originals.assets[0].absolutePath), originalBytes);
    return [{
      version: 1 as const, assetIndex: 0, relativePath, stored: true as const,
      artifact: {
        version: 1 as const, artifactId: 'original-1', state: 'ready' as const,
        taskId: 'managed-original', repository: 'integry/propr', pullRequestNumber: 42,
        displayFilename: 'original.png', sizeBytes: originalBytes.length, contentType: 'image/png', sha256: 'a'.repeat(64),
        viewerUrl: 'https://connect.example.test/previews/original-1', retentionExpiresAt: '2099-01-01T00:00:00Z',
      },
    }];
  });

  const network = t.mock.method(globalThis, 'fetch', async () => { assert.fail('must not fetch'); });
  const publishedBodies: string[] = [];
  const request = t.mock.fn(async <T>(endpoint: string, requestOptions: Record<string, unknown>): Promise<T> => {
    assert.match(endpoint, /^PATCH /);
    assert.match(String(requestOptions.body), /Inline preview unavailable/);
    assert.doesNotMatch(String(requestOptions.body), /\/tmp\/|\.propr\/previews\//);
    publishedBodies.push(String(requestOptions.body));
    return { data: { html_url: 'https://github.com/comment/100', body: requestOptions.body } } as T;
  });
  const uploadAsset = t.mock.fn(async (): Promise<string> => { assert.fail('must not upload'); });
  for (const plan of ['auto', 'free', 'paid'] as const) {
    const options = {
      owner: 'integry', repo: 'propr', pullRequestNumber: 42, startingCommentId: 100,
      body: 'Complete', worktreePath: worktree,
      evidence: { ...prepared.evidence, githubAttachmentCapacity: resolveGitHubAttachmentCapacity(plan) },
      octokit: { request }, uploadAsset, storeOriginals, trustedConnectOrigin: 'https://connect.example.test',
    };
    await publishPullRequestVisualPreviews(options);
    await publishPullRequestCommentVisualPreviews(options);
  }
  assert.equal(network.mock.callCount(), 0);
  assert.equal(storeOriginals.mock.callCount(), 6);
  await Promise.all(storeOriginals.mock.calls.map(call => call.result));
  assert.equal(request.mock.callCount(), 6);
  assert.equal(uploadAsset.mock.callCount(), 0);
  const publishedTargets = publishedBodies.map(body => [...body.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]));
  assert.deepEqual(publishedTargets, Array.from({ length: 6 }, () => [
    'https://connect.example.test/previews/original-1',
  ]));
  assert.deepEqual(await readFile(asset.absolutePath), originalBytes, 'GitHub rejection does not consume the original');
  await cleanupPreparedVisualPreviewEvidence(prepared);
  await assert.rejects(access(asset.absolutePath));
});

test('GitHub publishers revalidate stale metadata and upload only actually eligible assets', async t => {
  const { MIB } = await import('@propr/shared');
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-stale-inline-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const absolutePath = path.join(directory, 'grew.mp4');
  await writeFile(absolutePath, '');
  await truncate(absolutePath, 11 * MIB);
  const options = {
    owner: 'integry', repo: 'propr', pullRequestNumber: 42, startingCommentId: 100,
    body: '', worktreePath: directory, authToken: 'existing',
    evidence: {
      ...evidence,
      assets: [...evidence.assets, {
        relativePath: '.propr/previews/grew.mp4', absolutePath, type: 'video' as const, title: 'Grew',
        sizeBytes: 1, githubInline: { eligible: true as const, limitBytes: 10 * MIB },
      }],
    },
    storeOriginals: async () => [],
    octokit: { request: async <T>(endpoint: string, requestOptions: Record<string, unknown>): Promise<T> => endpoint === 'GET /repos/{owner}/{repo}'
      ? { data: { id: 987 } } as T
      : { data: { html_url: 'https://github.com/comment/100', body: requestOptions.body } } as T },
  };
  const uploadedPaths: string[] = [];
  const withUploader = { ...options, uploadAsset: async ({ absolutePath }: { absolutePath: string }) => {
    uploadedPaths.push(absolutePath);
    return 'https://github.com/user-attachments/assets/eligible';
  } };
  await publishPullRequestVisualPreviews(withUploader);
  await publishPullRequestCommentVisualPreviews(withUploader);
  assert.deepEqual(uploadedPaths, [fixturePath, fixturePath]);
});

test('managed storage failure still publishes GitHub attachments without exposing its error', async () => {
  let attempted = false;
  let published = false;
  await publishPullRequestVisualPreviews({
    owner: 'integry', repo: 'propr', pullRequestNumber: 42, taskId: 'task-2285', body: 'Summary', evidence,
    authToken: 'gho_test', worktreePath: '/worktree',
    storeOriginals: async (originals, repository) => {
      assert.equal(originals, evidence);
      assert.deepEqual(repository, { taskId: 'task-2285', repository: 'integry/propr', pullRequestNumber: 42 });
      attempted = true;
      throw new Error('https://signed.example/?token=secret');
    },
    uploadAsset: async () => {
      assert.equal(attempted, true);
      published = true;
      return 'https://github.com/user-attachments/assets/1';
    },
    octokit: { request: async <T>(endpoint: string, requestOptions: Record<string, unknown>) => endpoint === 'GET /repos/{owner}/{repo}'
      ? { data: { id: 1 } } as T
      : { data: { body: requestOptions.body } } as T },
  });
  assert.equal(published, true);
});

test('a video between 10 and 100 MiB is inline only with resolved paid capacity and is never transcoded', async t => {
  const { MIB, resolveGitHubAttachmentCapacity } = await import('@propr/shared');
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-hybrid-video-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const absolutePath = path.join(directory, 'walkthrough.mp4');
  await writeFile(absolutePath, '');
  await truncate(absolutePath, 11 * MIB);
  const videoEvidence = {
    taskId: 'video-task',
    assets: [{
      relativePath: '.propr/previews/walkthrough.mp4', absolutePath, type: 'video' as const,
      title: 'Walkthrough', sizeBytes: 11 * MIB,
    }],
    toolSuggestions: [],
  };
  const original = {
    version: 1 as const, assetIndex: 0, relativePath: videoEvidence.assets[0].relativePath, stored: true as const,
    artifact: {
      version: 1 as const, artifactId: 'video-original', state: 'ready' as const,
      taskId: 'video-task', repository: 'integry/propr', pullRequestNumber: 42,
      displayFilename: 'walkthrough.mp4', sizeBytes: 11 * MIB, contentType: 'video/mp4', sha256: 'b'.repeat(64),
      viewerUrl: 'https://connect.example.test/previews/video-original', retentionExpiresAt: '2099-01-01T00:00:00Z',
    },
  };
  for (const plan of ['free', 'paid'] as const) {
    const uploads: string[] = [];
    const bodies: string[] = [];
    await publishPullRequestVisualPreviews({
      owner: 'integry', repo: 'propr', pullRequestNumber: 42, body: '', taskId: 'video-task',
      evidence: { ...videoEvidence, githubAttachmentCapacity: resolveGitHubAttachmentCapacity(plan) },
      authToken: 'existing', worktreePath: directory, trustedConnectOrigin: 'https://connect.example.test',
      storeOriginals: async () => [original],
      uploadAsset: async ({ absolutePath: uploadedPath }) => {
        uploads.push(uploadedPath);
        assert.equal((await access(uploadedPath).then(() => true)), true);
        return 'https://github.com/user-attachments/assets/video-inline';
      },
      octokit: { request: async <T>(endpoint: string, requestOptions: Record<string, unknown>) => {
        if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { id: 987 } } as T;
        bodies.push(String(requestOptions.body));
        return { data: { body: requestOptions.body } } as T;
      } },
    });
    assert.equal(uploads.length, plan === 'paid' ? 1 : 0);
    assert.match(bodies[0], /connect\.example\.test\/previews\/video-original/);
    assert.equal(bodies[0].includes('github.com/user-attachments'), plan === 'paid');
  }
  assert.equal((await readFile(absolutePath)).byteLength, 11 * MIB, 'publisher leaves the original bytes unchanged');
});

test('staged evidence remains until storage, inline upload, and fallback publication have settled', async t => {
  const { cleanupPreparedVisualPreviewEvidence } = await import('@propr/core');
  const directory = await mkdtemp(path.join(tmpdir(), 'propr-cleanup-order-'));
  const absolutePath = path.join(directory, 'preview.png');
  await writeFile(absolutePath, 'preview');
  const stagedEvidence = {
    assets: [{ relativePath: '.propr/previews/preview.png', absolutePath, type: 'image' as const, title: 'Preview', sizeBytes: 7 }],
    toolSuggestions: [],
  };
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const events: string[] = [];
  try {
    await publishPullRequestCommentVisualPreviews({
      owner: 'integry', repo: 'propr', pullRequestNumber: 42, startingCommentId: 100,
      body: '', evidence: stagedEvidence, authToken: 'existing', worktreePath: directory,
      storeOriginals: async () => { await access(absolutePath); events.push('managed'); return []; },
      uploadAsset: async () => { await access(absolutePath); events.push('github'); throw new Error('rejected'); },
      octokit: { request: async <T>(endpoint: string, requestOptions: Record<string, unknown>) => {
        if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { id: 987 } } as T;
        await access(absolutePath);
        events.push('fallback');
        return { data: { html_url: 'https://github.com/comment/100', body: requestOptions.body } } as T;
      } },
    });
    await access(absolutePath);
  } finally {
    await cleanupPreparedVisualPreviewEvidence({ evidence: stagedEvidence, temporaryDirectory: directory });
  }
  assert.deepEqual(events, ['managed', 'github', 'fallback']);
  await assert.rejects(access(absolutePath));
});


test('managed originals return ordered per-asset finalized metadata and bounded independent failures', async () => {
  const assets = ['first.png', 'broken.png', 'quota.mp4', 'unsupported.txt', 'last.webp'].map((name, index) => ({
    relativePath: `.propr/previews/${name}`, absolutePath: `/staged/${name}`, type: 'image' as const, title: `Asset ${index}`,
  }));
  const context = { taskId: 'task-2285', repository: 'integry/propr', pullRequestNumber: 2285 };
  const artifactFor = (displayFilename: string): PreviewArtifactV1 => ({
    version: 1, artifactId: displayFilename, state: 'ready', ...context, displayFilename,
    sizeBytes: 123, contentType: displayFilename.endsWith('webp') ? 'image/webp' : 'image/png', sha256: 'a'.repeat(64),
    viewerUrl: `https://connect.example.test/previews/${displayFilename}`, retentionExpiresAt: '2099-01-01T00:00:00Z',
  });
  const requests: string[] = [];
  const result = await storeManagedVisualPreviewOriginals({ assets, toolSuggestions: [] }, context, {
    createClient: () => ({ uploadOriginal: async input => {
      assert.equal(input.taskId, context.taskId);
      assert.equal(input.repository, context.repository);
      assert.equal(input.pullRequestNumber, context.pullRequestNumber);
      assert.equal('bytes' in input, false);
      assert.equal('installationId' in input, false);
      requests.push(input.filePath);
      if (input.displayFilename === 'broken.png') throw new Error('raw token=secret https://objects.example/?signed=secret');
      if (input.displayFilename === 'quota.mp4') return { stored: false, code: 'quota_exceeded' };
      return { stored: true, artifact: artifactFor(input.displayFilename) };
    } }),
  });
  assert.deepEqual(requests, ['/staged/first.png', '/staged/broken.png', '/staged/quota.mp4', '/staged/last.webp']);
  assert.deepEqual(result, assets.map((asset, assetIndex) => ({
    version: 1, assetIndex, relativePath: asset.relativePath,
    ...([0, 4].includes(assetIndex)
      ? { stored: true, artifact: artifactFor(assetIndex === 0 ? 'first.png' : 'last.webp') }
      : { stored: false, code: ['unavailable', 'quota_exceeded', 'content_type_not_allowed'][assetIndex - 1] }),
  })));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('/staged/'));
  // Duplicate source paths remain independently addressable by index.
  const duplicates = await storeManagedVisualPreviewOriginals({ assets: [assets[0], assets[0]], toolSuggestions: [] }, context, {
    createClient: () => ({ uploadOriginal: async () => ({ stored: false, code: 'disabled' }) }),
  });
  assert.deepEqual(duplicates.map(result => result.assetIndex), [0, 1]);
});

test('managed client setup failure preserves a safe result for every asset', async () => {
  const result = await storeManagedVisualPreviewOriginals(evidence, { taskId: 'task-2285', repository: 'integry/propr' }, {
    createClient: () => { throw new Error('relay-token-secret'); },
  });
  assert.deepEqual(result, [{ version: 1, assetIndex: 0, relativePath: evidence.assets[0].relativePath, stored: false, code: 'unavailable' }]);
});

test('hybrid publication isolates mixed asset outcomes and rejects untrusted viewer links', async () => {
  const context = { taskId: 'mixed-assets', repository: 'integry/propr', pullRequestNumber: 42 };
  const assets = ['Original', 'Quota', 'Untrusted'].map(title => ({ ...evidence.assets[0], title }));
  let uploads = 0;
  let published = '';
  const artifact = { version: 1 as const, artifactId: 'original-1', state: 'ready' as const, ...context,
    displayFilename: 'desktop.png', sizeBytes: 7, contentType: 'image/png', sha256: 'a'.repeat(64),
    viewerUrl: 'https://connect.propr.dev/previews/original-1', retentionExpiresAt: '2099-01-01T00:00:00Z' };
  const result = await publishPullRequestCommentVisualPreviews({
    owner: 'integry', repo: 'propr', pullRequestNumber: 42, startingCommentId: 100,
    body: `Follow-up complete. ${fixturePath}`, worktreePath: fixtureDirectory, authToken: 'gho_mock',
    evidence: { ...evidence, taskId: context.taskId, assets },
    storeOriginals: async () => assets.map((asset, assetIndex) => ({ version: 1 as const, assetIndex, relativePath: asset.relativePath,
      ...(assetIndex === 1 ? { stored: false as const, code: 'quota_exceeded' as const }
        : { stored: true as const, artifact: { ...artifact, viewerUrl: assetIndex === 2 ? 'https://evil.example/previews/original-1?token=secret' : artifact.viewerUrl } }),
    })),
    uploadAsset: async () => {
      uploads++;
      if (uploads === 1) throw new Error(`upload failure: ${fixturePath}`);
      return `https://github.com/user-attachments/assets/asset-${uploads}`;
    },
    octokit: { request: async <T>(endpoint: string, input: Record<string, unknown>): Promise<T> => {
      if (endpoint.startsWith('GET')) return { data: { id: 42 } } as T;
      published = String(input.body);
      return { data: { body: published, html_url: 'https://github.com/integry/propr/pull/42' } } as T;
    } },
  });
  assert.equal(uploads, 3, 'later assets survive earlier upload failure');
  assert.equal(result.body, published);
  assert.match(published, /Connect sign-in required/);
  assert.match(published, /quota exceeded/);
  assert.match(published, /assets\/asset-2/);
  assert.match(published, /assets\/asset-3/);
  for (const forbidden of [fixturePath, 'evil.example', 'token=secret']) assert.ok(!published.includes(forbidden));
});

test('GitHub upload transport failures discard raw bodies, paths, and credentials', async t => {
  let responseBodyCancelled = false;
  const failedResponse = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${fixturePath} https://objects.example/?token=private-token`));
    },
    cancel() { responseBodyCancelled = true; },
  }), { status: 500 });
  for (const failure of [new Error(`${fixturePath} Bearer private-token`), failedResponse]) {
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await assert.rejects(uploadVisualPreviewAsset({ absolutePath: fixturePath, authToken: 'gho_mock', repositoryId: 42 }), error => {
      const output = String(error);
      for (const forbidden of [fixturePath, 'private-token', 'objects.example']) assert.ok(!output.includes(forbidden));
      return true;
    });
    if (failure === failedResponse) assert.equal(responseBodyCancelled, true, 'failed response body is cancelled');
    t.mock.restoreAll();
  }
});
