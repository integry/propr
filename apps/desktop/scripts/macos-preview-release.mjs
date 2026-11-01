// Unsigned macOS preview channel. Builds no trust from Apple: the DMG/ZIP bytes
// are bound to a frozen main source revision and pinned runtime images through
// macos-preview.json, SHA256SUMS and GitHub build provenance attestations, then
// staged as a draft prerelease and published only from a protected environment.
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewTag } from './desktop-preview-identity.mjs';
import {
  exactKeys,
  exactRuntimeImage,
  findReleaseByTag as findPreviewReleaseByTag,
  githubClient,
  listAssets as listPreviewAssets,
  parseChecksums as parsePreviewChecksums,
  sha256File as sha256,
  trustedUploadBase,
  verifyRemoteAsset,
} from './preview-release-github.mjs';
import {
  expectedProfileArtifacts,
  MACOS_PREVIEW_RELEASE_PROFILE,
  resolveReleaseProfile,
} from './release-profiles.mjs';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_METADATA_BYTES = 1024 * 1024;
const LABEL = 'macOS preview';
const PREVIEW_MANIFEST = 'macos-preview.json';
const INSTALL_NOTES = 'INSTALL.md';
const CHECKSUMS = 'SHA256SUMS';
const PREVIEW_SCHEMA_VERSION = 1;
const MANAGED_AGENT_PLATFORMS = ['linux/amd64'];
export const MACOS_PREVIEW_WORKFLOW = '.github/workflows/desktop-macos-preview.yml';
// The application is never Developer ID signed or notarized. Apple Silicon
// builds carry only the local ad-hoc signature that lets them launch at all.
const CODE_SIGNING = Object.freeze({ appleDeveloperId: false, notarized: false, arm64: 'ad-hoc', x64: 'none' });

const parseChecksums = contents => parsePreviewChecksums(contents, LABEL);
const findReleaseByTag = (json, tag) => findPreviewReleaseByTag(json, tag, LABEL);
const listAssets = (json, releaseId) => listPreviewAssets(json, releaseId, LABEL);

export const macosPreviewTag = (version, sourceRevision) => previewTag('macos', version, sourceRevision);

const previewFileNames = version => [
  ...expectedProfileArtifacts(resolveReleaseProfile(MACOS_PREVIEW_RELEASE_PROFILE), version).keys(),
].sort();
const expectedBundleNames = version => [...previewFileNames(version), INSTALL_NOTES, PREVIEW_MANIFEST, CHECKSUMS].sort();
const checksumNames = version => expectedBundleNames(version).filter(name => name !== CHECKSUMS);

export const macosPreviewInstallNotes = ({ version, sourceRevision, tag, repository }) => `# ProPR Desktop macOS preview

This is an explicitly unsigned macOS preview built from \`${sourceRevision}\` (package version \`${version}\`). It is a
prerelease, not the trusted stable desktop channel: it is not signed with an Apple Developer ID and not notarized by
Apple. Choose \`arm64\` for Apple Silicon or \`x64\` for Intel Macs. The Apple Silicon build carries only a local ad-hoc
signature so that it can launch.

## Verify the download

Download the DMG or ZIP together with \`${CHECKSUMS}\`, then check it before opening it:

\`\`\`sh
VERSION=${version}
ARCH=arm64 # or x64
grep " ProPR-Desktop-\${VERSION}-macos-\${ARCH}.dmg\$" ${CHECKSUMS} | shasum -a 256 -c -
# Or, with every asset of this release downloaded into one folder:
shasum -a 256 -c ${CHECKSUMS}
\`\`\`

Every asset also has a GitHub build provenance attestation from the main-branch
\`${MACOS_PREVIEW_WORKFLOW}\` workflow. With the GitHub CLI:

\`\`\`sh
gh attestation verify "ProPR-Desktop-\${VERSION}-macos-\${ARCH}.dmg" \\
  --repo ${repository} \\
  --signer-workflow ${repository}/${MACOS_PREVIEW_WORKFLOW} \\
  --source-ref refs/heads/main \\
  --deny-self-hosted-runners
\`\`\`

Stop if either check fails. \`${PREVIEW_MANIFEST}\` binds every asset to the full source revision above and to the
digest-pinned published runtime images.

## Install

Open the DMG and drag **ProPR** to Applications, or unzip the ZIP and move the app to Applications. Gatekeeper blocks
the first launch because the app is not notarized. On macOS 15 Sequoia and later:

1. Open **ProPR** once. macOS reports that it can't verify the app; click **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Click **Open Anyway** next to the ProPR message, then confirm with your login password.

Alternatively, after verifying the download, remove the quarantine attribute (the bundle on disk is
\`propr-desktop.app\`):

\`\`\`sh
xattr -dr com.apple.quarantine /Applications/propr-desktop.app
\`\`\`

Saved credentials use the ProPR Safe Storage Keychain item; approve the Keychain prompt only if you intended it.
Native macOS notifications may not be delivered by an unsigned build.

## Updates

This preview never updates itself and never contacts the signed update channel. To upgrade, quit ProPR, download a
newer macOS preview from GitHub Releases, verify it as above, and replace the app in Applications. Saved instances and
accounts are kept. The immutable preview identity is \`${tag}\`.
`;

