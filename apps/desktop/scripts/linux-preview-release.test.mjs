import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import {
  linuxPreviewTag,
  linuxPreviewInstallNotes,
  prepareLinuxPreview,
  publishLinuxPreviewDraft,
  readLinuxPreviewBundle,
  stageLinuxPreviewDraft,
} from './linux-preview-release.mjs';
import { signReleaseMetadata } from './release-artifacts.mjs';
import { publishDesktopRelease } from './release-publish.mjs';
import {
  expectedProfileArtifacts,
  LINUX_PREVIEW_RELEASE_PROFILE,
  resolveReleaseProfile,
} from './release-profiles.mjs';

const version = '1.2.3';
const sourceRevision = '1'.repeat(40);
const repository = 'integry/propr';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeAppImage = `propr/app:${sourceRevision}@sha256:${'a'.repeat(64)}`;
const runtimeUiImage = `propr/ui:${sourceRevision}@sha256:${'b'.repeat(64)}`;

const createValidatedInput = async root => {
  const inputDirectory = join(root, 'validated');
  await mkdir(inputDirectory);
  const profile = resolveReleaseProfile(LINUX_PREVIEW_RELEASE_PROFILE);
  const artifacts = [];
  for (const [fileName, metadata] of expectedProfileArtifacts(profile, version)) {
    const bytes = Buffer.from(`${metadata.platform}-${metadata.arch}-${metadata.kind}\n`);
    await writeFile(join(inputDirectory, fileName), bytes);
    artifacts.push({
      ...metadata,
      fileName,
      size: bytes.length,
      sha256: digest(bytes),
      architectureEvidence: { format: metadata.kind, executable: { architectures: [metadata.arch] } },
    });
  }
  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  await writeFile(join(inputDirectory, 'desktop-release.json'), `${JSON.stringify({
    schemaVersion: 2,
    releaseProfile: LINUX_PREVIEW_RELEASE_PROFILE,
    channel: 'validation',
    version,
    tag: `desktop-v${version}`,
    publishedAt: '2026-09-12T00:00:00.000Z',
    feeds: {},
    nativeSigners: {},
    artifacts,
  }, null, 2)}\n`);
  await writeFile(join(inputDirectory, 'SHA256SUMS'), `${artifacts
    .map(artifact => `${artifact.sha256}  ${artifact.fileName}`).join('\n')}\n`);
  return inputDirectory;
};

const createBundle = async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-linux-preview-test-'));
  const inputDirectory = await createValidatedInput(root);
  const directory = join(root, 'bundle');
  const manifest = await prepareLinuxPreview({
    inputDirectory,
    outputDirectory: directory,
    version,
    sourceRevision,
    runtimeAppImage,
    runtimeUiImage,
    repository,
    workflowRunId: '1234',
    createdAt: '2026-09-12T09:00:00.000Z',
  });
  return { root, directory, manifest };
};

const response = ({ status = 200, value, bytes }) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => value,
  body: bytes === undefined ? undefined : Readable.from([bytes]),
  headers: new Headers(bytes === undefined ? {} : { 'content-length': String(bytes.length) }),
});

const createGitHub = () => {
  const state = {
    release: undefined,
    releaseListPrefix: [],
    releaseListCalls: [],
    createCalls: 0,
    tagLookupCalls: 0,
    assets: [],
    patchCalls: 0,
    published: false,
  };
  const draft = () => ({
    id: 7,
    tag_name: linuxPreviewTag(version, sourceRevision),
    target_commitish: sourceRevision,
    draft: true,
    prerelease: true,
    published_at: null,
    name: `ProPR Desktop Linux preview ${version} (${sourceRevision.slice(0, 12)})`,
    body: linuxPreviewInstallNotes({
      version,
      sourceRevision,
      tag: linuxPreviewTag(version, sourceRevision),
    }),
    upload_url: 'https://uploads.github.com/releases/7/assets{?name,label}',
  });
  state.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/repos/integry/propr', '');
    const method = options.method ?? 'GET';
    if (path.startsWith('/git/ref/tags/')) {
      return state.published ? response({ value: { object: { sha: '2'.repeat(40) } } }) : response({ status: 404 });
    }
    if (path === `/commits/${sourceRevision}` || path.startsWith('/commits/desktop-linux-preview-')) {
      return response({ value: { sha: sourceRevision } });
    }
    if (path.startsWith('/releases/tags/')) {
      state.tagLookupCalls += 1;
      return response({ status: 404 });
    }
    if (path === '/releases' && method === 'GET') {
      const page = Number(parsed.searchParams.get('page'));
      const releases = [...state.releaseListPrefix, ...(state.release ? [state.release] : [])];
      state.releaseListCalls.push(page);
      return response({ value: releases.slice((page - 1) * 100, page * 100) });
    }
    if (path === '/releases' && method === 'POST') {
      const input = JSON.parse(options.body);
      assert.equal(input.draft, true);
      assert.equal(input.prerelease, true);
      assert.equal(input.target_commitish, sourceRevision);
      state.createCalls += 1;
      state.release = draft();
      return response({ status: 201, value: state.release });
    }
    if (path === '/releases/7/assets' && method === 'GET') return response({ value: state.assets });
    if (parsed.host === 'uploads.github.com' && method === 'POST') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const name = parsed.searchParams.get('name');
      const asset = {
        id: state.assets.length + 1,
        name,
        state: 'uploaded',
        size: bytes.length,
        digest: `sha256:${digest(bytes)}`,
        url: `https://api.github.com/assets/${state.assets.length + 1}`,
        bytes,
      };
      state.assets.push(asset);
      return response({ status: 201, value: asset });
    }
    if (parsed.host === 'api.github.com' && path.startsWith('/assets/')) {
      const asset = state.assets.find(candidate => candidate.url === url);
      return asset ? response({ bytes: asset.bytes }) : response({ status: 404 });
    }
    if (path === '/releases/7' && method === 'GET') return response({ value: state.release });
    if (path === '/releases/7' && method === 'PATCH') {
      const input = JSON.parse(options.body);
      assert.deepEqual(input, { draft: false, prerelease: true, make_latest: 'false' });
      state.patchCalls += 1;
      state.published = true;
      state.release = {
        ...state.release,
        draft: false,
        published_at: '2026-09-12T10:00:00.000Z',
      };
      return response({ value: state.release });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return state;
};

