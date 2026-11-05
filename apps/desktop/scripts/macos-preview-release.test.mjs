import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, describe, test } from 'node:test';
import {
  macosPreviewInstallNotes,
  macosPreviewTag,
  prepareMacosPreview,
  publishMacosPreviewDraft,
  readMacosPreviewBundle,
  stageMacosPreviewDraft,
} from './macos-preview-release.mjs';
import { signReleaseMetadata } from './release-artifacts.mjs';
import { publishDesktopRelease } from './release-publish.mjs';
import {
  expectedProfileArtifacts,
  LINUX_PREVIEW_RELEASE_PROFILE,
  MACOS_LINUX_RELEASE_PROFILE,
  MACOS_PREVIEW_RELEASE_PROFILE,
  resolveReleaseProfile,
} from './release-profiles.mjs';

const version = '1.2.3';
const sourceRevision = '1'.repeat(40);
const repository = 'integry/propr';
const tag = `desktop-macos-preview-v${version}-${sourceRevision.slice(0, 12)}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const runtime = {
  runtimeAppImage: `propr/app:${sourceRevision}@sha256:${'a'.repeat(64)}`,
  runtimeUiImage: `propr/ui:${sourceRevision}@sha256:${'b'.repeat(64)}`,
  runtimeAgentImage: `propr/agent:${sourceRevision}@sha256:${'c'.repeat(64)}`,
};
const roots = [];
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));

const createValidatedInput = async ({ profileName = MACOS_PREVIEW_RELEASE_PROFILE, nativeSigners = {} } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'propr-macos-preview-test-'));
  roots.push(root);
  const inputDirectory = join(root, 'validated');
  await mkdir(inputDirectory);
  const artifacts = [];
  for (const [fileName, metadata] of expectedProfileArtifacts(resolveReleaseProfile(profileName), version)) {
    const bytes = Buffer.from(`${metadata.platform}-${metadata.arch}-${metadata.kind}\n`);
    await writeFile(join(inputDirectory, fileName), bytes);
    artifacts.push({ ...metadata, fileName, size: bytes.length, sha256: digest(bytes),
      architectureEvidence: { format: metadata.kind, executable: { architectures: [metadata.arch] } } });
  }
  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  await writeFile(join(inputDirectory, 'desktop-release.json'), `${JSON.stringify({
    schemaVersion: 2, releaseProfile: profileName, channel: 'validation', version, tag: `desktop-v${version}`,
    publishedAt: '2026-10-31T00:00:00.000Z', feeds: {}, nativeSigners, artifacts,
  }, null, 2)}\n`);
  await writeFile(join(inputDirectory, 'SHA256SUMS'), `${artifacts.map(a => `${a.sha256}  ${a.fileName}`).join('\n')}\n`);
  return { root, inputDirectory };
};

const createBundle = async () => {
  const { root, inputDirectory } = await createValidatedInput();
  const directory = join(root, 'final');
  const manifest = await prepareMacosPreview({
    inputDirectory, outputDirectory: directory, version, sourceRevision, ...runtime, repository,
    workflowRunId: '4321', createdAt: '2026-10-31T09:00:00.000Z',
  });
  return { root, directory, manifest };
};

const rewriteManifest = async (directory, change) => {
  const path = join(directory, 'macos-preview.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  change(manifest);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path, bytes);
  const sums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8'))
    .replace(/^[a-f0-9]{64}  macos-preview\.json$/m, `${digest(Buffer.from(bytes))}  macos-preview.json`);
  await writeFile(join(directory, 'SHA256SUMS'), sums);
};

const response = ({ status = 200, value, bytes }) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => value,
  body: bytes === undefined ? undefined : Readable.from([bytes]),
});

const createGitHub = () => {
  const state = { release: undefined, assets: [], createCalls: 0, patches: [], tagExists: false };
  state.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${repository}`, '');
    const method = options.method ?? 'GET';
    if (path.startsWith('/git/ref/tags/')) {
      return state.tagExists ? response({ value: { object: { sha: '2'.repeat(40) } } }) : response({ status: 404 });
    }
    if (path === `/commits/${sourceRevision}` || path === `/commits/${tag}`) return response({ value: { sha: sourceRevision } });
    if (path === '/releases' && method === 'GET') {
      return response({ value: Number(parsed.searchParams.get('page')) === 1 && state.release ? [state.release] : [] });
    }
    if (path === '/releases' && method === 'POST') {
      const input = JSON.parse(options.body);
      assert.equal(input.draft, true);
      assert.equal(input.prerelease, true);
      assert.equal(input.tag_name, tag);
      assert.equal(input.target_commitish, sourceRevision);
      state.createCalls += 1;
      state.release = {
        id: 9, tag_name: input.tag_name, target_commitish: input.target_commitish, draft: true, prerelease: true,
        published_at: null, name: input.name, body: input.body,
        upload_url: 'https://uploads.github.com/repos/integry/propr/releases/9/assets{?name,label}',
      };
      return response({ status: 201, value: state.release });
    }
    if (path === '/releases/9/assets' && method === 'GET') {
      return response({ value: Number(parsed.searchParams.get('page')) === 1 ? state.assets : [] });
    }
    if (parsed.host === 'uploads.github.com' && method === 'POST') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const id = state.assets.length + 1;
      const asset = { id, name: parsed.searchParams.get('name'), state: 'uploaded', size: bytes.length,
        digest: `sha256:${digest(bytes)}`, url: `https://api.github.com/repos/${repository}/releases/assets/${id}`, bytes };
      state.assets.push(asset);
      return response({ status: 201, value: asset });
    }
    if (path.startsWith('/releases/assets/')) {
      const asset = state.assets.find(candidate => candidate.url === url);
      return asset ? response({ bytes: asset.bytes }) : response({ status: 404 });
    }
    if (path === '/releases/9' && method === 'GET') return response({ value: state.release });
    if (path === '/releases/9' && method === 'PATCH') {
      const input = JSON.parse(options.body);
      state.patches.push(input);
      state.release = { ...state.release, draft: input.draft, prerelease: input.prerelease, published_at: '2026-10-31T10:00:00Z' };
      return response({ value: state.release });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  return state;
};

