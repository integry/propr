import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  appendVisualPreviewSection,
  buildVisualPreviewPrompt,
  collectVisualPreviewEvidence,
  renderVisualPreviewSection,
  VISUAL_PREVIEW_MARKER,
  VISUAL_PREVIEW_SLOT
} from '../src/services/visualPreviewService.js';

const temporaryDirectories: string[] = [];

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
  assert.match(prompt, /\.propr\/previews\/manifest\.json/);
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

test('renders upload-ready local media and stable committed-file fallbacks', async () => {
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
    owner: 'integry', repo: 'propr', commitHash: 'abc123', useLocalPaths: true
  });
  assert.match(local, new RegExp(VISUAL_PREVIEW_MARKER));
  assert.match(local, /Settings \\\[desktop\\\]/);
  assert.match(local, /\(<.*desktop view\.png>\)/);

  const fallback = renderVisualPreviewSection(evidence, {
    owner: 'integry', repo: 'propr', commitHash: 'abc123'
  });
  assert.match(fallback, /github\.com\/integry\/propr\/blob\/abc123\/\.propr\/previews\/desktop%20view\.png\?raw=true/);
  assert.equal(appendVisualPreviewSection(`Before\n\n${VISUAL_PREVIEW_SLOT}\n\nAfter`, fallback), `Before\n\n${fallback}\n\nAfter`);
});

test('renders committed videos as playable links and local videos as upload references', () => {
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
    owner: 'integry', repo: 'propr', commitHash: 'abc123', useLocalPaths: true
  });
  assert.match(local, /!\[\]\(\/worktree\/\.propr\/previews\/walkthrough\.mp4\)/);

  const fallback = renderVisualPreviewSection(evidence, {
    owner: 'integry', repo: 'propr', commitHash: 'abc123'
  });
  assert.match(fallback, /\[Watch Settings walkthrough\]\(https:\/\/github\.com\/integry\/propr\/blob\/abc123\/\.propr\/previews\/walkthrough\.mp4\?raw=true\)/);
  assert.doesNotMatch(fallback, /!\[\]/);
});
