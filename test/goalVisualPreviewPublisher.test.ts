import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { publishGoalVisualPreviews } from '../src/jobs/goalVisualPreviewPublisher.ts';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'goal-preview-publisher-'));
const relativePath = '.propr/previews/dashboard.png';
const absolutePath = path.join(fixtureRoot, relativePath);
await mkdir(path.dirname(absolutePath), { recursive: true });
await writeFile(absolutePath, 'preview');

after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.ts');
  await closeConnection();
  await rm(fixtureRoot, { recursive: true, force: true });
});

const goal = {
  goal_id: 'goal-1',
  repository: 'acme/repo',
  objective: 'Ship it',
  checkpoint_interval_minutes: null,
  worktree_path: fixtureRoot,
};

function managedResult(viewerUrl: string) {
  return [{
    version: 1 as const,
    assetIndex: 0,
    relativePath,
    stored: true as const,
    artifact: {
      version: 1 as const,
      artifactId: 'managed-original-1',
      state: 'ready' as const,
      taskId: 'goal-task-1',
      repository: 'acme/repo',
      pullRequestNumber: 42,
      displayFilename: 'dashboard.png',
      sizeBytes: 7,
      contentType: 'image/png',
      sha256: 'a'.repeat(64),
      viewerUrl,
      retentionExpiresAt: '2099-01-01T00:00:00.000Z',
    },
  }];
}

function preparedEvidence(localSource: string) {
  return {
    evidence: {
      taskId: 'goal-task-1',
      assets: [{
        relativePath,
        absolutePath,
        type: 'image' as const,
        title: `Dashboard from ${absolutePath}`,
        description: `Renderer source ${localSource}`,
      }],
      toolSuggestions: [],
    },
  };
}

function goalOctokit(requests: Array<{ endpoint: string; options: Record<string, unknown> }>) {
  return {
    request: async <T>(endpoint: string, options: Record<string, unknown>) => {
      requests.push({ endpoint, options });
      if (endpoint === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { body: 'Existing goal implementation body.' } } as T;
      }
      if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { id: 987 } } as T;
      if (endpoint === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') {
        return { data: { body: options.body } } as T;
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
}

test('goal preview publication preserves an orchestrated PR body and replaces its preview section', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const octokit = {
    request: async (endpoint: string, options: Record<string, unknown>) => {
      requests.push({ endpoint, options });
      if (endpoint.startsWith('GET ')) {
        return {
          data: {
            body: [
              'Original orchestrated implementation summary.',
              '',
              '---',
              '',
              '<!-- propr-visual-preview -->',
              '## Visual preview',
              '',
              '### Previous',
              '',
              '![Previous](https://github.com/user-attachments/assets/previous)',
            ].join('\n'),
          },
        };
      }
      return { data: {} };
    },
  };

  await publishGoalVisualPreviews(goal, { number: 42 }, {
    evidence: {
      assets: [],
      toolSuggestions: [{ name: 'Playwright Chromium', reason: 'Needed to capture the running UI.' }],
    },
  }, octokit as never);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].endpoint, 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}');
  const body = String(requests[1].options.body);
  assert.match(body, /^Original orchestrated implementation summary\./);
  assert.doesNotMatch(body, /### Previous/);
  assert.match(body, /Playwright Chromium/);
  assert.equal(body.match(/<!-- propr-visual-preview -->/g)?.length, 1);
});

test('goal publication renders GitHub inline media with an independent managed original', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const order: string[] = [];
  const viewerUrl = 'https://connect.example.test/previews/managed-original-1';
  const attachmentUrl = 'https://github.com/user-attachments/assets/goal-inline-1';
  const localSource = '/tmp/goals/goal-1/.propr/preview-src/capture.ts';

  await publishGoalVisualPreviews(goal, { number: 42 }, preparedEvidence(localSource), goalOctokit(requests) as never, {
    authToken: 'gho_test',
    trustedConnectOrigin: 'https://connect.example.test',
    storeOriginals: async () => { order.push('managed'); return managedResult(viewerUrl); },
    uploadAsset: async () => { order.push('github'); return attachmentUrl; },
  });

  const body = String(requests.at(-1)?.options.body);
  assert.deepEqual(order, ['managed', 'github']);
  assert.match(body, /github\.com\/user-attachments\/assets\/goal-inline-1/);
  assert.match(body, /connect\.example\.test\/previews\/managed-original-1/);
  assert.match(body, /Connect sign-in required/);
  for (const localPath of [absolutePath, relativePath, localSource]) assert.equal(body.includes(localPath), false, localPath);
});

test('goal publication retains a managed original when GitHub inline publication fails', async () => {
  const requests: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const viewerUrl = 'https://connect.example.test/previews/managed-original-1';
  const localSource = '/tmp/goals/goal-1/.propr/preview-src/capture.ts';

  await publishGoalVisualPreviews(goal, { number: 42 }, preparedEvidence(localSource), goalOctokit(requests) as never, {
    authToken: 'gho_test',
    trustedConnectOrigin: 'https://connect.example.test',
    storeOriginals: async () => managedResult(viewerUrl),
    uploadAsset: async () => { throw new Error(`Could not upload ${absolutePath}`); },
  });

  const body = String(requests.at(-1)?.options.body);
  assert.match(body, /connect\.example\.test\/previews\/managed-original-1/);
  assert.match(body, /Inline preview unavailable/);
  assert.doesNotMatch(body, /github\.com\/user-attachments/);
  for (const localPath of [absolutePath, relativePath, localSource]) assert.equal(body.includes(localPath), false, localPath);
});
