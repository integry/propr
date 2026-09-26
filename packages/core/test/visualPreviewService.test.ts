import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { simpleGit } from 'simple-git';
import { VISUAL_PREVIEW_CONTENT_TYPES } from '@propr/shared';
import {
  appendVisualPreviewSection,
  buildVisualPreviewPrompt,
  cleanupPreparedVisualPreviewEvidence,
  collectVisualPreviewEvidence,
  createPublishedVisualPreviewMetadata,
  prepareVisualPreviewEvidence,
  renderVisualPreviewSection,
  renderVisualPreviewUploadFailureSection,
  VISUAL_PREVIEW_MARKER,
  VISUAL_PREVIEW_SLOT,
  VISUAL_PREVIEW_SOURCE_DIRECTORY
} from '../src/services/visualPreviewService.js';
import { parsePublishedVisualPreviews } from '../src/services/publishedVisualPreviewService.js';

const temporaryDirectories: string[] = [];
const RESTORE_PREVIEW_UPLOADS_GUIDANCE = [
  '### Restore preview uploads',
  '',
  'An instance administrator must open the ProPR Web UI, go to **Settings → Visual preview uploads**, '
    + 'and add or replace the personal access token. The token must have access to this repository. GitHub '
    + 'rejects GitHub App user (`ghu_`) and installation (`ghs_`) tokens for attachments. A server operator can '
    + 'alternatively set `GITHUB_VISUAL_PREVIEW_TOKEN`; that environment override takes precedence over the Web '
    + 'UI credential. Then request the visual preview again.',
].join('\n');

const hybridRenderingEvidence = {
  taskId: 'task-2282',
  assets: [
    {
      relativePath: '.propr/previews/desktop.png', absolutePath: '/staged/desktop.png',
      type: 'image' as const, title: 'Desktop', description: 'Changed controls.', sizeBytes: 7,
    },
    {
      relativePath: '.propr/previews/mobile.png', absolutePath: '/staged/mobile.png',
      type: 'image' as const, title: 'Mobile', description: 'Changed controls.', sizeBytes: 8,
    },
  ],
  toolSuggestions: [],
};

function managedOriginal(assetIndex: number) {
  const filename = assetIndex === 0 ? 'desktop.png' : 'mobile.png';
  return {
    version: 1 as const, artifactId: `artifact-${assetIndex}`, state: 'ready' as const,
    taskId: 'task-2282', repository: 'integry/propr', pullRequestNumber: 42,
    displayFilename: filename, sizeBytes: hybridRenderingEvidence.assets[assetIndex].sizeBytes,
    contentType: 'image/png' as const, sha256: String(assetIndex).repeat(64),
    viewerUrl: `https://connect.example.test/previews/artifact-${assetIndex}`,
    retentionExpiresAt: '2099-01-01T00:00:00Z',
  };
}

function renderPublishedAssets(assets: Parameters<typeof createPublishedVisualPreviewMetadata>[1]['assets']): string {
  const published = createPublishedVisualPreviewMetadata(hybridRenderingEvidence, {
    taskId: 'task-2282', repository: 'integry/propr', pullRequestNumber: 42,
    trustedConnectOrigin: 'https://connect.example.test', assets,
  });
  return renderVisualPreviewSection(hybridRenderingEvidence, { published });
}

