import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inspectArtifactArchitecture } from './release-architecture.mjs';
import {
  expectedProfileArtifacts,
  LINUX_PREVIEW_RELEASE_PROFILE,
  resolveReleaseProfile,
} from './release-profiles.mjs';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const API_PAGE_SIZE = 100;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const PREVIEW_MANIFEST = 'linux-preview.json';
const INSTALL_NOTES = 'INSTALL.md';
const CHECKSUMS = 'SHA256SUMS';
const execFile = promisify(execFileCallback);

export const linuxPreviewTag = (version, sourceRevision) => {
  if (!VERSION.test(version) || !SHA.test(sourceRevision)) {
    throw new Error('Linux preview identity requires a semantic version and full lowercase source revision');
  }
  return `desktop-linux-preview-v${version}-${sourceRevision.slice(0, 12)}`;
};

const sha256 = async path => {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error(`${label} has missing or unknown fields`);
  }
};

const exactRuntimeImage = (value, repository, sourceRevision) => (
  typeof value === 'string'
  && value === value.trim()
  && value.startsWith(`propr/${repository}:${sourceRevision}@sha256:`)
  && SHA256.test(value.slice(value.lastIndexOf(':') + 1))
);

const previewFileNames = version => {
  const profile = resolveReleaseProfile(LINUX_PREVIEW_RELEASE_PROFILE);
  return [...expectedProfileArtifacts(profile, version).keys()].sort();
};

const parseChecksums = contents => {
  if (!contents.endsWith('\n') || contents.includes('\r')) {
    throw new Error('Linux preview SHA256SUMS must be canonical LF-terminated text');
  }
  const entries = contents.trimEnd().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match) throw new Error('Linux preview SHA256SUMS contains a malformed entry');
    return [match[2], match[1]];
  });
  const names = entries.map(([name]) => name);
  if (new Set(names).size !== names.length || names.join('\n') !== [...names].sort().join('\n')) {
    throw new Error('Linux preview SHA256SUMS must be unique and sorted by asset name');
  }
  return new Map(entries);
};

export const linuxPreviewInstallNotes = ({ version, sourceRevision, tag }) => `# ProPR Desktop Linux preview

This is an explicitly unsigned preview built from \`${sourceRevision}\` (package version \`${version}\`). It is a
prerelease, not the trusted stable desktop channel. Verify \`${CHECKSUMS}\` before installing. Choose \`x64\` for
Intel/AMD 64-bit Linux or \`arm64\` for 64-bit ARM Linux.

## Debian and Ubuntu (DEB)

\`\`\`sh
VERSION=${version}
ARCH=x64 # or arm64
sha256sum --check ${CHECKSUMS}
sudo apt install "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.deb"
propr-desktop
# Upgrade after manually downloading a newer preview:
sudo apt install "./ProPR-Desktop-<new-version>-linux-\${ARCH}.deb"
# If the newer source preview intentionally keeps the same package version:
sudo apt install --reinstall "./ProPR-Desktop-${version}-linux-\${ARCH}.deb"
# Remove the application (managed runtime data is not claimed as package-owned):
sudo apt remove propr-desktop
\`\`\`

## Fedora and RHEL-family systems (RPM)

\`\`\`sh
VERSION=${version}
ARCH=x64 # or arm64
sha256sum --check ${CHECKSUMS}
sudo dnf install "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.rpm"
propr-desktop
# Upgrade after manually downloading a newer preview:
sudo dnf upgrade "./ProPR-Desktop-<new-version>-linux-\${ARCH}.rpm"
# If the newer source preview intentionally keeps the same package version:
sudo dnf reinstall "./ProPR-Desktop-${version}-linux-\${ARCH}.rpm"
sudo dnf remove propr-desktop
\`\`\`

There is no apt/dnf repository behind this preview and Linux self-updates are disabled. Download each newer prerelease
from the GitHub Releases preview channel and upgrade it with the package manager. Do not mix DEB and RPM installations.
The immutable preview identity is \`${tag}\`, and \`${PREVIEW_MANIFEST}\` binds the assets and published runtime images
to the full source revision above.
`;

