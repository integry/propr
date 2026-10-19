import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import {
  linuxPreviewTag,
  linuxPreviewInstallNotes,
  prepareLinuxPreview,
  publishLinuxPreviewDraft,
  readLinuxPreviewBundle,
  readHistoricalLinuxPreviewMetadata,
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
const runtimeAgentImage = `propr/agent:${sourceRevision}@sha256:${'c'.repeat(64)}`;

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
    runtimeAgentImage,
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

  test('binds the exact linux/amd64 managed agent beside app/UI in metadata and checksums', async () => {
    const { directory, manifest } = await createBundle();
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.runtime, {
      distribution: 'published',
      appImage: runtimeAppImage,
      uiImage: runtimeUiImage,
      agentImage: runtimeAgentImage,
      agentPlatforms: ['linux/amd64'],
    });
    const bundle = await readLinuxPreviewBundle({ directory, version, sourceRevision, repository });
    assert.equal(bundle.manifest.runtime.agentImage, runtimeAgentImage);
    const checksums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
    const manifestBytes = await readFile(join(directory, 'linux-preview.json'));
    assert.match(checksums, new RegExp(`^${digest(manifestBytes)}  linux-preview\\.json$`, 'm'));
    assert.match(bundle.notes, /published for `linux\/amd64` only/);
    assert.match(bundle.notes, /On an `arm64` host/);
    assert.match(bundle.notes, /real task execution with this preview have not\nyet been validated/);
  });

  test('rejects missing, mutable, other-source, or other-repository agent references for new previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-linux-preview-agent-'));
    const inputDirectory = await createValidatedInput(root);
    const invalid = [
      undefined,
      '',
      'propr/agent:0.9.0',
      `propr/agent:${sourceRevision}`,
      `propr/agent:${'2'.repeat(40)}@sha256:${'c'.repeat(64)}`,
      `propr/app:${sourceRevision}@sha256:${'c'.repeat(64)}`,
      `example/agent:${sourceRevision}@sha256:${'c'.repeat(64)}`,
      ` ${runtimeAgentImage}`,
    ];
    for (const agentImage of invalid) {
      await assert.rejects(prepareLinuxPreview({
        inputDirectory,
        outputDirectory: join(root, 'bundle'),
        version,
        sourceRevision,
        runtimeAppImage,
        runtimeUiImage,
        runtimeAgentImage: agentImage,
        repository,
        workflowRunId: '1234',
      }), /digest-pinned linux\/amd64 propr\/agent image/, String(agentImage));
    }
  });

  test('refuses app/UI-only schema 1 bundles and tampered agent bindings', async () => {
    const { directory } = await createBundle();
    const manifestPath = join(directory, 'linux-preview.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const rewrite = async manifest => {
      const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(manifestPath, bytes);
      const checksums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8'))
        .replace(/^[a-f0-9]{64}  linux-preview\.json$/m, `${digest(Buffer.from(bytes))}  linux-preview.json`);
      await writeFile(join(directory, 'SHA256SUMS'), checksums);
    };
    const legacyRuntime = { distribution: 'published', appImage: runtimeAppImage, uiImage: runtimeUiImage };
    await rewrite({ ...original, schemaVersion: 1, runtime: legacyRuntime });
    await assert.rejects(readLinuxPreviewBundle({ directory, version, sourceRevision, repository }),
      /not the managed-agent-bound schema 2/);
    await rewrite({ ...original, runtime: legacyRuntime });
    await assert.rejects(readLinuxPreviewBundle({ directory, version, sourceRevision, repository }),
      /missing or unknown fields/);
    await rewrite({ ...original, runtime: { ...original.runtime, agentPlatforms: ['linux/amd64', 'linux/arm64'] } });
    await assert.rejects(readLinuxPreviewBundle({ directory, version, sourceRevision, repository }),
      /not published, digest-pinned, and source-aligned/);
    await rewrite({ ...original, runtime: { ...original.runtime, agentImage: 'propr/agent:0.9.0' } });
    await assert.rejects(readLinuxPreviewBundle({ directory, version, sourceRevision, repository }),
      /not published, digest-pinned, and source-aligned/);
  });

  test('never overwrites an existing app/UI-only draft at the same preview identity', async () => {
    const { directory } = await createBundle();
    const github = createGitHub();
    const legacyManifest = Buffer.from('{"schemaVersion":1}\n');
    github.release = {
      id: 7,
      tag_name: linuxPreviewTag(version, sourceRevision),
      target_commitish: sourceRevision,
      draft: true,
      prerelease: true,
      published_at: null,
      name: `ProPR Desktop Linux preview ${version} (${sourceRevision.slice(0, 12)})`,
      body: linuxPreviewInstallNotes({ version, sourceRevision, tag: linuxPreviewTag(version, sourceRevision) }),
      upload_url: 'https://uploads.github.com/releases/7/assets{?name,label}',
    };
    github.assets.push({
      id: 1,
      name: 'linux-preview.json',
      state: 'uploaded',
      size: legacyManifest.length,
      digest: `sha256:${digest(legacyManifest)}`,
      url: 'https://api.github.com/assets/1',
      bytes: legacyManifest,
    });
    await assert.rejects(stageLinuxPreviewDraft({
      directory, version, sourceRevision, repository, token: 'token', fetchImpl: github.fetchImpl,
    }), /asset metadata mismatch: linux-preview\.json/);
    assert.equal(github.assets.length, 1);
    assert.equal(github.assets[0].bytes, legacyManifest);
    assert.equal(github.createCalls, 0);
    assert.equal(github.patchCalls, 0);
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
      runtimeAgentImage,
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

    await assert.rejects(publishLinuxPreviewDraft({ version, sourceRevision, repository,
      token: 'token', fetchImpl: github.fetchImpl }), /requires authenticated DEB and RPM/);
    assert.equal(github.patchCalls, 0);
    assert.deepEqual(github.releaseListCalls, [1, 1, 2]);
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
      runtimeAgentImage,
      repository,
      workflowRunId: '1234',
    }), /bytes drifted/);
  });
});