async function createWorktree(): Promise<string> {
  const worktree = await mkdtemp(path.join(tmpdir(), 'propr-visual-preview-'));
  temporaryDirectories.push(worktree);
  await mkdir(path.join(worktree, '.propr/previews'), { recursive: true });
  return worktree;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('visual preview prompt is conditional and carries repository instructions', () => {
  assert.equal(buildVisualPreviewPrompt({ enabled: false, types: ['image'] }), '');
  const prompt = buildVisualPreviewPrompt({
    enabled: true,
    types: ['image', 'video'],
    instructions: 'Capture separate desktop and mobile views.'
  });

  assert.match(prompt, /perceptible visually/);
  assert.match(prompt, /never expand the implementation scope/);
  assert.match(prompt, /explicitly asks to generate or refresh previews/);
  assert.match(prompt, /\.propr\/previews\/manifest\.json/);
  assert.match(prompt, /Do not link to local preview or manifest paths/);
  assert.match(prompt, /image and video/);
  assert.match(prompt, /Capture separate desktop and mobile views\./);
  assert.match(prompt, /toolSuggestions/);
});

test('collects only changed, selected, regular preview files and applies manifest metadata', async () => {
  const worktree = await createWorktree();
  await writeFile(path.join(worktree, '.propr/previews/desktop.png'), 'png');
  await writeFile(path.join(worktree, '.propr/previews/empty.png'), '');
  await writeFile(path.join(worktree, '.propr/previews/walkthrough.mp4'), 'video');
  await writeFile(path.join(worktree, 'outside.png'), 'outside');
  await symlink(path.join(worktree, 'outside.png'), path.join(worktree, '.propr/previews/symlink.png'));
  await writeFile(path.join(worktree, '.propr/previews/manifest.json'), JSON.stringify({
    previews: [{
      path: 'desktop.png',
      title: 'Changed settings [desktop]',
      description: 'The new preview controls.'
    }],
    toolSuggestions: [{ name: 'Android emulator', reason: 'Capture the native mobile layout.' }]
  }));

  const evidence = await collectVisualPreviewEvidence({
    worktreePath: worktree,
    changedFiles: [
      '.propr/previews/desktop.png',
      '.propr/previews/empty.png',
      '.propr/previews/walkthrough.mp4',
      '.propr/previews/symlink.png',
      '.propr/previews/manifest.json',
      'outside.png'
    ],
    settings: { enabled: true, types: ['image'] }
  });

  assert.deepEqual(evidence.assets.map(asset => ({
    relativePath: asset.relativePath,
    type: asset.type,
    title: asset.title,
    description: asset.description
  })), [{
    relativePath: '.propr/previews/desktop.png',
    type: 'image',
    title: 'Changed settings [desktop]',
    description: 'The new preview controls.'
  }]);
  assert.deepEqual(evidence.toolSuggestions, [{
    name: 'Android emulator',
    reason: 'Capture the native mobile layout.'
  }]);
});

test('renders upload-ready local media without committed-file fallbacks', async () => {
  const worktree = await createWorktree();
  const relativePath = '.propr/previews/desktop view.png';
  const absolutePath = path.join(worktree, relativePath);
  await writeFile(absolutePath, 'png');
  const evidence = {
    assets: [{
      relativePath,
      absolutePath,
      type: 'image' as const,
      title: 'Settings [desktop]',
      description: 'Focused on the changed controls.'
    }],
    toolSuggestions: []
  };

  const local = renderVisualPreviewSection(evidence, {
    useLocalPaths: true
  });
  assert.match(local, new RegExp(VISUAL_PREVIEW_MARKER));
  assert.match(local, /Settings \\\[desktop\\\]/);
  assert.match(local, /\(<.*desktop view\.png>\)/);

  assert.equal(renderVisualPreviewSection(evidence, {}), '');
  const failure = renderVisualPreviewUploadFailureSection(evidence);
  assert.match(failure, /could not be uploaded to GitHub/);
  assert.match(failure, /No preview files were committed/);
  assert.doesNotMatch(failure, /desktop view\.png/);
  const authenticationFailure = renderVisualPreviewUploadFailureSection(evidence, { authenticationFailure: true });
  assert.match(authenticationFailure, /Settings → Visual preview uploads/);
  assert.match(authenticationFailure, /add or replace the personal access token/);
  assert.match(authenticationFailure, /GitHub App user \(`ghu_`\)/);
  assert.match(authenticationFailure, /GITHUB_VISUAL_PREVIEW_TOKEN/);
  assert.equal(appendVisualPreviewSection(`Before\n\n${VISUAL_PREVIEW_SLOT}\n\nAfter`, failure), `Before\n\n${failure}\n\nAfter`);
});

test('renders videos only as local upload references', () => {
  const evidence = {
    assets: [{
      relativePath: '.propr/previews/walkthrough.mp4',
      absolutePath: '/worktree/.propr/previews/walkthrough.mp4',
      type: 'video' as const,
      title: 'Settings walkthrough'
    }],
    toolSuggestions: []
  };

  const local = renderVisualPreviewSection(evidence, {
    useLocalPaths: true
  });
  assert.match(local, /!\[\]\(\/worktree\/\.propr\/previews\/walkthrough\.mp4\)/);
  assert.equal(renderVisualPreviewSection(evidence, {}), '');
});

test('renders hybrid previews only from validated structured publication metadata', () => {
  const previewEvidence = {
    taskId: 'task-2282',
    assets: [{
      relativePath: '.propr/previews/desktop.png', absolutePath: '/staged/desktop.png',
      type: 'image' as const, title: 'Desktop', description: 'Changed controls.', sizeBytes: 7,
    }],
    toolSuggestions: [],
  };
  const artifact = {
    version: 1 as const, artifactId: 'artifact-1', state: 'ready' as const,
    taskId: 'task-2282', repository: 'integry/propr', pullRequestNumber: 42,
    displayFilename: 'desktop.png', sizeBytes: 7, contentType: 'image/png', sha256: 'a'.repeat(64),
    viewerUrl: 'https://connect.example.test/previews/artifact-1', retentionExpiresAt: '2099-01-01T00:00:00Z',
  };
  const published = createPublishedVisualPreviewMetadata(previewEvidence, {
    taskId: 'task-2282', repository: 'integry/propr', pullRequestNumber: 42,
    trustedConnectOrigin: 'https://connect.example.test',
    assets: [{
      assetIndex: 0, relativePath: '.propr/previews/desktop.png',
      githubAttachmentUrl: 'https://github.com/user-attachments/assets/github-asset',
      managedOriginal: artifact,
    }],
  });
  const section = renderVisualPreviewSection(previewEvidence, { published });
  assert.match(section, /!\[Desktop\]\(https:\/\/github\.com\/user-attachments\/assets\/github-asset\)/);
  assert.match(section, /\[View the full-resolution original in ProPR Connect\]\(https:\/\/connect\.example\.test\/previews\/artifact-1\)/);
  assert.deepEqual(parsePublishedVisualPreviews(section), [{
    type: 'image', title: 'Desktop', description: 'Changed controls.',
    url: 'https://github.com/user-attachments/assets/github-asset',
  }]);

  const untrusted = createPublishedVisualPreviewMetadata(previewEvidence, {
    taskId: 'task-2282', repository: 'integry/propr', pullRequestNumber: 42,
    trustedConnectOrigin: 'https://connect.example.test',
    assets: [{
      assetIndex: 0, relativePath: '.propr/previews/desktop.png',
      githubAttachmentUrl: 'https://example.com/agent.png',
      managedOriginal: { ...artifact, viewerUrl: 'https://public.example.com/original.png' },
      unavailableReason: 'github-inline-limit',
    }],
  });
  const safeSection = renderVisualPreviewSection(previewEvidence, { published: untrusted });
  assert.doesNotMatch(safeSection, /example\.com\/agent|public\.example/);
  assert.match(safeSection, /does not fit the resolved GitHub inline limit/);
});

test('hybrid rendering includes complete recovery guidance for an authentication failure without a managed original', () => {
  const section = renderPublishedAssets([{
    assetIndex: 0,
    relativePath: hybridRenderingEvidence.assets[0].relativePath,
    unavailableReason: 'github-authentication-failed',
  }]);

  assert.match(section, /The preview could not be uploaded to GitHub\./);
  assert.ok(section.includes(RESTORE_PREVIEW_UPLOADS_GUIDANCE));
});

test('hybrid rendering preserves a managed original and complete recovery guidance after an authentication failure', () => {
  const section = renderPublishedAssets([{
    assetIndex: 0,
    relativePath: hybridRenderingEvidence.assets[0].relativePath,
    managedOriginal: managedOriginal(0),
    unavailableReason: 'github-authentication-failed',
  }]);

  assert.match(section, /\[View the full-resolution original in ProPR Connect\]\(https:\/\/connect\.example\.test\/previews\/artifact-0\)/);
  assert.match(section, /the authenticated original remains available above/);
  assert.ok(section.includes(RESTORE_PREVIEW_UPLOADS_GUIDANCE));
});

test('hybrid rendering includes authentication recovery guidance exactly once for multiple failures', () => {
  const section = renderPublishedAssets(hybridRenderingEvidence.assets.map((asset, assetIndex) => ({
    assetIndex,
    relativePath: asset.relativePath,
    unavailableReason: 'github-authentication-failed' as const,
  })));

  assert.equal(section.split('### Restore preview uploads').length - 1, 1);
  assert.equal(section.split(RESTORE_PREVIEW_UPLOADS_GUIDANCE).length - 1, 1);
});

test('hybrid rendering omits authentication recovery guidance for non-authentication inline failures', () => {
  const section = renderPublishedAssets([{
    assetIndex: 0,
    relativePath: hybridRenderingEvidence.assets[0].relativePath,
    managedOriginal: managedOriginal(0),
    unavailableReason: 'github-inline-failed',
  }]);

  assert.match(section, /the authenticated original remains available above/);
  assert.doesNotMatch(section, /### Restore preview uploads/);
  assert.equal(section.includes(RESTORE_PREVIEW_UPLOADS_GUIDANCE), false);
});

test('removing an empty preview slot preserves unrelated body whitespace', () => {
  const body = `  Before\n\n\nUnrelated spacing\n\n${VISUAL_PREVIEW_SLOT}\n\nAfter  `;
  assert.equal(
    appendVisualPreviewSection(body, ''),
    '  Before\n\n\nUnrelated spacing\n\n\n\nAfter  '
  );
});

test('extracts only ProPR-published GitHub attachment previews from a PR body', () => {
  const body = [
    'Untrusted earlier Markdown ![Ignore](https://example.com/tracker.png)',
    VISUAL_PREVIEW_MARKER,
    '## Visual preview',
    '',
    '### Desktop \\*settings\\*',
    '',
    '![Desktop \\*settings\\*](https://github.com/user-attachments/assets/e3ee42c8-04a1-4ff7-af1a-1735cf52d06f)',
    '',
    'The changed settings screen.',
    '',
    '### Walkthrough',
    '',
    '![](https://github.com/user-attachments/assets/44384b71-8a61-4cc5-bd62-f4e882fd270a)',
    '',
    '### Suggested agent tools',
    '',
    '- **Browser:** capture UI',
  ].join('\n');

  assert.deepEqual(parsePublishedVisualPreviews(body), [
    {
      type: 'image',
      title: 'Desktop *settings*',
      description: 'The changed settings screen.',
      url: 'https://github.com/user-attachments/assets/e3ee42c8-04a1-4ff7-af1a-1735cf52d06f',
    },
    {
      type: 'video',
      title: 'Walkthrough',
      url: 'https://github.com/user-attachments/assets/44384b71-8a61-4cc5-bd62-f4e882fd270a',
    },
  ]);
  assert.deepEqual(parsePublishedVisualPreviews(`${VISUAL_PREVIEW_MARKER}\n### Unsafe\n\n![Unsafe](https://example.com/a.png)`), []);
});

test('stages changed previews outside the repository and restores the preview directory to HEAD', async () => {
  const worktree = await createWorktree();
  const git = simpleGit(worktree);
  await git.init();
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
  await writeFile(path.join(worktree, '.propr/previews/tracked.png'), 'original');
  await mkdir(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY), { recursive: true });
  await writeFile(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY, 'tracked.html'), 'original source');
  await git.add('.');
  await git.commit('initial preview');

  await writeFile(path.join(worktree, '.propr/previews/tracked.png'), 'updated');
  await writeFile(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY, 'tracked.html'), 'updated source');
  await writeFile(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY, 'scratch.js'), 'preview source');
  await writeFile(path.join(worktree, '.propr/previews/desktop.png'), 'desktop');
  await writeFile(path.join(worktree, '.propr/previews/manifest.json'), JSON.stringify({
    previews: [{ path: 'desktop.png', title: 'Desktop settings' }]
  }));
  await git.add(['.propr/previews', VISUAL_PREVIEW_SOURCE_DIRECTORY]);

  const prepared = await prepareVisualPreviewEvidence({
    worktreePath: worktree,
    settings: { enabled: true, types: ['image'] },
    taskId: 'task/42'
  });

  assert.ok(prepared.temporaryDirectory?.startsWith(path.join(tmpdir(), 'propr-previews', 'task-42-')));
  assert.equal(prepared.evidence.taskId, 'task/42');
  assert.deepEqual(prepared.evidence.assets.map(asset => asset.title), ['Desktop settings', 'Tracked']);
  assert.equal(await readFile(prepared.evidence.assets[0].absolutePath, 'utf8'), 'desktop');
  assert.equal(await readFile(path.join(worktree, '.propr/previews/tracked.png'), 'utf8'), 'original');
  assert.equal(
    await readFile(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY, 'tracked.html'), 'utf8'),
    'original source'
  );
  await assert.rejects(access(path.join(worktree, VISUAL_PREVIEW_SOURCE_DIRECTORY, 'scratch.js')));
  await assert.rejects(access(path.join(worktree, '.propr/previews/desktop.png')));
  await assert.rejects(access(path.join(worktree, '.propr/previews/manifest.json')));
  assert.equal((await git.status()).files.length, 0);

  const stagedDirectory = prepared.temporaryDirectory;
  await cleanupPreparedVisualPreviewEvidence(prepared);
  await assert.rejects(access(stagedDirectory!));
});

