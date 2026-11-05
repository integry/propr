import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  formatGithubOutputs,
  previewTag,
  resolveDesktopPreviewIdentity,
} from './desktop-preview-identity.mjs';

const script = resolve(import.meta.dirname, 'desktop-preview-identity.mjs');
let root;
let oldSource;
let source;
let main;
let unrelated;

const git = (...args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Preview Test', GIT_AUTHOR_EMAIL: 'preview@example.test',
    GIT_COMMITTER_NAME: 'Preview Test', GIT_COMMITTER_EMAIL: 'preview@example.test',
    GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z',
  },
}).trim();

const commit = async (files, message) => {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

const images = sha => ({
  runtimeAppImage: `propr/app:${sha}@sha256:${'a'.repeat(64)}`,
  runtimeUiImage: `propr/ui:${sha}@sha256:${'b'.repeat(64)}`,
  runtimeAgentImage: `propr/agent:${sha}@sha256:${'c'.repeat(64)}`,
});

const valid = (overrides = {}) => ({
  channel: 'macos',
  dispatchRef: 'refs/heads/main',
  requestedSha: source,
  workflowSha: main,
  ...images(source),
  cwd: root,
  ...overrides,
});

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'propr-preview-identity-'));
  git('init', '-q', '-b', 'main');
  oldSource = await commit({ 'apps/desktop/package.json': '{"version":"0.8.0"}\n' }, 'before macOS preview tooling');
  source = await commit({
    'apps/desktop/package.json': '{"version":"0.9.0"}\n',
    'apps/desktop/scripts/macos-preview-release.mjs': '// fixture\n',
    'apps/desktop/scripts/sign-darwin-local-package.mjs': '// fixture\n',
  }, 'macOS preview tooling');
  main = await commit({ 'README.md': 'later main commit\n' }, 'later main');
  git('checkout', '-q', '--orphan', 'unrelated');
  unrelated = await commit({ 'apps/desktop/package.json': '{"version":"9.9.9"}\n' }, 'unrelated history');
  git('checkout', '-q', 'main');
});

after(() => rm(root, { recursive: true, force: true }));

describe('desktop preview identity binding', () => {
  test('binds a main-reachable source to version, tag, epoch, and the three pinned runtime images', async () => {
    const identity = await resolveDesktopPreviewIdentity(valid());
    assert.deepEqual(identity, {
      release_sha: source,
      version: '0.9.0',
      tag: `desktop-macos-preview-v0.9.0-${source.slice(0, 12)}`,
      source_date_epoch: String(Date.parse('2026-10-01T00:00:00Z') / 1000),
      runtime_app_image: images(source).runtimeAppImage,
      runtime_ui_image: images(source).runtimeUiImage,
      runtime_agent_image: images(source).runtimeAgentImage,
    });
    // The version comes from the frozen source, not the newer main checkout.
    const linux = await resolveDesktopPreviewIdentity(valid({ channel: 'linux', requestedSha: oldSource, ...images(oldSource) }));
    assert.equal(linux.tag, `desktop-linux-preview-v0.8.0-${oldSource.slice(0, 12)}`);
  });

  test('refuses non-main dispatches, malformed or unreachable sources, and a foreign checkout', async () => {
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ dispatchRef: 'refs/heads/feature' })),
      /Dispatch Desktop macOS Preview Release from the main branch workflow only/);
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ dispatchRef: 'refs/tags/desktop-v0.9.0' })), /main branch/);
    for (const requestedSha of [source.slice(0, 12), source.toUpperCase(), `${source} `, undefined]) {
      await assert.rejects(resolveDesktopPreviewIdentity(valid({ requestedSha })), /full lowercase 40-character/);
    }
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ requestedSha: 'f'.repeat(40), ...images('f'.repeat(40)) })),
      /not a commit in this repository/);
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ requestedSha: unrelated, ...images(unrelated) })),
      /reachable from the dispatched main revision/);
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ workflowSha: source })),
      /dispatched main workflow revision/);
  });

  test('refuses a macOS source that predates the macOS preview tooling', async () => {
    await assert.rejects(resolveDesktopPreviewIdentity(valid({ requestedSha: oldSource, ...images(oldSource) })),
      /predates the Desktop macOS Preview Release tooling/);
  });

  test('requires digest-pinned app, UI, and agent images tagged with the exact source revision', async () => {
    const other = '2'.repeat(40);
    const cases = [
      ['runtimeAppImage', `propr/app:${source}`, /propr\/app image tagged/],
      ['runtimeAppImage', `propr/app:${other}@sha256:${'a'.repeat(64)}`, /propr\/app image tagged/],
      ['runtimeUiImage', `propr/app:${source}@sha256:${'b'.repeat(64)}`, /propr\/ui image tagged/],
      ['runtimeUiImage', undefined, /propr\/ui image tagged/],
      ['runtimeAgentImage', 'propr/agent:0.9.0', /linux\/amd64 propr\/agent image/],
      ['runtimeAgentImage', ` propr/agent:${source}@sha256:${'c'.repeat(64)}`, /linux\/amd64 propr\/agent image/],
      ['runtimeAgentImage', `example/agent:${source}@sha256:${'c'.repeat(64)}`, /linux\/amd64 propr\/agent image/],
    ];
    for (const [key, value, message] of cases) {
      await assert.rejects(resolveDesktopPreviewIdentity(valid({ [key]: value })), message, `${key}=${value}`);
    }
  });

  test('CLI writes single-line GitHub outputs only on success', () => {
    const run = env => spawnSync(process.execPath, [script, '--channel', 'macos'], {
      cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, DISPATCH_REF: 'refs/heads/main', REQUESTED_SHA: source, WORKFLOW_SHA: main,
        RUNTIME_APP_IMAGE: images(source).runtimeAppImage, RUNTIME_UI_IMAGE: images(source).runtimeUiImage,
        RUNTIME_AGENT_IMAGE: images(source).runtimeAgentImage, ...env },
    });
    const ok = run({});
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`^release_sha=${source}$`, 'm'));
    assert.match(ok.stdout, /^tag=desktop-macos-preview-v0\.9\.0-[a-f0-9]{12}$/m);
    const failed = run({ DISPATCH_REF: 'refs/heads/other' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    assert.throws(() => formatGithubOutputs({ tag: 'a\nb=c' }), /single line/);
    assert.throws(() => previewTag('windows', '0.9.0', source), /known channel/);
  });
});