const validateArtifactMetadata = (artifacts, version) => {
  const expectedNames = previewFileNames(version);
  if (!Array.isArray(artifacts) || artifacts.length !== expectedNames.length) {
    throw new Error('Linux preview manifest must contain the exact four-package matrix');
  }
  const seen = new Set();
  for (const artifact of artifacts) {
    exactKeys(artifact, ['platform', 'arch', 'kind', 'fileName', 'size', 'sha256'], 'Linux preview artifact');
    if (artifact.platform !== 'linux' || !['x64', 'arm64'].includes(artifact.arch)
      || !['deb', 'rpm'].includes(artifact.kind)
      || !expectedNames.includes(artifact.fileName)
      || basename(artifact.fileName) !== artifact.fileName
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || !SHA256.test(artifact.sha256) || seen.has(artifact.fileName)) {
      throw new Error('Linux preview manifest contains an invalid or duplicate package');
    }
    seen.add(artifact.fileName);
  }
  if (expectedNames.some(name => !seen.has(name))) {
    throw new Error('Linux preview manifest is missing an architecture-labelled package');
  }
  return [...artifacts].sort((left, right) => left.fileName.localeCompare(right.fileName));
};

const validateManifest = (manifest, { version, sourceRevision, repository }) => {
  exactKeys(manifest, [
    'schemaVersion', 'channel', 'trust', 'version', 'sourceRevision', 'tag', 'createdAt',
    'repository', 'workflowRunId', 'runtime', 'upgrade', 'artifacts',
  ], 'Linux preview manifest');
  if (manifest.schemaVersion !== 1 || manifest.channel !== 'linux-preview'
    || manifest.trust !== 'unsigned-preview' || manifest.version !== version
    || manifest.sourceRevision !== sourceRevision
    || manifest.tag !== linuxPreviewTag(version, sourceRevision)
    || manifest.repository !== repository
    || typeof manifest.workflowRunId !== 'string' || !/^\d+$/.test(manifest.workflowRunId)
    || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('Linux preview manifest identity is invalid');
  }
  exactKeys(manifest.runtime, ['distribution', 'appImage', 'uiImage'], 'Linux preview runtime');
  if (manifest.runtime.distribution !== 'published'
    || !exactRuntimeImage(manifest.runtime.appImage, 'app', sourceRevision)
    || !exactRuntimeImage(manifest.runtime.uiImage, 'ui', sourceRevision)) {
    throw new Error('Linux preview runtime images are not published, digest-pinned, and source-aligned');
  }
  exactKeys(manifest.upgrade, ['selfUpdate', 'mode'], 'Linux preview upgrade policy');
  if (manifest.upgrade.selfUpdate !== false || manifest.upgrade.mode !== 'manual-package-manager') {
    throw new Error('Linux preview must keep self-update disabled and use package-manager upgrades');
  }
  return validateArtifactMetadata(manifest.artifacts, version);
};

const expectedBundleNames = version => [...previewFileNames(version), INSTALL_NOTES, PREVIEW_MANIFEST, CHECKSUMS].sort();

export const inspectLinuxPackageVersion = async ({ path, kind, version }) => {
  const { stdout } = kind === 'deb'
    ? await execFile('dpkg-deb', ['--field', path, 'Version'])
    : await execFile('rpm', ['-qp', '--qf', '%{VERSION}', path]);
  if (stdout.trim() !== version) {
    throw new Error(`${kind.toUpperCase()} package version mismatch: expected ${version}, found ${stdout.trim()}`);
  }
};