test('stages previews even when the repository ignores the transient directory', async () => {
  const worktree = await createWorktree();
  const git = simpleGit(worktree);
  await git.init();
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
  await writeFile(path.join(worktree, '.gitignore'), '.propr/previews/\n');
  await git.add('.gitignore');
  await git.commit('ignore runtime previews');

  await writeFile(path.join(worktree, '.propr/previews/mobile.png'), 'mobile');
  await writeFile(path.join(worktree, '.propr/previews/manifest.json'), JSON.stringify({
    previews: [{ path: 'mobile.png', title: 'Mobile settings' }]
  }));

  const prepared = await prepareVisualPreviewEvidence({
    worktreePath: worktree,
    settings: { enabled: true, types: ['image'] },
    taskId: 'ignored-preview'
  });

  assert.deepEqual(prepared.evidence.assets.map(asset => asset.title), ['Mobile settings']);
  assert.equal(await readFile(prepared.evidence.assets[0].absolutePath, 'utf8'), 'mobile');
  await assert.rejects(access(path.join(worktree, '.propr/previews')));
  await cleanupPreparedVisualPreviewEvidence(prepared);
});

test('collection enforces image and video byte boundaries with conservative auto fallback', async () => {
  const { truncate } = await import('node:fs/promises');
  const { MIB, resolveGitHubAttachmentCapacity } = await import('@propr/shared');
  const worktree = await createWorktree();
  for (const extension of ['png', 'jpeg', 'gif', 'svg', 'webp', 'mp4', 'mov', 'webm', 'pdf']) {
    const relativePath = `.propr/previews/boundary.${extension}`;
    await writeFile(path.join(worktree, relativePath), '');
    for (const override of ['auto', 'free', 'paid'] as const) {
      const isVideo = ['mp4', 'mov', 'webm'].includes(extension);
      const limit = (override === 'paid' && isVideo ? 100 : 10) * MIB;
      for (const size of [10 * MIB, 10 * MIB + 1, limit, limit + 1]) {
        await truncate(path.join(worktree, relativePath), size);
        const evidence = await collectVisualPreviewEvidence({ worktreePath: worktree, changedFiles: [relativePath], settings: { enabled: true, types: ['image', 'video'], githubAttachmentPlan: override } });
        assert.equal(evidence.assets.length, extension !== 'pdf' && size <= limit ? 1 : 0, `${extension}, ${override}, ${size}`);
      }
    }
  }
  const relativePath = '.propr/previews/boundary.mp4';
  await truncate(path.join(worktree, relativePath), 20 * MIB);
  const evidence = await collectVisualPreviewEvidence({ worktreePath: worktree, changedFiles: [relativePath], settings: { enabled: true, types: ['video'], githubAttachmentCapacity: resolveGitHubAttachmentCapacity('auto', 'paid') } });
  assert.equal(evidence.assets.length, 1);
  assert.equal(evidence.githubAttachmentCapacity?.videoLimitBytes, 100 * MIB);
});

