import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  listPublishedPreviews,
  loadPublishedPreview,
  PreviewMediaError,
  type PreviewAssociation,
} from '../services/previewMediaFetch.js';

after(closeConnection);

const association: PreviewAssociation = { kind: 'pull', repository: 'acme/web', number: 49 };
const imageId = 'image-asset';
const videoId = 'video-asset';
const attachment = (assetId: string) => `https://github.com/user-attachments/assets/${assetId}`;
const publishedBody = `![Unpublished](${attachment('unpublished')})
<!-- propr-visual-preview -->
### Dashboard

![Dashboard](${attachment(imageId)})

Current dashboard state.

### Walkthrough

![](${attachment(videoId)})

The completed interaction.`;

function reader(enabled = true) {
  return { enabledRepositories: async () => new Set(enabled ? ['acme/web'] : []) };
}

function octokit(body = publishedBody, bodyHtml = '') {
  return { request: async () => ({ data: { body, body_html: bodyHtml } }) } as never;
}

function expectPreviewError(code: PreviewMediaError['code']) {
  return (error: unknown) => error instanceof PreviewMediaError && error.code === code;
}

test('lists only published GitHub attachments and includes their asset identities', async () => {
  const previews = await listPublishedPreviews({ association, octokit: octokit(), reader: reader() });

  assert.deepEqual(previews, [
    {
      type: 'image', title: 'Dashboard', description: 'Current dashboard state.',
      url: attachment(imageId), assetId: imageId,
    },
    {
      type: 'video', title: 'Walkthrough', description: 'The completed interaction.',
      url: attachment(videoId), assetId: videoId,
    },
  ]);
});

test('rejects an asset that was not published by ProPR without fetching it', async () => {
  let fetched = false;
  await assert.rejects(loadPublishedPreview({
    association,
    assetId: 'unpublished',
    token: 'user-token',
    octokit: octokit(),
    reader: reader(),
    fetch: async () => { fetched = true; return new Response(); },
  }), expectPreviewError('PREVIEW_NOT_FOUND'));
  assert.equal(fetched, false);
});

test('rejects disabled repositories before calling GitHub', async () => {
  let githubCalls = 0;
  await assert.rejects(listPublishedPreviews({
    association,
    reader: reader(false),
    octokit: { request: async () => { githubCalls += 1; return { data: {} }; } } as never,
  }), expectPreviewError('PREVIEWS_DISABLED'));
  assert.equal(githubCalls, 0);
});

test('enforces a lower caller-provided body limit', async () => {
  await assert.rejects(loadPublishedPreview({
    association,
    assetId: imageId,
    token: 'user-token',
    octokit: octokit(),
    reader: reader(),
    maxBytes: 1024,
    fetch: async () => new Response(Buffer.alloc(2048), {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }),
  }), expectPreviewError('PREVIEW_TOO_LARGE'));
});