export const prepareLinuxPreview = async ({
  inputDirectory,
  outputDirectory,
  version,
  sourceRevision,
  runtimeAppImage,
  runtimeUiImage,
  repository,
  workflowRunId,
  createdAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString(),
}) => {
  if (!VERSION.test(version) || !SHA.test(sourceRevision) || !REPOSITORY.test(repository)
    || !/^\d+$/.test(String(workflowRunId))) {
    throw new Error('Linux preview preparation inputs are invalid');
  }
  if (!exactRuntimeImage(runtimeAppImage, 'app', sourceRevision)
    || !exactRuntimeImage(runtimeUiImage, 'ui', sourceRevision)) {
    throw new Error('Linux preview requires exact digest-pinned propr/app and propr/ui images for the source revision');
  }
  const sourceManifest = JSON.parse(await readFile(join(inputDirectory, 'desktop-release.json'), 'utf8'));
  if (sourceManifest.releaseProfile !== LINUX_PREVIEW_RELEASE_PROFILE
    || sourceManifest.version !== version || sourceManifest.channel !== 'validation') {
    throw new Error('Linux preview input was not finalized with the Linux-only preview artifact profile');
  }
  const artifacts = validateArtifactMetadata(sourceManifest.artifacts.map(({
    platform, arch, kind, fileName, size, sha256: digest,
  }) => ({ platform, arch, kind, fileName, size, sha256: digest })), version);
  const sourceChecksums = parseChecksums(await readFile(join(inputDirectory, CHECKSUMS), 'utf8'));
  if (sourceChecksums.size !== artifacts.length
    || artifacts.some(artifact => sourceChecksums.get(artifact.fileName) !== artifact.sha256)) {
    throw new Error('Finalized Linux preview package checksums are incomplete or inconsistent');
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const artifact of artifacts) {
    const source = join(inputDirectory, artifact.fileName);
    const details = await stat(source);
    if (!details.isFile() || details.size !== artifact.size || await sha256(source) !== artifact.sha256) {
      throw new Error(`Finalized Linux preview package bytes drifted: ${artifact.fileName}`);
    }
    await copyFile(source, join(outputDirectory, artifact.fileName));
  }
  const tag = linuxPreviewTag(version, sourceRevision);
  const manifest = {
    schemaVersion: 1,
    channel: 'linux-preview',
    trust: 'unsigned-preview',
    version,
    sourceRevision,
    tag,
    createdAt,
    repository,
    workflowRunId: String(workflowRunId),
    runtime: { distribution: 'published', appImage: runtimeAppImage, uiImage: runtimeUiImage },
    upgrade: { selfUpdate: false, mode: 'manual-package-manager' },
    artifacts,
  };
  validateManifest(manifest, { version, sourceRevision, repository });
  await writeFile(join(outputDirectory, PREVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, INSTALL_NOTES), linuxPreviewInstallNotes({ version, sourceRevision, tag }));
  const checksumNames = [...previewFileNames(version), INSTALL_NOTES, PREVIEW_MANIFEST].sort();
  await writeFile(join(outputDirectory, CHECKSUMS), `${(await Promise.all(checksumNames.map(async name => (
    `${await sha256(join(outputDirectory, name))}  ${name}`
  )))).join('\n')}\n`);
  return manifest;
};

export const readLinuxPreviewBundle = async ({ directory, version, sourceRevision, repository }) => {
  const names = (await readdir(directory)).sort();
  const expectedNames = expectedBundleNames(version);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error('Linux preview bundle contains missing or unexpected assets');
  }
  const manifest = JSON.parse(await readFile(join(directory, PREVIEW_MANIFEST), 'utf8'));
  const artifacts = validateManifest(manifest, { version, sourceRevision, repository });
  const expectedChecksums = new Map([
    ...artifacts.map(artifact => [artifact.fileName, artifact.sha256]),
    ...await Promise.all([INSTALL_NOTES, PREVIEW_MANIFEST]
      .map(async name => [name, await sha256(join(directory, name))])),
  ]);
  const checksums = parseChecksums(await readFile(join(directory, CHECKSUMS), 'utf8'));
  if (checksums.size !== expectedChecksums.size
    || [...expectedChecksums].some(([name, digest]) => checksums.get(name) !== digest)) {
    throw new Error('Linux preview bundle checksum allowlist is incomplete or inconsistent');
  }
  const assets = new Map();
  for (const name of expectedNames) {
    const path = join(directory, name);
    const details = await stat(path);
    if (!details.isFile() || details.size <= 0) throw new Error(`Linux preview asset is not a regular file: ${name}`);
    const digest = await sha256(path);
    if (name !== CHECKSUMS && checksums.get(name) !== digest) {
      throw new Error(`Linux preview asset digest mismatch: ${name}`);
    }
    assets.set(name, { name, path, size: details.size, sha256: digest });
  }
  return { manifest, assets, notes: await readFile(join(directory, INSTALL_NOTES), 'utf8') };
};