test('managed collection keeps supported originals beyond inline limits but enforces the independent staging limit', async () => {
  const { truncate } = await import('node:fs/promises');
  const { MIB } = await import('@propr/shared');
  const worktree = await createWorktree();
  for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp4', 'mov', 'webm', 'pdf']) {
    const relativePath = `.propr/previews/original.${extension}`;
    const absolutePath = path.join(worktree, relativePath);
    await writeFile(absolutePath, '');
    for (const maxBytes of [20 * MIB, 500 * MIB]) {
      for (const sizeBytes of [maxBytes, maxBytes + 1]) {
        await truncate(absolutePath, sizeBytes);
        const evidence = await collectVisualPreviewEvidence({
          worktreePath: worktree, changedFiles: [relativePath],
          settings: { enabled: true, types: ['image', 'video'], originalEvidenceCapability: { maxBytes, allowedContentTypes: Object.values(VISUAL_PREVIEW_CONTENT_TYPES) } },
        });
        assert.equal(evidence.assets.length, extension !== 'pdf' && sizeBytes <= maxBytes ? 1 : 0, `${extension}, ${maxBytes}, ${sizeBytes}`);
        if (evidence.assets.length) {
          assert.equal(evidence.assets[0].sizeBytes, sizeBytes);
          assert.deepEqual(evidence.assets[0].githubInline, { eligible: false, reason: 'size-limit-exceeded', limitBytes: 10 * MIB });
          assert.deepEqual(evidence.toolSuggestions, [], 'inline-ineligible originals do not require compression');
        } else if (extension !== 'pdf') {
          assert.match(evidence.toolSuggestions[0].reason, /staging safety limit/);
        }
      }
    }
  }
});