describe('Linux preview release channel', () => {
  test('creates a four-package unsigned preview bundle bound to exact source and runtime digests', async () => {
    const { directory, manifest } = await createBundle();
    assert.equal(manifest.tag, `desktop-linux-preview-v${version}-${sourceRevision.slice(0, 12)}`);
    assert.equal(manifest.channel, 'linux-preview');
    assert.equal(manifest.trust, 'unsigned-preview');
    assert.deepEqual(manifest.upgrade, { selfUpdate: false, mode: 'manual-package-manager' });
    assert.equal(manifest.artifacts.length, 4);
    assert.deepEqual((await readdir(directory)).sort(), [
      'INSTALL.md',
      'ProPR-Desktop-1.2.3-linux-arm64.deb',
      'ProPR-Desktop-1.2.3-linux-arm64.rpm',
      'ProPR-Desktop-1.2.3-linux-x64.deb',
      'ProPR-Desktop-1.2.3-linux-x64.rpm',
      'SHA256SUMS',
      'linux-preview.json',
    ]);
    const bundle = await readLinuxPreviewBundle({ directory, version, sourceRevision, repository });
    assert.match(bundle.notes, /There is no apt\/dnf repository behind this preview/);
    assert.match(bundle.notes, /Linux self-updates are disabled/);
    assert.doesNotMatch(bundle.notes, /macOS|Windows/);
  });

  test('rejects a runtime image that is mutable or belongs to a different source revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-linux-preview-invalid-'));
    const inputDirectory = await createValidatedInput(root);
    await assert.rejects(prepareLinuxPreview({
      inputDirectory,
      outputDirectory: join(root, 'bundle'),
      version,
      sourceRevision,
      runtimeAppImage: `propr/app:${sourceRevision}`,
      runtimeUiImage,
      repository,
      workflowRunId: '1234',
    }), /digest-pinned/);
  });

  test('cannot enter the trusted update-signing or stable publication helpers', async () => {
    assert.equal(resolveReleaseProfile(LINUX_PREVIEW_RELEASE_PROFILE).previewOnly, true);
    await assert.rejects(signReleaseMetadata({
      inputDirectory: '/unused',
      outputDirectory: '/unused',
      version,
      profile: LINUX_PREVIEW_RELEASE_PROFILE,
    }), /cannot produce trusted update metadata/);
    await assert.rejects(publishDesktopRelease({
      repository,
      tag: `desktop-v${version}`,
      releaseSha: sourceRevision,
      tagObjectSha: '2'.repeat(40),
      directory: '/unused',
      profile: LINUX_PREVIEW_RELEASE_PROFILE,
      token: 'token',
    }), /explicitly authorized Linux preview publication channel/);
  });

  test('stages, resumes, and publishes via paginated release lists when release-by-tag returns 404', async () => {
    const { directory } = await createBundle();
    const github = createGitHub();
    const staged = await stageLinuxPreviewDraft({
      directory,
      version,
      sourceRevision,
      repository,
      token: 'token',
      fetchImpl: github.fetchImpl,
    });
    assert.equal(staged.tag, linuxPreviewTag(version, sourceRevision));
    assert.equal(github.patchCalls, 0);
    assert.equal(github.release.draft, true);
    assert.equal(github.assets.length, 7);
    assert.equal(github.createCalls, 1);

    github.releaseListPrefix = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      tag_name: `unrelated-${index}`,
    }));
    const resumed = await stageLinuxPreviewDraft({
      directory,
      version,
      sourceRevision,
      repository,
      token: 'token',
      fetchImpl: github.fetchImpl,
    });
    assert.equal(resumed.releaseId, staged.releaseId);
    assert.equal(github.createCalls, 1);
    assert.equal(github.assets.length, 7);
    assert.equal(github.patchCalls, 0);

    const published = await publishLinuxPreviewDraft({
      version,
      sourceRevision,
      repository,
      token: 'token',
      fetchImpl: github.fetchImpl,
      inspectArchitecture: async ({ kind, arch }) => ({
        format: kind,
        executable: { platform: 'linux', architectures: [arch] },
      }),
      inspectPackageVersion: async () => undefined,
    });
    assert.equal(published.draft, false);
    assert.equal(published.prerelease, true);
    assert.equal(github.patchCalls, 1);
    assert.equal(github.tagLookupCalls, 0);
    assert.deepEqual(github.releaseListCalls, [1, 1, 2, 1, 2]);
  });

  test('fails closed if finalized package bytes change before preview preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-linux-preview-drift-'));
    const inputDirectory = await createValidatedInput(root);
    await writeFile(join(inputDirectory, 'ProPR-Desktop-1.2.3-linux-x64.deb'), 'changed');
    await assert.rejects(prepareLinuxPreview({
      inputDirectory,
      outputDirectory: join(root, 'bundle'),
      version,
      sourceRevision,
      runtimeAppImage,
      runtimeUiImage,
      repository,
      workflowRunId: '1234',
    }), /bytes drifted/);
  });
});