const validateArtifactMetadata = (artifacts, version) => {
  const expectedNames = previewFileNames(version);
  if (!Array.isArray(artifacts) || artifacts.length !== expectedNames.length) {
    throw new Error('macOS preview manifest must contain the exact four-package DMG/ZIP matrix');
  }
  const seen = new Set();
  for (const artifact of artifacts) {
    exactKeys(artifact, ['platform', 'arch', 'kind', 'fileName', 'size', 'sha256'], 'macOS preview artifact');
    if (artifact.platform !== 'darwin' || !['x64', 'arm64'].includes(artifact.arch)
      || !['dmg', 'zip'].includes(artifact.kind)
      || artifact.fileName !== `ProPR-Desktop-${version}-macos-${artifact.arch}.${artifact.kind}`
      || basename(artifact.fileName) !== artifact.fileName
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || !SHA256.test(artifact.sha256) || seen.has(artifact.fileName)) {
      throw new Error('macOS preview manifest contains an invalid or duplicate package');
    }
    seen.add(artifact.fileName);
  }
  if (expectedNames.some(name => !seen.has(name))) {
    throw new Error('macOS preview manifest is missing an architecture-labelled package');
  }
  return [...artifacts].sort((left, right) => left.fileName.localeCompare(right.fileName));
};

const validateManifest = (manifest, { version, sourceRevision, repository }) => {
  if (manifest?.schemaVersion !== PREVIEW_SCHEMA_VERSION) {
    throw new Error(`macOS preview manifest schema ${manifest?.schemaVersion} is not ${PREVIEW_SCHEMA_VERSION}`);
  }
  exactKeys(manifest, [
    'schemaVersion', 'channel', 'trust', 'version', 'sourceRevision', 'tag', 'createdAt',
    'repository', 'workflowRunId', 'codeSigning', 'runtime', 'upgrade', 'artifacts',
  ], 'macOS preview manifest');
  if (manifest.channel !== 'macos-preview' || manifest.trust !== 'unsigned-preview'
    || manifest.version !== version || manifest.sourceRevision !== sourceRevision
    || manifest.tag !== macosPreviewTag(version, sourceRevision)
    || manifest.repository !== repository
    || typeof manifest.workflowRunId !== 'string' || !/^\d+$/.test(manifest.workflowRunId)
    || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('macOS preview manifest identity is invalid');
  }
  exactKeys(manifest.codeSigning, Object.keys(CODE_SIGNING), 'macOS preview code signing');
  if (Object.entries(CODE_SIGNING).some(([key, value]) => manifest.codeSigning[key] !== value)) {
    throw new Error('macOS preview must declare no Developer ID signature and no notarization');
  }
  exactKeys(manifest.runtime, ['distribution', 'appImage', 'uiImage', 'agentImage', 'agentPlatforms'], 'macOS preview runtime');
  if (manifest.runtime.distribution !== 'published'
    || !exactRuntimeImage(manifest.runtime.appImage, 'app', sourceRevision)
    || !exactRuntimeImage(manifest.runtime.uiImage, 'ui', sourceRevision)
    || !exactRuntimeImage(manifest.runtime.agentImage, 'agent', sourceRevision)
    || JSON.stringify(manifest.runtime.agentPlatforms) !== JSON.stringify(MANAGED_AGENT_PLATFORMS)) {
    throw new Error('macOS preview runtime images are not published, digest-pinned, and source-aligned');
  }
  exactKeys(manifest.upgrade, ['selfUpdate', 'mode'], 'macOS preview upgrade policy');
  if (manifest.upgrade.selfUpdate !== false || manifest.upgrade.mode !== 'manual-replace') {
    throw new Error('macOS preview must keep self-update disabled and use manual replacement');
  }
  return validateArtifactMetadata(manifest.artifacts, version);
};