// Does not need RPM installed: stop at the first package parser and observe only
// presence/absence, never print the supplied secret values.
test('sign-bundle scrubs inherited signing secrets before its first package parser', {
  skip: process.platform === 'win32' ? 'POSIX parser wrappers' : false,
}, async t => {
  const { root, directory } = await createBundle();
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const evidence = join(root, 'parser.json');
  await mkdir(bin);
  const parser = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({
  key: 'PROPR_DESKTOP_RPM_PRIVATE_KEY' in process.env,
  passphrase: 'PROPR_DESKTOP_RPM_PASSPHRASE' in process.env,
}));
process.exit(42);
`;
  for (const name of ['rpm', 'dpkg-deb']) await writeFile(join(bin, name), parser, { mode: 0o755 });
  const result = spawnSync(process.execPath, ['apps/desktop/scripts/linux-preview-release.mjs',
    'sign-bundle', '--signed-rpm', '--input', directory, '--output', join(root, 'signed'),
    '--version', version, '--source-revision', sourceRevision, '--repository', repository], {
    cwd: resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8', env: { ...process.env, PATH: bin,
      PROPR_DESKTOP_RPM_PRIVATE_KEY: 'private-test-sentinel', PROPR_DESKTOP_RPM_PASSPHRASE: 'password-test-sentinel',
      PROPR_DESKTOP_RPM_PUBLIC_KEY: '-----BEGIN PGP PUBLIC KEY BLOCK-----',
      PROPR_DESKTOP_RPM_FINGERPRINT: '80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599' },
  });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(await readFile(evidence, 'utf8')), { key: false, passphrase: false });
  assert.doesNotMatch(result.stdout + result.stderr, /private-test-sentinel|password-test-sentinel/);
});

test('signed install notes make rpmkeys primary and offer a standalone pinned-source helper', () => {
  const rpmIdentity = { fingerprint: 'A'.repeat(40), publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----' };
  const notes = linuxPreviewInstallNotes({ version, sourceRevision, tag: linuxPreviewTag(version, sourceRevision, rpmIdentity), rpmIdentity });
  assert.match(notes, /rpmkeys --checksig --verbose/);
  assert.match(notes, /does not require Node or a repository checkout/);
  assert.match(notes, /Both key IDs must match the confirmed fingerprint suffix/);
  assert.match(notes, /Optionally.*Node.js 22\+/);
  assert.ok(notes.includes('https://raw.githubusercontent.com/integry/propr/${HELPER_REVISION}/apps/desktop/scripts/rpm-signing.mjs'));
  assert.match(notes, /node \.\/rpm-signing.mjs verify/);
  assert.doesNotMatch(notes, /node apps\/desktop\/scripts/);
});


test('historical metadata remains explicitly unauthenticated and cannot enter all-signed publication', async () => {
  const { directory } = await createBundle();
  const path = join(directory, 'linux-preview.json');
  const options = { path, version, sourceRevision, repository };
  const unsigned = await readHistoricalLinuxPreviewMetadata(options);
  assert.equal(unsigned.trust, 'unsigned-preview');
  assert.equal(unsigned.metadataAuthenticated, false);
  assert.equal(unsigned.publicationEligible, false);
  const manifest = unsigned.manifest;
  const rpmIdentity = { fingerprint: 'A'.repeat(40), publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----' };
  manifest.schemaVersion = 3;
  manifest.trust = 'rpm-signed-preview';
  manifest.tag += '-rpm-signed';
  manifest.rpmSigning = { ...rpmIdentity, originals: Object.fromEntries(manifest.artifacts.filter(a => a.kind === 'rpm')
    .map(a => [a.fileName, { sha256: a.sha256, contentSha256: 'b'.repeat(64) }])) };
  await writeFile(path, JSON.stringify(manifest));
  const old = await readHistoricalLinuxPreviewMetadata({ ...options, rpmIdentity });
  assert.equal(old.trust, 'rpm-signed-preview');
  assert.equal(old.metadataAuthenticated, false);
  assert.equal(old.publicationEligible, false);
  await assert.rejects(readLinuxPreviewBundle({ directory, version, sourceRevision, repository, rpmIdentity }), /missing or unexpected/);
  manifest.trust = 'authenticated-linux-preview';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(readHistoricalLinuxPreviewMetadata({ ...options, rpmIdentity }), /identity/);
});