const githubRequest = async ({ fetchImpl, apiUrl, repository, token, path, method = 'GET', json, body, headers = {}, allowNotFound = false }) => {
  const url = path.startsWith('https://') ? path : `${apiUrl}/repos/${repository}${path}`;
  const response = await fetchImpl(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(body === undefined ? {} : { body, duplex: 'half' }),
  });
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
  return response;
};

const githubClient = ({ repository, token, apiUrl, fetchImpl }) => {
  const request = (path, options = {}) => githubRequest({
    repository, token, apiUrl, fetchImpl, path, ...options,
  });
  const json = async (path, options = {}) => {
    const response = await request(path, options);
    return response === undefined ? undefined : response.json();
  };
  return { request, json };
};

const previewReleaseName = (version, sourceRevision) => (
  `ProPR Desktop Linux preview ${version} (${sourceRevision.slice(0, 12)})`
);

const assertDraft = (release, { tag, sourceRevision, version }) => {
  if (!Number.isSafeInteger(release?.id) || release.tag_name !== tag
    || release.target_commitish !== sourceRevision || release.draft !== true
    || release.prerelease !== true || release.published_at != null
    || release.name !== previewReleaseName(version, sourceRevision)
    || release.body !== linuxPreviewInstallNotes({ version, sourceRevision, tag })
    || typeof release.upload_url !== 'string') {
    throw new Error('GitHub release is not the exact unpublished Linux preview draft');
  }
};

const findReleaseByTag = async (json, tag) => {
  let release;
  for (let page = 1; ; page += 1) {
    const result = await json(`/releases?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error('GitHub returned an invalid Linux preview release list');
    for (const candidate of result) {
      if (candidate?.tag_name !== tag) continue;
      if (release !== undefined) {
        throw new Error('GitHub returned duplicate releases for the Linux preview tag');
      }
      release = candidate;
    }
    if (result.length < API_PAGE_SIZE) return release;
  }
};

const listAssets = async (json, releaseId) => {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const result = await json(`/releases/${releaseId}/assets?per_page=${API_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(result)) throw new Error('GitHub returned an invalid Linux preview asset list');
    assets.push(...result);
    if (result.length < API_PAGE_SIZE) return assets;
  }
};

const digestResponse = async (response, expectedSize, name, outputPath) => {
  if (!response.body) throw new Error(`GitHub preview asset has no body: ${name}`);
  const hash = createHash('sha256');
  let size = 0;
  const chunks = [];
  const handle = outputPath ? await open(outputPath, 'wx', 0o600) : undefined;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expectedSize) throw new Error(`GitHub preview asset exceeds expected size: ${name}`);
      hash.update(chunk);
      if (handle) await handle.write(chunk);
      else chunks.push(chunk);
    }
  } finally {
    await handle?.close();
  }
  if (size !== expectedSize) throw new Error(`GitHub preview asset has an unexpected size: ${name}`);
  return { sha256: hash.digest('hex'), bytes: outputPath ? undefined : Buffer.concat(chunks) };
};

const verifyRemoteAsset = async ({ request, asset, expected, apiOrigin, outputPath }) => {
  if (!Number.isSafeInteger(asset?.id) || asset.name !== expected.name || asset.state !== 'uploaded'
    || asset.size !== expected.size || typeof asset.url !== 'string') {
    throw new Error(`GitHub preview asset metadata mismatch: ${expected.name}`);
  }
  const url = new URL(asset.url);
  if (url.origin !== apiOrigin) throw new Error(`GitHub preview asset has an untrusted API URL: ${expected.name}`);
  if (expected.sha256 && asset.digest != null && asset.digest !== `sha256:${expected.sha256}`) {
    throw new Error(`GitHub preview asset digest metadata mismatch: ${expected.name}`);
  }
  const response = await request(asset.url, { headers: { Accept: 'application/octet-stream' } });
  const downloaded = await digestResponse(response, expected.size, expected.name, outputPath);
  if ((expected.sha256 && downloaded.sha256 !== expected.sha256)
    || (!expected.sha256 && asset.digest != null && asset.digest !== `sha256:${downloaded.sha256}`)) {
    throw new Error(`GitHub preview asset content digest mismatch: ${expected.name}`);
  }
  return downloaded.bytes;
};