const requireIdentityInputs = ({ version, sourceRevision, repository }) => {
  if (!VERSION.test(version ?? '') || !SHA.test(sourceRevision ?? '') || !REPOSITORY.test(repository ?? '')) {
    throw new Error('macOS preview identity inputs are invalid');
  }
};

export const prepareMacosPreview = async ({
  inputDirectory,
  outputDirectory,
  version,
  sourceRevision,
  runtimeAppImage,
  runtimeUiImage,
  runtimeAgentImage,
  repository,
  workflowRunId,
  createdAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString(),
}) => {
  requireIdentityInputs({ version, sourceRevision, repository });
  if (!/^\d+$/.test(String(workflowRunId))) throw new Error('macOS preview workflow run ID is invalid');
  if (!exactRuntimeImage(runtimeAppImage, 'app', sourceRevision)
    || !exactRuntimeImage(runtimeUiImage, 'ui', sourceRevision)
    || !exactRuntimeImage(runtimeAgentImage, 'agent', sourceRevision)) {
    throw new Error('macOS preview requires exact digest-pinned propr/app, propr/ui and linux/amd64 propr/agent images for the source revision');
  }
  const sourceManifest = JSON.parse(await readFile(join(inputDirectory, 'desktop-release.json'), 'utf8'));
  if (sourceManifest.releaseProfile !== MACOS_PREVIEW_RELEASE_PROFILE
    || sourceManifest.version !== version || sourceManifest.channel !== 'validation'
    || Object.keys(sourceManifest.nativeSigners ?? {}).length !== 0
    || Object.keys(sourceManifest.feeds ?? {}).length !== 0) {
    throw new Error('macOS preview input was not finalized as the unsigned macOS-only preview artifact profile');
  }
  const artifacts = validateArtifactMetadata(sourceManifest.artifacts.map(({
    platform, arch, kind, fileName, size, sha256: digest,
  }) => ({ platform, arch, kind, fileName, size, sha256: digest })), version);
  const sourceChecksums = parseChecksums(await readFile(join(inputDirectory, CHECKSUMS), 'utf8'));
  if (sourceChecksums.size !== artifacts.length
    || artifacts.some(artifact => sourceChecksums.get(artifact.fileName) !== artifact.sha256)) {
    throw new Error('Finalized macOS preview package checksums are incomplete or inconsistent');
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const artifact of artifacts) {
    const source = join(inputDirectory, artifact.fileName);
    const details = await lstat(source);
    if (!details.isFile() || details.size !== artifact.size || await sha256(source) !== artifact.sha256) {
      throw new Error(`Finalized macOS preview package bytes drifted: ${artifact.fileName}`);
    }
    await copyFile(source, join(outputDirectory, artifact.fileName));
  }
  const tag = macosPreviewTag(version, sourceRevision);
  const manifest = {
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    channel: 'macos-preview',
    trust: 'unsigned-preview',
    version,
    sourceRevision,
    tag,
    createdAt,
    repository,
    workflowRunId: String(workflowRunId),
    codeSigning: { ...CODE_SIGNING },
    runtime: {
      distribution: 'published',
      appImage: runtimeAppImage,
      uiImage: runtimeUiImage,
      agentImage: runtimeAgentImage,
      agentPlatforms: [...MANAGED_AGENT_PLATFORMS],
    },
    upgrade: { selfUpdate: false, mode: 'manual-replace' },
    artifacts,
  };
  validateManifest(manifest, { version, sourceRevision, repository });
  await writeFile(join(outputDirectory, PREVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, INSTALL_NOTES), macosPreviewInstallNotes({ version, sourceRevision, tag, repository }));
  await writeFile(join(outputDirectory, CHECKSUMS), `${(await Promise.all(checksumNames(version).map(async name => (
    `${await sha256(join(outputDirectory, name))}  ${name}`
  )))).join('\n')}\n`);
  return manifest;
};