test('PNG-only managed storage leaves an oversized video on the legacy staging limit', async () => {
  const { truncate } = await import('node:fs/promises');
  const { MIB } = await import('@propr/shared');
  const worktree = await createWorktree();
  const videoPath = '.propr/previews/unsupported.mp4';
  await writeFile(path.join(worktree, videoPath), '');
  await truncate(path.join(worktree, videoPath), 20 * MIB);

  const evidence = await collectVisualPreviewEvidence({
    worktreePath: worktree,
    changedFiles: [videoPath],
    settings: {
      enabled: true,
      types: ['video'],
      originalEvidenceCapability: { maxBytes: 250 * MIB, allowedContentTypes: ['image/png'] },
    },
  });

  assert.equal(evidence.assets.length, 0);
  assert.equal(evidence.originalCapacity?.videoLimitBytes, 10 * MIB);
  assert.match(evidence.toolSuggestions[0].reason, /not accepted by managed storage/);
  assert.match(evidence.toolSuggestions[0].reason, /legacy original-evidence staging safety limit/);
});

test('prompt distinguishes managed originals from inline publication without instructing originals to shrink', () => {
  const prompt = buildVisualPreviewPrompt({
    enabled: true, types: ['image', 'video'], githubAttachmentPlan: 'paid',
    originalEvidenceCapability: { maxBytes: 500 * 1024 * 1024, allowedContentTypes: Object.values(VISUAL_PREVIEW_CONTENT_TYPES) },
  });
  assert.match(prompt, /GitHub inline publication limits: images at or below 10 MiB; videos at or below 100 MiB/);
  assert.match(prompt, /keep each original at or below 500 MiB/);
  assert.match(prompt, /authenticated viewer links/);
  assert.match(prompt, /Do not shrink an original solely to fit GitHub inline upload/);
  const legacy = buildVisualPreviewPrompt({ enabled: true, types: ['video'] });
  assert.match(legacy, /Managed-original storage is unavailable/);
  assert.match(legacy, /legacy original-evidence staging safety limits/);
  assert.doesNotMatch(legacy, /authenticated viewer links/);

  const partial = buildVisualPreviewPrompt({
    enabled: true,
    types: ['image', 'video'],
    originalEvidenceCapability: { maxBytes: 250 * 1024 * 1024, allowedContentTypes: ['image/png'] },
  });
  assert.match(partial, /available only for these content types: image\/png/);
  assert.match(partial, /Other requested content types are not accepted by managed storage/);
  assert.match(partial, /compress or regenerate an oversized unsupported type/);
});
