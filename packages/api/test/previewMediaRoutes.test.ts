import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection } from '@propr/core';
import { createPreviewMediaRoutes } from '../routes/previewMediaRoutes.js';

after(closeConnection);

const assetId = 'd53f61f4-3dfa-41db-836c-625f827306b8';
const sourceUrl = `https://github.com/user-attachments/assets/${assetId}`;
const publishedBody = `<!-- propr-visual-preview -->\n## Visual preview\n\n### Private dashboard\n\n![Private dashboard](${sourceUrl})`;

function request(kind: 'pulls' | 'comments' = 'pulls', authenticated = true): Request {
  return {
    user: authenticated ? { id: 'user-1' } : undefined,
    authenticationMethod: 'session',
    params: { owner: 'Acme', repo: 'Web', number: kind === 'pulls' ? '49' : '9001', assetId },
  } as unknown as Request;
}

function response() {
  const state: { status: number; headers: Record<string, string>; body?: unknown } = { status: 200, headers: {} };
  const res = {
    status(code: number) { state.status = code; return this; },
    set(headers: Record<string, string>) { Object.assign(state.headers, headers); return this; },
    json(body: unknown) { state.body = body; return this; },
    send(body: unknown) { state.body = body; return this; },
  } as unknown as Response;
  return { res, state };
}

function fixture(options: {
  body?: string;
  bodyHtml?: string;
  githubError?: unknown;
  fetch?: typeof fetch;
} = {}) {
  const githubCalls: Array<{ endpoint: string; parameters: Record<string, unknown> }> = [];
  const routes = createPreviewMediaRoutes({
    reader: { enabledRepositories: async () => new Set(['acme/web']) },
    resolveToken: async () => 'github-user-token',
    createOctokit: () => ({ request: async (endpoint: string, parameters: Record<string, unknown>) => {
      githubCalls.push({ endpoint, parameters });
      if (options.githubError) throw options.githubError;
      return { data: { body: options.body ?? publishedBody, body_html: options.bodyHtml ?? '' } };
    } }) as never,
    fetch: options.fetch ?? (async () => new globalThis.Response('png', { status: 200, headers: { 'Content-Type': 'image/png' } })),
  });
  return { routes, githubCalls };
}

test('serves a private attachment only through its authorized PR association', async () => {
  const upstream: URL[] = [];
  const { routes, githubCalls } = fixture({
    bodyHtml: `<p><img src="https://private-user-images.githubusercontent.com/42/100-${assetId}.png?jwt=fixture"></p>`,
    fetch: async input => {
      upstream.push(new URL(String(input)));
      return new globalThis.Response('private-image', { status: 200, headers: { 'Content-Type': 'image/png' } });
    },
  });
  const result = response();
  await routes.getPullMedia(request(), result.res);

  assert.equal(result.state.status, 200);
  assert.equal((result.state.body as Buffer).toString(), 'private-image');
  assert.equal(result.state.headers['Cache-Control'], 'private, no-store');
  assert.equal(result.state.headers.Vary, 'Authorization, Cookie');
  assert.equal(result.state.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(upstream[0]?.hostname, 'private-user-images.githubusercontent.com');
  assert.equal(githubCalls[0]?.endpoint, 'GET /repos/{owner}/{repo}/pulls/{pull_number}');
  assert.deepEqual(githubCalls[0]?.parameters.mediaType, { format: 'full' });
});

test('serves public media through bounded redirects without forwarding authorization', async () => {
  const requests: Array<{ host: string; authorization?: string }> = [];
  const { routes } = fixture({ fetch: async (input, init) => {
    const url = new URL(String(input));
    requests.push({ host: url.hostname, authorization: new Headers(init?.headers).get('authorization') ?? undefined });
    if (url.hostname === 'github.com') {
      return new globalThis.Response(null, { status: 302, headers: {
        Location: `https://github-production-user-asset-6210df.s3.amazonaws.com/42/100-${assetId}.png?fixture=public`,
      } });
    }
    return new globalThis.Response('public-image', { status: 200, headers: { 'Content-Type': 'image/png' } });
  } });
  const result = response();
  await routes.getPullMedia(request(), result.res);

  assert.equal(result.state.status, 200);
  assert.equal(requests[0]?.authorization, 'Bearer github-user-token');
  assert.equal(requests[1]?.authorization, undefined);
  assert.deepEqual(requests.map(item => item.host), [
    'github.com', 'github-production-user-asset-6210df.s3.amazonaws.com',
  ]);
});

test('checks exact comment publication and preserves missing and unauthorized states', async () => {
  const comment = fixture();
  const available = response();
  await comment.routes.getCommentMedia(request('comments'), available.res);
  assert.equal(available.state.status, 200);
  assert.equal(comment.githubCalls[0]?.endpoint, 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}');

  let fetched = false;
  const missing = fixture({ body: '<!-- propr-visual-preview -->\n### Different\n\n![Different](https://github.com/user-attachments/assets/other)' ,
    fetch: async () => { fetched = true; return new globalThis.Response('no'); } });
  const missingResult = response();
  await missing.routes.getPullMedia(request(), missingResult.res);
  assert.equal(missingResult.state.status, 404);
  assert.equal(fetched, false);

  const forbidden = fixture({ githubError: Object.assign(new Error('not found'), { status: 404 }) });
  const forbiddenResult = response();
  await forbidden.routes.getPullMedia(request(), forbiddenResult.res);
  assert.equal(forbiddenResult.state.status, 404);
  assert.deepEqual(forbiddenResult.state.body, {
    error: 'Repository not found or not accessible', code: 'REPOSITORY_NOT_ACCESSIBLE',
  });

  const anonymous = response();
  await comment.routes.getPullMedia(request('pulls', false), anonymous.res);
  assert.equal(anonymous.state.status, 401);
});

test('rejects untrusted redirects and non-media responses', async () => {
  const redirect = fixture({ fetch: async () => new globalThis.Response(null, {
    status: 302, headers: { Location: 'https://example.test/internal' },
  }) });
  const redirectResult = response();
  await redirect.routes.getPullMedia(request(), redirectResult.res);
  assert.equal(redirectResult.state.status, 502);

  const text = fixture({ fetch: async () => new globalThis.Response('not an image', {
    status: 200, headers: { 'Content-Type': 'text/plain' },
  }) });
  const textResult = response();
  await text.routes.getPullMedia(request(), textResult.res);
  assert.equal(textResult.state.status, 502);

  const oversized = fixture({ fetch: async () => new globalThis.Response('x', {
    status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(10 * 1024 * 1024 + 1) },
  }) });
  const oversizedResult = response();
  await oversized.routes.getPullMedia(request(), oversizedResult.res);
  assert.equal(oversizedResult.state.status, 413);
});