export const readMacosPreviewBundle = async ({ directory, version, sourceRevision, repository }) => {
  requireIdentityInputs({ version, sourceRevision, repository });
  const names = (await readdir(directory)).sort();
  const expectedNames = expectedBundleNames(version);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error('macOS preview bundle contains missing or unexpected assets');
  }
  const packages = new Set(previewFileNames(version));
  for (const name of expectedNames) {
    const details = await lstat(join(directory, name));
    if (!details.isFile() || details.size <= 0) throw new Error(`macOS preview asset is not a regular nonempty file: ${name}`);
    if (!packages.has(name) && details.size > MAX_METADATA_BYTES) throw new Error(`Oversized macOS preview metadata: ${name}`);
  }
  const manifest = JSON.parse(await readFile(join(directory, PREVIEW_MANIFEST), 'utf8'));
  const artifacts = validateManifest(manifest, { version, sourceRevision, repository });
  const notes = await readFile(join(directory, INSTALL_NOTES), 'utf8');
  if (notes !== macosPreviewInstallNotes({ version, sourceRevision, tag: manifest.tag, repository })) {
    throw new Error('macOS preview install notes differ from the canonical unsigned-preview instructions');
  }
  const checksums = parseChecksums(await readFile(join(directory, CHECKSUMS), 'utf8'));
  const allowlist = checksumNames(version);
  if (checksums.size !== allowlist.length || allowlist.some(name => !checksums.has(name))) {
    throw new Error('macOS preview checksum allowlist is incomplete or inconsistent');
  }
  const assets = new Map();
  for (const name of expectedNames) {
    const path = join(directory, name);
    const { size } = await stat(path);
    const artifact = artifacts.find(candidate => candidate.fileName === name);
    const digest = await sha256(path);
    if ((artifact && (artifact.size !== size || artifact.sha256 !== digest))
      || (name !== CHECKSUMS && checksums.get(name) !== digest)) {
      throw new Error(`macOS preview asset digest mismatch: ${name}`);
    }
    assets.set(name, { name, path, size, sha256: digest });
  }
  return { manifest, assets, notes };
};

const previewReleaseName = (version, sourceRevision) => (
  `ProPR Desktop macOS preview ${version} (${sourceRevision.slice(0, 12)})`
);

const assertDraft = (release, { tag, sourceRevision, version, notes }) => {
  if (!Number.isSafeInteger(release?.id) || release.tag_name !== tag
    || release.target_commitish !== sourceRevision || release.draft !== true
    || release.prerelease !== true || release.published_at != null
    || release.name !== previewReleaseName(version, sourceRevision)
    || release.body !== notes || typeof release.upload_url !== 'string') {
    throw new Error('GitHub release is not the exact unpublished macOS preview draft');
  }
};

const requireUnusedTag = async (json, tag, message) => {
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error(message);
  }
};

const verifyCompleteDraft = async ({ json, request, release, assets, apiOrigin }) => {
  const remote = await listAssets(json, release.id);
  const seen = new Map();
  for (const asset of remote) {
    if (seen.has(asset.name) || !assets.has(asset.name)) {
      throw new Error(`macOS preview draft contains an unexpected or duplicate asset: ${asset.name}`);
    }
    seen.set(asset.name, asset);
    await verifyRemoteAsset({ request, asset, expected: assets.get(asset.name), apiOrigin });
  }
  return seen;
};

export const stageMacosPreviewDraft = async ({
  directory, version, sourceRevision, repository, token,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
}) => {
  if (!token) throw new Error('macOS preview GitHub token is required');
  const tag = macosPreviewTag(version, sourceRevision);
  const { manifest, assets, notes } = await readMacosPreviewBundle({ directory, version, sourceRevision, repository });
  const apiOrigin = new URL(apiUrl).origin;
  const { request, json } = githubClient({ repository, token, apiUrl, fetchImpl });
  await requireUnusedTag(json, tag, 'macOS preview tag already exists; preview identities are never reused');
  if ((await json(`/commits/${sourceRevision}`))?.sha !== sourceRevision) {
    throw new Error('macOS preview source revision is unavailable');
  }
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
  assertDraft(release, { tag, sourceRevision, version, notes });
  // Resume safely: anything already uploaded must be byte-identical.
  const existing = await verifyCompleteDraft({ json, request, release, assets, apiOrigin });
  const uploadBase = trustedUploadBase(release, apiOrigin, LABEL);
  for (const asset of assets.values()) {
    if (existing.has(asset.name)) continue;
    const uploadUrl = new URL(uploadBase);
    uploadUrl.searchParams.set('name', asset.name);
    await request(uploadUrl.toString(), {
      method: 'POST',
      body: createReadStream(asset.path),
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) },
    });
  }
  const complete = await verifyCompleteDraft({ json, request, release, assets, apiOrigin });
  if (complete.size !== assets.size) throw new Error('macOS preview draft asset upload is incomplete');
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version, notes });
  return { releaseId: release.id, tag, manifest };
};

