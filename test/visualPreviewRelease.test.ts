import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PREVIEW_STORAGE_V1_DEFAULTS, MIB } from '@propr/shared';
import { ManagedPreviewStorageClientV1 } from '../packages/core/src/services/previewStorage/v1.js';
import { loadGitHubAttachmentCapacity } from '../packages/core/src/services/visualPreviewCapacityService.js';
import { collectVisualPreviewEvidence, renderVisualPreviewUploadFailureSection } from '../packages/core/src/services/visualPreviewService.js';
import { createLogFiles, generateCompletionComment } from '../packages/core/src/utils/github/logFiles.js';
import { storeManagedVisualPreviewOriginals } from '../src/github/managedVisualPreviewStorage.js';
import { publishPullRequestVisualPreviews, publishPullRequestCommentVisualPreviews } from '../src/github/visualPreviewAttachments.js';
import { db } from '@propr/core';
import { generatePRBody, generateClaudeLogsComment } from '../src/github/prFormatters.js';

const root = await mkdtemp(path.join(tmpdir(), 'visual-release-'));
after(async () => { await rm(root, { recursive: true, force: true }); await db.destroy(); });
const relativePath = '.propr/previews/demo.mp4';
await mkdir(path.join(root, '.propr/previews'), { recursive: true });
await writeFile(path.join(root, relativePath), '');
await truncate(path.join(root, relativePath), 11 * MIB);
const localPath = path.join(root, relativePath);
const inlineRelativePath = '.propr/previews/inline.mp4';
await writeFile(path.join(root, inlineRelativePath), 'inline preview');
const inlineLocalPath = path.join(root, inlineRelativePath);
const secret = 'signed-private-secret';
const viewerUrl = 'https://connect.propr.dev/previews/original-1';
const attachmentUrl = 'https://github.com/user-attachments/assets/video-1';
const status = { version: 1, installationId: 42, enabled: true, ...PREVIEW_STORAGE_V1_DEFAULTS,
  usedBytes: 0, reservedBytes: 0, allowedContentTypes: ['video/mp4'], deleteSupported: false };

function extractMarkdownTargets(markdown: string): Set<string> {
  const targets = new Set<string>();
  const markdownLink = /!?\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\s)\r\n]+))\)/g;
  for (const match of markdown.matchAll(markdownLink)) targets.add(match[1] ?? match[2]);
  return targets;
}