export const stageLinuxPreviewDraft = async ({
  directory, version, sourceRevision, repository, token,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
}) => {
  if (!REPOSITORY.test(repository) || !token) throw new Error('Linux preview GitHub inputs are invalid');
  const tag = linuxPreviewTag(version, sourceRevision);
  const { manifest, assets, notes } = await readLinuxPreviewBundle({ directory, version, sourceRevision, repository });
  const apiOrigin = new URL(apiUrl).origin;
  const { request, json } = githubClient({ repository, token, apiUrl, fetchImpl });
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error('Linux preview tag already exists; preview identities are never reused');
  }
  const commit = await json(`/commits/${sourceRevision}`);
  if (commit?.sha !== sourceRevision) throw new Error('Linux preview source revision is unavailable');
  let release = await findReleaseByTag(json, tag);
  if (release === undefined) {
    release = await json('/releases', {
      method: 'POST',
      json: {
        tag_name: tag,
        target_commitish: sourceRevision,
        name: previewReleaseName(version, sourceRevision),
        body: notes,
        draft: true,
        prerelease: true,
        generate_release_notes: false,
      },
    });
  }
  assertDraft(release, { tag, sourceRevision, version });
  const remoteAssets = await listAssets(json, release.id);
  const remoteByName = new Map();
  for (const asset of remoteAssets) {
    if (remoteByName.has(asset.name) || !assets.has(asset.name)) {
      throw new Error(`Linux preview draft contains an unexpected or duplicate asset: ${asset.name}`);
    }
    remoteByName.set(asset.name, asset);
    await verifyRemoteAsset({ request, asset, expected: assets.get(asset.name), apiOrigin });
  }
  const uploadBase = release.upload_url.replace(/\{.*$/, '');
  const uploadOrigin = new URL(uploadBase).origin;
  if (uploadOrigin !== apiOrigin && !(apiOrigin === 'https://api.github.com' && uploadOrigin === 'https://uploads.github.com')) {
    throw new Error('GitHub returned an untrusted Linux preview upload URL');
  }
  for (const asset of assets.values()) {
    if (remoteByName.has(asset.name)) continue;
    const uploadUrl = new URL(uploadBase);
    uploadUrl.searchParams.set('name', asset.name);
    await request(uploadUrl.toString(), {
      method: 'POST',
      body: createReadStream(asset.path),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) },
    });
  }
  const complete = await listAssets(json, release.id);
  if (complete.length !== assets.size) throw new Error('Linux preview draft asset upload is incomplete');
  for (const asset of complete) {
    const expected = assets.get(asset.name);
    if (!expected) throw new Error(`Linux preview draft contains unexpected asset: ${asset.name}`);
    await verifyRemoteAsset({ request, asset, expected, apiOrigin });
  }
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version });
  return { releaseId: release.id, tag, manifest };
};