describe('macOS unsigned preview release channel', () => {
  test('creates a DMG/ZIP bundle for both architectures bound to source, runtime digests, and checksums', async () => {
    const { directory, manifest } = await createBundle();
    assert.equal(manifest.tag, tag);
    assert.equal(macosPreviewTag(version, sourceRevision), tag);
    assert.equal(manifest.channel, 'macos-preview');
    assert.equal(manifest.trust, 'unsigned-preview');
    assert.deepEqual(manifest.codeSigning, { appleDeveloperId: false, notarized: false, arm64: 'ad-hoc', x64: 'none' });
    assert.deepEqual(manifest.upgrade, { selfUpdate: false, mode: 'manual-replace' });
    assert.deepEqual(manifest.runtime, {
      distribution: 'published', appImage: runtime.runtimeAppImage, uiImage: runtime.runtimeUiImage,
      agentImage: runtime.runtimeAgentImage, agentPlatforms: ['linux/amd64'],
    });
    assert.deepEqual((await readdir(directory)).sort(), [
      'INSTALL.md',
      'ProPR-Desktop-1.2.3-macos-arm64.dmg',
      'ProPR-Desktop-1.2.3-macos-arm64.zip',
      'ProPR-Desktop-1.2.3-macos-x64.dmg',
      'ProPR-Desktop-1.2.3-macos-x64.zip',
      'SHA256SUMS',
      'macos-preview.json',
    ]);
    const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
    assert.equal(sums.trimEnd().split('\n').length, 6);
    for (const name of (await readdir(directory)).filter(entry => entry !== 'SHA256SUMS')) {
      const line = `${digest(await readFile(join(directory, name)))}  ${name}`;
      assert.ok(sums.split('\n').includes(line), name);
    }
    const bundle = await readMacosPreviewBundle({ directory, version, sourceRevision, repository });
    assert.equal(bundle.assets.size, 7);
  });

  test('install notes explain checksum and attestation verification, Gatekeeper, and manual updates', () => {
    const notes = macosPreviewInstallNotes({ version, sourceRevision, tag, repository });
    assert.match(notes, /shasum -a 256 -c SHA256SUMS/);
    assert.match(notes, /\| shasum -a 256 -c -/);
    assert.match(notes, /gh attestation verify "ProPR-Desktop-\$\{VERSION\}-macos-\$\{ARCH\}\.dmg"/);
    assert.match(notes, /--signer-workflow integry\/propr\/\.github\/workflows\/desktop-macos-preview\.yml/);
    assert.match(notes, /--source-ref refs\/heads\/main/);
    assert.match(notes, /not signed with an Apple Developer ID and not notarized/);
    assert.match(notes, /Open Anyway/);
    assert.match(notes, /xattr -dr com\.apple\.quarantine \/Applications\/propr-desktop\.app/);
    assert.match(notes, /notifications may not be delivered/);
    assert.match(notes, /never updates itself and never contacts the signed update channel/);
    assert.doesNotMatch(notes, /apt|dnf|rpm|Windows/);
  });

  test('accepts only the finalized unsigned macOS preview profile with exact bytes and runtime pins', async () => {
    const prepare = (inputDirectory, root, overrides = {}) => prepareMacosPreview({
      inputDirectory, outputDirectory: join(root, 'final'), version, sourceRevision, ...runtime, repository,
      workflowRunId: '4321', ...overrides,
    });
    const linux = await createValidatedInput({ profileName: LINUX_PREVIEW_RELEASE_PROFILE });
    await assert.rejects(prepare(linux.inputDirectory, linux.root), /unsigned macOS-only preview artifact profile/);
    const stable = await createValidatedInput({ profileName: MACOS_LINUX_RELEASE_PROFILE });
    await assert.rejects(prepare(stable.inputDirectory, stable.root), /unsigned macOS-only preview artifact profile/);
    const signed = await createValidatedInput({ nativeSigners: { 'darwin-arm64': { type: 'apple-team-id', identity: 'TEAM' } } });
    await assert.rejects(prepare(signed.inputDirectory, signed.root), /unsigned macOS-only preview artifact profile/);
    const drift = await createValidatedInput();
    await writeFile(join(drift.inputDirectory, 'ProPR-Desktop-1.2.3-macos-arm64.dmg'), 'changed');
    await assert.rejects(prepare(drift.inputDirectory, drift.root), /bytes drifted/);
    const pins = await createValidatedInput();
    for (const [key, value] of [
      ['runtimeAppImage', `propr/app:${sourceRevision}`],
      ['runtimeUiImage', `propr/ui:${'2'.repeat(40)}@sha256:${'b'.repeat(64)}`],
      ['runtimeAgentImage', 'propr/agent:0.9.0'],
      ['runtimeAgentImage', undefined],
    ]) {
      await assert.rejects(prepare(pins.inputDirectory, pins.root, { [key]: value }), /digest-pinned/, `${key}=${value}`);
    }
  });

  test('refuses bundles that claim notarization, enable self-update, or change assets', async () => {
    const read = directory => readMacosPreviewBundle({ directory, version, sourceRevision, repository });
    const notarized = await createBundle();
    await rewriteManifest(notarized.directory, manifest => { manifest.codeSigning.notarized = true; });
    await assert.rejects(read(notarized.directory), /no Developer ID signature and no notarization/);
    const updating = await createBundle();
    await rewriteManifest(updating.directory, manifest => { manifest.upgrade.selfUpdate = true; });
    await assert.rejects(read(updating.directory), /self-update disabled/);
    const extra = await createBundle();
    await writeFile(join(extra.directory, 'desktop-release.json'), '{}');
    await assert.rejects(read(extra.directory), /missing or unexpected assets/);
    const notes = await createBundle();
    await writeFile(join(notes.directory, 'INSTALL.md'), 'Run anything.\n');
    await assert.rejects(read(notes.directory), /install notes differ/);
    const tampered = await createBundle();
    await writeFile(join(tampered.directory, 'ProPR-Desktop-1.2.3-macos-x64.zip'), 'tampered');
    await assert.rejects(read(tampered.directory), /digest mismatch: ProPR-Desktop-1\.2\.3-macos-x64\.zip/);
    await assert.rejects(readMacosPreviewBundle({ directory: tampered.directory, version, sourceRevision: 'HEAD', repository }),
      /identity inputs are invalid/);
  });

  test('stages a draft prerelease, resumes without duplicates, then publishes it as a non-latest prerelease', async () => {
    const { directory } = await createBundle();
    const github = createGitHub();
    const options = { directory, version, sourceRevision, repository, token: 'token', fetchImpl: github.fetchImpl };
    const staged = await stageMacosPreviewDraft(options);
    assert.equal(staged.tag, tag);
    assert.equal(github.createCalls, 1);
    assert.equal(github.assets.length, 7);
    assert.equal(github.release.draft, true);
    assert.equal(github.release.prerelease, true);
    assert.equal(github.release.name, `ProPR Desktop macOS preview ${version} (${sourceRevision.slice(0, 12)})`);
    assert.deepEqual(github.patches, []);
    // A partially uploaded draft resumes with the remaining assets only.
    github.assets.splice(3);
    await stageMacosPreviewDraft(options);
    assert.equal(github.createCalls, 1);
    assert.equal(github.assets.length, 7);
    assert.deepEqual(github.patches, []);

    const published = await publishMacosPreviewDraft(options);
    assert.deepEqual(github.patches, [{ draft: false, prerelease: true, make_latest: 'false' }]);
    assert.equal(published.prerelease, true);
    assert.equal(published.draft, false);
  });

  test('never publishes over an existing tag, a foreign asset, or bytes that differ from the attested bundle', async () => {
    const { directory } = await createBundle();
    const options = github => ({ directory, version, sourceRevision, repository, token: 'token', fetchImpl: github.fetchImpl });
    const existing = createGitHub();
    existing.tagExists = true;
    await assert.rejects(stageMacosPreviewDraft(options(existing)), /tag already exists/);
    await assert.rejects(publishMacosPreviewDraft(options(existing)), /tag already exists/);
    assert.equal(existing.createCalls, 0);

    const missing = createGitHub();
    await assert.rejects(publishMacosPreviewDraft(options(missing)), /exact unpublished macOS preview draft/);

    const swapped = createGitHub();
    await stageMacosPreviewDraft(options(swapped));
    const zip = swapped.assets.find(asset => asset.name.endsWith('x64.zip'));
    zip.bytes = Buffer.alloc(zip.size, 0x41);
    zip.digest = `sha256:${digest(zip.bytes)}`;
    await assert.rejects(publishMacosPreviewDraft(options(swapped)), /digest metadata mismatch: ProPR-Desktop-1\.2\.3-macos-x64\.zip/);
    zip.digest = null;
    await assert.rejects(publishMacosPreviewDraft(options(swapped)), /content digest mismatch/);

    const foreign = createGitHub();
    await stageMacosPreviewDraft(options(foreign));
    foreign.assets.push({ ...foreign.assets[0], id: 99, name: 'extra.pkg' });
    await assert.rejects(publishMacosPreviewDraft(options(foreign)), /unexpected or duplicate asset: extra\.pkg/);

    const shortDraft = createGitHub();
    await stageMacosPreviewDraft(options(shortDraft));
    shortDraft.assets.pop();
    await assert.rejects(publishMacosPreviewDraft(options(shortDraft)), /exact asset set/);
    for (const github of [swapped, foreign, shortDraft]) assert.deepEqual(github.patches, []);
  });

  test('the unsigned macOS profile cannot produce signed update metadata or enter stable publication', async () => {
    const profile = resolveReleaseProfile(MACOS_PREVIEW_RELEASE_PROFILE);
    assert.equal(profile.previewOnly, true);
    assert.equal(profile.windowsIncluded, false);
    assert.deepEqual([...profile.targets], [['darwin-x64', ['dmg', 'zip']], ['darwin-arm64', ['dmg', 'zip']]]);
    assert.equal(resolveReleaseProfile(MACOS_LINUX_RELEASE_PROFILE).previewOnly, false);
    await assert.rejects(signReleaseMetadata({
      inputDirectory: '/unused', outputDirectory: '/unused', version, profile: MACOS_PREVIEW_RELEASE_PROFILE,
    }), /cannot produce trusted update metadata/);
    await assert.rejects(publishDesktopRelease({
      repository, tag: `desktop-v${version}`, releaseSha: sourceRevision, tagObjectSha: '2'.repeat(40),
      directory: '/unused', profile: MACOS_PREVIEW_RELEASE_PROFILE, token: 'token',
    }), /explicitly authorized Linux or macOS preview publication channel/);
  });
});