for (const plan of ['pro', 'free', 'unknown'] as const) {
  for (const scenario of ['plus', 'community', 'offline', 'quota', 'upload-expired', 'object-expired', 'github-failed', 'legacy'] as const) {
    for (const target of ['pr', 'follow-up'] as const) {
      test(`${target}: ${plan} GitHub plan / ${scenario}`, async t => {
        // Any accidental use of live transport fails this test, including credentials.
        t.mock.method(globalThis, 'fetch', async () => { assert.fail('Unexpected live request'); });
        const capacity = await loadGitHubAttachmentCapacity('auto', 'integry/propr', {
          resolveToken: async () => 'gho_mock',
          fetch: async () => Response.json({ login: 'integry', plan: { name: plan } }),
        });
        assert.equal(capacity.effectivePlan, plan === 'pro' ? 'paid' : 'free');
        const calls: string[] = [];
        let metadata: Record<string, unknown> = {};
        const client = new ManagedPreviewStorageClientV1({
          routingUrl: 'wss://connect.propr.dev', trustedConnectOrigin: 'https://connect.propr.dev', relayToken: secret,
          getConnectContext: async () => ({ connected: scenario !== 'offline', connectAccount: { installationId: 42, hasPlusAccess: scenario !== 'community' } }),
          fetchImpl: async (url, init) => {
            const pathname = new URL(String(url)).pathname;
            calls.push(`${init?.method} ${pathname}`);
            if (pathname.endsWith('/status')) return scenario === 'legacy' ? new Response(null, { status: 404 }) : Response.json(status);
            if (pathname.endsWith('/uploads')) {
              metadata = JSON.parse(init!.body as string);
              assert.ok(!JSON.stringify(metadata).includes(root));
              if (scenario === 'quota') return Response.json({
                error: { code: 'quota_exceeded', message: `${localPath} ${secret}` },
              }, { status: 413 });
              return Response.json({ ...metadata, artifactId: 'original-1', objectKey: 'private-object', put: {
                url: `https://objects.example.test/upload?signature=${secret}`,
                headers: {
                  'Content-Type': 'video/mp4',
                  'Content-Length': String(metadata.sizeBytes),
                  'If-None-Match': '*',
                },
                expiresAt: scenario === 'upload-expired' ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z',
              } });
            }
            if (init?.method === 'PUT') {
              assert.equal(new Headers(init.headers).has('authorization'), false);
              for await (const _chunk of new Request(url, init).body!) { /* consume the real stream */ }
              return new Response(null, { status: 204 });
            }
            return Response.json({ ...metadata, artifactId: 'original-1', state: 'ready', viewerUrl,
              retentionExpiresAt: scenario === 'object-expired' ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z' });
          },
        });
        const legacy = ['legacy', 'community', 'offline'].includes(scenario);
        const selectedRelativePath = legacy ? inlineRelativePath : relativePath;
        const selectedLocalPath = legacy ? inlineLocalPath : localPath;
        const evidence = await collectVisualPreviewEvidence({ worktreePath: root, changedFiles: [selectedRelativePath], settings: {
          enabled: true, types: ['video'], githubAttachmentCapacity: capacity,
          ...(!legacy ? { originalEvidenceCapability: { maxBytes: status.maxObjectBytes, allowedContentTypes: status.allowedContentTypes } } : {}),
        } });
        evidence.taskId = 'release-test';
        assert.equal(evidence.assets.length, 1);
        evidence.assets[0].title = `Demo ${selectedLocalPath}`;
        let published = '';
        let uploads = 0;
        const options = {
          owner: 'integry', repo: 'propr', pullRequestNumber: 2283, startingCommentId: 123, worktreePath: root,
          authToken: 'gho_mock', evidence, body: `Implementation complete. ${selectedLocalPath}`,
          storeOriginals: (input: typeof evidence, context: Parameters<typeof storeManagedVisualPreviewOriginals>[1]) => storeManagedVisualPreviewOriginals(input, context, { createClient: () => client }),
          uploadAsset: async () => { uploads++; if (scenario === 'github-failed') throw new Error(`${selectedLocalPath} ${secret}`); return attachmentUrl; },
          runCommand: async ({ args }: { args: string[] }) => {
            uploads++;
            published = args[args.indexOf('--body') + 1].replaceAll(selectedLocalPath, attachmentUrl);
            return { stdout: '' };
          },
          octokit: { request: async <T>(endpoint: string, input: Record<string, unknown>): Promise<T> => {
            assert.ok(!/merge/i.test(endpoint), 'Release validation never merges the epic');
            if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { id: 42 } } as T;
            if (endpoint.startsWith('PATCH')) published = String(input.body);
            return { data: { body: published, html_url: 'https://github.com/integry/propr/pull/2283' } } as T;
          } },
        };
        if (target === 'pr') await publishPullRequestVisualPreviews(options);
        else assert.equal((await publishPullRequestCommentVisualPreviews(options)).body, published);
        const githubInlineEligible = legacy || plan === 'pro';
        const publishedTargets = extractMarkdownTargets(published);
        assert.equal(uploads, githubInlineEligible ? 1 : 0);
        assert.equal(publishedTargets.has(attachmentUrl), githubInlineEligible && scenario !== 'github-failed');
        assert.equal(publishedTargets.has(viewerUrl), ['plus', 'github-failed'].includes(scenario));
        if (scenario === 'plus') assert.match(published, /Connect sign-in required/);
        if (scenario === 'quota') assert.match(published, /quota exceeded/);
        if (!legacy && plan !== 'pro') assert.match(published, /Inline preview unavailable/);
        for (const forbidden of [root, relativePath, inlineRelativePath, secret, 'private-object', 'objects.example.test']) assert.ok(!published.includes(forbidden), forbidden);
        if (['community', 'offline'].includes(scenario)) assert.equal(calls.length, 0);
        if (scenario === 'upload-expired') assert.equal(calls.length, 2, 'expired grants must not PUT');
        if (scenario === 'object-expired') assert.equal(calls.length, 4, 'expired objects must not be linked');
      });
    }
  }
}

test('unknown and free GitHub-only collection conservatively excludes an oversized video', async () => {
  for (const plan of ['free', 'unknown'] as const) {
    const capacity = await loadGitHubAttachmentCapacity('auto', 'integry/propr', {
      resolveToken: async () => 'gho_mock',
      fetch: async () => Response.json({ login: 'integry', plan: { name: plan } }),
    });
    assert.equal(capacity.effectivePlan, 'free');
    const evidence = await collectVisualPreviewEvidence({
      worktreePath: root,
      changedFiles: [relativePath],
      settings: { enabled: true, types: ['video'], githubAttachmentCapacity: capacity },
    });
    assert.equal(evidence.assets.length, 0);
    assert.doesNotMatch(renderVisualPreviewUploadFailureSection(evidence), /\/tmp\/|\.propr\/previews\//);
  }
});

test('issue completion and persisted task logs redact preview and staging paths', async t => {
  const paths = [localPath, '/tmp/propr-previews/task-123/demo.png', 'C:\\work\\.propr\\preview-src\\capture.ts', encodeURI(localPath).replaceAll('/', '%2F')];
  const text = paths.join('\n');
  const result = { success: true, summary: text, rawOutput: text, conversationLog: [{ type: 'assistant', message: { content: [{ text }] } }] };
  const issue = { number: 2283, repoOwner: 'integry', repoName: 'propr' };
  const logs = await createLogFiles(result, issue);
  t.after(async () => { for (const file of Object.values(logs)) await rm(file, { force: true }); });
  const outputs = [await generatePRBody(2283, text, text, result), await generateClaudeLogsComment(result, 2283), await generateCompletionComment(result, issue, {}), ...await Promise.all(Object.values(logs).map(file => readFile(file, 'utf8')))];
  for (const output of outputs) for (const local of paths) assert.ok(!output.includes(local), local);
});