export const publishLinuxPreviewDraft = async ({
  version, sourceRevision, repository, token,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
  inspectArchitecture = inspectArtifactArchitecture,
  inspectPackageVersion = inspectLinuxPackageVersion,
}) => {
  if (!REPOSITORY.test(repository) || !token) throw new Error('Linux preview publication inputs are invalid');
  const tag = linuxPreviewTag(version, sourceRevision);
  const apiOrigin = new URL(apiUrl).origin;
  const { request, json } = githubClient({ repository, token, apiUrl, fetchImpl });
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error('Linux preview tag already exists; refusing to republish or move it');
  }
  const release = await findReleaseByTag(json, tag);
  assertDraft(release, { tag, sourceRevision, version });
  const listed = await listAssets(json, release.id);
  const expectedNames = expectedBundleNames(version);
  if (listed.length !== expectedNames.length) throw new Error('Linux preview draft does not contain the exact asset set');
  const assets = new Map();
  for (const asset of listed) {
    if (!expectedNames.includes(asset.name) || assets.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Linux preview draft contains an invalid or duplicate asset: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }

  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES, CHECKSUMS]) {
    const asset = assets.get(name);
    if (!asset || asset.size > MAX_METADATA_BYTES
      || (asset.digest != null && !/^sha256:[a-f0-9]{64}$/.test(asset.digest))) {
      throw new Error(`Linux preview draft has invalid metadata asset ${name}`);
    }
  }
  const metadata = {};
  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES, CHECKSUMS]) {
    const asset = assets.get(name);
    metadata[name] = await verifyRemoteAsset({
      request,
      asset,
      expected: { name, size: asset.size },
      apiOrigin,
    });
  }
  const manifest = JSON.parse(metadata[PREVIEW_MANIFEST].toString('utf8'));
  const artifactMetadata = validateManifest(manifest, { version, sourceRevision, repository });
  if (metadata[INSTALL_NOTES].toString('utf8') !== linuxPreviewInstallNotes({ version, sourceRevision, tag })) {
    throw new Error('Linux preview install and channel instructions do not match the approved identity');
  }
  const checksums = parseChecksums(metadata[CHECKSUMS].toString('utf8'));
  if (checksums.size !== expectedNames.length - 1) throw new Error('Linux preview checksum allowlist is incomplete');
  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES]) {
    const digest = createHash('sha256').update(metadata[name]).digest('hex');
    if (checksums.get(name) !== digest) throw new Error(`Linux preview checksum mismatch: ${name}`);
  }

  const downloadDirectory = await mkdtemp(join(tmpdir(), 'propr-linux-preview-publish-'));
  try {
    for (const artifact of artifactMetadata) {
      const asset = assets.get(artifact.fileName);
      if (!asset || asset.size !== artifact.size || asset.size > MAX_PACKAGE_BYTES
        || checksums.get(artifact.fileName) !== artifact.sha256) {
        throw new Error(`Linux preview draft package metadata mismatch: ${artifact.fileName}`);
      }
      const outputPath = join(downloadDirectory, artifact.fileName);
      await verifyRemoteAsset({
        request,
        asset,
        expected: { name: artifact.fileName, size: artifact.size, sha256: artifact.sha256 },
        apiOrigin,
        outputPath,
      });
      await inspectArchitecture({
        path: outputPath,
        kind: artifact.kind,
        platform: 'linux',
        arch: artifact.arch,
      });
      await inspectPackageVersion({ path: outputPath, kind: artifact.kind, version });
    }
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }

  const commit = await json(`/commits/${sourceRevision}`);
  if (commit?.sha !== sourceRevision) throw new Error('Linux preview source revision is unavailable at publication');
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version });
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error('Linux preview tag appeared during authorization; refusing publication');
  }
  const published = await json(`/releases/${release.id}`, {
    method: 'PATCH',
    json: { draft: false, prerelease: true, make_latest: 'false' },
  });
  if (published?.id !== release.id || published.tag_name !== tag || published.draft !== false
    || published.prerelease !== true || !published.published_at) {
    throw new Error('GitHub did not confirm the exact Linux preview prerelease publication');
  }
  const publishedCommit = await json(`/commits/${encodeURIComponent(tag)}`);
  if (publishedCommit?.sha !== sourceRevision) {
    throw new Error('Published Linux preview tag does not resolve to the approved source revision');
  }
  return published;
};

const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const command = process.argv[2];
    const version = argument('--version');
    const sourceRevision = argument('--source-revision');
    const repository = argument('--repository');
    if (command === 'prepare') {
      await prepareLinuxPreview({
        inputDirectory: resolve(argument('--input') || 'desktop-linux-preview-validated'),
        outputDirectory: resolve(argument('--output') || 'desktop-linux-preview-final'),
        version,
        sourceRevision,
        runtimeAppImage: argument('--runtime-app-image'),
        runtimeUiImage: argument('--runtime-ui-image'),
        repository,
        workflowRunId: argument('--workflow-run-id'),
      });
    } else if (command === 'stage-draft') {
      const result = await stageLinuxPreviewDraft({
        directory: resolve(argument('--directory') || 'desktop-linux-preview-final'),
        version,
        sourceRevision,
        repository,
        token: process.env.GITHUB_TOKEN,
        apiUrl: process.env.GITHUB_API_URL,
      });
      console.log(JSON.stringify(result));
    } else if (command === 'publish-draft') {
      await publishLinuxPreviewDraft({
        version,
        sourceRevision,
        repository,
        token: process.env.GITHUB_TOKEN,
        apiUrl: process.env.GITHUB_API_URL,
      });
    } else {
      throw new Error('Expected linux-preview-release.mjs prepare, stage-draft, or publish-draft command');
    }
  } catch (error) {
    console.error((error instanceof Error ? error : new Error(String(error))).message);
    process.exitCode = 1;
  }
}