// Publishes the staged draft only after re-downloading every remote asset and
// matching it to the exact finalized (and attested) bundle from the same run.
export const publishMacosPreviewDraft = async ({
  directory, version, sourceRevision, repository, token,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
}) => {
  if (!token) throw new Error('macOS preview GitHub token is required');
  const tag = macosPreviewTag(version, sourceRevision);
  const { assets, notes } = await readMacosPreviewBundle({ directory, version, sourceRevision, repository });
  const apiOrigin = new URL(apiUrl).origin;
  const { request, json } = githubClient({ repository, token, apiUrl, fetchImpl });
  await requireUnusedTag(json, tag, 'macOS preview tag already exists; refusing to republish or move it');
  const release = await findReleaseByTag(json, tag);
  assertDraft(release, { tag, sourceRevision, version, notes });
  const verified = await verifyCompleteDraft({ json, request, release, assets, apiOrigin });
  if (verified.size !== assets.size) throw new Error('macOS preview draft does not contain the exact asset set');
  if ((await json(`/commits/${sourceRevision}`))?.sha !== sourceRevision) {
    throw new Error('macOS preview source revision is unavailable at publication');
  }
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version, notes });
  await requireUnusedTag(json, tag, 'macOS preview tag appeared during verification; refusing publication');
  const finalAssets = await listAssets(json, release.id);
  if (finalAssets.length !== verified.size || finalAssets.some(asset => {
    const checked = verified.get(asset.name);
    return !checked || asset.id !== checked.id || asset.size !== checked.size
      || asset.digest !== checked.digest || asset.state !== 'uploaded';
  })) {
    throw new Error('macOS preview draft assets changed during publication verification');
  }
  const published = await json(`/releases/${release.id}`, {
    method: 'PATCH',
    json: { draft: false, prerelease: true, make_latest: 'false' },
  });
  if (published?.id !== release.id || published.tag_name !== tag || published.draft !== false
    || published.prerelease !== true || !published.published_at) {
    throw new Error('GitHub did not confirm the exact macOS preview prerelease publication');
  }
  if ((await json(`/commits/${encodeURIComponent(tag)}`))?.sha !== sourceRevision) {
    throw new Error('Published macOS preview tag does not resolve to the approved source revision');
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
    const identity = {
      version: argument('--version'),
      sourceRevision: argument('--source-revision'),
      repository: argument('--repository'),
    };
    const github = { token: process.env.GITHUB_TOKEN, apiUrl: process.env.GITHUB_API_URL || undefined };
    if (command === 'prepare') {
      await prepareMacosPreview({
        ...identity,
        inputDirectory: resolve(argument('--input') || 'desktop-macos-preview-validated'),
        outputDirectory: resolve(argument('--output') || 'desktop-macos-preview-final'),
        runtimeAppImage: argument('--runtime-app-image'),
        runtimeUiImage: argument('--runtime-ui-image'),
        runtimeAgentImage: argument('--runtime-agent-image'),
        workflowRunId: argument('--workflow-run-id'),
      });
    } else if (command === 'verify') {
      await readMacosPreviewBundle({ ...identity, directory: resolve(argument('--directory') || 'desktop-macos-preview-final') });
    } else if (command === 'stage-draft') {
      const result = await stageMacosPreviewDraft({
        ...identity, ...github, directory: resolve(argument('--directory') || 'desktop-macos-preview-final'),
      });
      console.log(JSON.stringify({ releaseId: result.releaseId, tag: result.tag }));
    } else if (command === 'publish-draft') {
      const result = await publishMacosPreviewDraft({
        ...identity, ...github, directory: resolve(argument('--directory') || 'desktop-macos-preview-final'),
      });
      console.log(JSON.stringify({ releaseId: result.id, tag: result.tag_name, url: result.html_url }));
    } else {
      throw new Error('Expected macos-preview-release.mjs prepare, verify, stage-draft, or publish-draft command');
    }
  } catch (error) {
    console.error((error instanceof Error ? error : new Error(String(error))).message);
    process.exitCode = 1;
  }
}
