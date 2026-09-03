import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { simpleGit } from 'simple-git';
import {
  appendVisualPreviewSection,
  buildVisualPreviewPrompt,
  cleanupPreparedVisualPreviewEvidence,
  collectVisualPreviewEvidence,
  prepareVisualPreviewEvidence,
  renderVisualPreviewSection,
  renderVisualPreviewUploadFailureSection,
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
  assert.match(authenticationFailure, /Use my GitHub login/);
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

test('removing an empty preview slot preserves unrelated body whitespace', () => {
  const body = `  Before\n\n\nUnrelated spacing\n\n${VISUAL_PREVIEW_SLOT}\n\nAfter  `;
  assert.equal(
    appendVisualPreviewSection(body, ''),
    '  Before\n\n\nUnrelated spacing\n\n\n\nAfter  '
  );
});

test('stages changed previews outside the repository and restores the preview directory to HEAD', async () => {
  const worktree = await createWorktree();
  const git = simpleGit(worktree);
  await git.init();
  await git.addConfig('user.name', 'ProPR Test');
  await git.addConfig('user.email', 'test@propr.dev');
  await writeFile(path.join(worktree, '.propr/previews/tracked.png'), 'original');
  await git.add('.');
  await git.commit('initial preview');

  await writeFile(path.join(worktree, '.propr/previews/tracked.png'), 'updated');
  await writeFile(path.join(worktree, '.propr/previews/desktop.png'), 'desktop');
  await writeFile(path.join(worktree, '.propr/previews/manifest.json'), JSON.stringify({
    previews: [{ path: 'desktop.png', title: 'Desktop settings' }]
  }));
  await git.add('.propr/previews');

  const prepared = await prepareVisualPreviewEvidence({
    worktreePath: worktree,
    settings: { enabled: true, types: ['image'] },
    taskId: 'task/42'
  });

  assert.ok(prepared.temporaryDirectory?.startsWith(path.join(tmpdir(), 'propr-previews', 'task-42-')));
  assert.deepEqual(prepared.evidence.assets.map(asset => asset.title), ['Desktop settings', 'Tracked']);
  assert.equal(await readFile(prepared.evidence.assets[0].absolutePath, 'utf8'), 'desktop');
  assert.equal(await readFile(path.join(worktree, '.propr/previews/tracked.png'), 'utf8'), 'original');
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
