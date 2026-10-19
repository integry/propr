import { validateSignedRpmAcceptanceEvidence, verifySignedRpmEvidenceArtifact } from './signed-rpm-acceptance-evidence.mjs';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { requireRpmIdentity, rpmIdentityFromEnvironment, verifyRpm, signRpm, rpmContentDigest } from './rpm-signing.mjs';
import { authAssets, aptAssets, createApt, verifyApt, signMetadata, verifyMetadata } from './linux-package-auth.mjs';
import { inspectSignedPreviewPayload } from './rpm-preview-payload.mjs';
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
// Schema 2 adds the managed agent binding that first-user task setup needs.
// Schema 1 app/UI-only bundles are refused: they do not prove that contract.
const PREVIEW_SCHEMA_VERSION = 2;
// The managed agent image is linux/amd64 only (see Dockerfile.agent).
const MANAGED_AGENT_PLATFORMS = ['linux/amd64'];
const execFile = promisify(execFileCallback);

export const linuxPreviewTag = (version, sourceRevision, rpmIdentity) => {
  if (!VERSION.test(version) || !SHA.test(sourceRevision)) {
    throw new Error('Linux preview identity requires a semantic version and full lowercase source revision');
  }
  if (rpmIdentity) requireRpmIdentity(rpmIdentity);
  return `desktop-linux-preview-v${version}-${sourceRevision.slice(0, 12)}${rpmIdentity ? '-all-signed' : ''}`;
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

const unsignedInstallNotes = ({ version, sourceRevision, tag }) => `# ProPR Desktop Linux preview

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

## Managed agent architecture

The desktop app and its app/UI runtime images support both \`x64\` and \`arm64\`. The managed agent image that runs
tasks is published for \`linux/amd64\` only, and \`${PREVIEW_MANIFEST}\` pins its exact digest for this source revision.
On an \`arm64\` host, setup reports that the managed agent image could not be pulled and agent tasks cannot run; no
emulated or substitute agent image is provided. Provider sign-in and real task execution with this preview have not
yet been validated end to end.
`;

export const linuxPreviewInstallNotes = ({ version, sourceRevision, tag, rpmIdentity }) => {
  let notes = unsignedInstallNotes({ version, sourceRevision, tag });
  if (!rpmIdentity) return notes;
  requireRpmIdentity(rpmIdentity);
  notes = notes.replace('an explicitly unsigned preview', 'an authenticated DEB and RPM preview')
    .replace('sudo dnf install ', 'sudo dnf --setopt=localpkg_gpgcheck=1 install ')
    .replace('sudo dnf upgrade ', 'sudo dnf --setopt=localpkg_gpgcheck=1 upgrade ')
    .replace('sudo dnf reinstall ', 'sudo dnf --setopt=localpkg_gpgcheck=1 reinstall ');
  const bootstrap = `Before any installation, complete "Verify every download before installation" below.

## RPM public-key trust bootstrap (including openSUSE Leap 15.6)

Both RPM architectures carry native RSA/SHA256 header and package signatures.
Expected full OpenPGP fingerprint: \`${rpmIdentity.fingerprint}\`.
Confirm this fingerprint through the owner's independently published release-key notice
before importing anything. A key shipped alongside a package is not itself a trust anchor.
First-time NOKEY / unknown-key means trust is missing; "Package header is not signed"
means the wrong (unsigned) package was downloaded. Stop on either until resolved.

Extract the public key from this bundle (requires Python 3), inspect its fingerprint,
then explicitly choose to trust it system-wide. These commands are user actions;
the application and release helpers never import keys into your system database.

\`\`\`sh
python3 -c 'import json; k = json.load(open("linux-preview.json"))["rpmSigning"]["publicKey"]; print(k, end="" if k.endswith("\\n") else "\\n")' > propr-desktop-rpm.asc
gpg --show-keys --with-fingerprint propr-desktop-rpm.asc
# Compare the FULL fingerprint with the independent owner notice before continuing:
sudo rpm --import propr-desktop-rpm.asc
VERSION=${version}
ARCH=x64 # or arm64
sha256sum --check SHA256SUMS
rpmkeys --checksig --verbose "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.rpm"
# Require both Header ... Signature ... OK and ... Signature ... OK, not just digests.
# Both key IDs must match the confirmed fingerprint suffix; reject any failed status.
sudo zypper install "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.rpm"
# For an intentionally unchanged package version, after the same verification:
sudo zypper install --force "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.rpm"
\`\`\`

Do not accept an unsigned-package override or signature failure. An already imported
unrelated key is not proof of this release identity. The primary path for
ordinary verification above uses rpmkeys and does not require Node or a repository checkout.
Optionally, use the standalone public-only helper with Node.js 22+, GnuPG and RPM tools.
Choose a reviewed full helper commit SHA from integry/propr (which may differ from this
package's source revision), download that pinned source, and inspect it before running:

\`\`\`sh
HELPER_REVISION='REPLACE_WITH_REVIEWED_FULL_HELPER_COMMIT_SHA'
curl --fail --location "https://raw.githubusercontent.com/integry/propr/\${HELPER_REVISION}/apps/desktop/scripts/rpm-signing.mjs" -o rpm-signing.mjs
# Inspect the downloaded helper before running it.
node ./rpm-signing.mjs verify \\
  --rpm "./ProPR-Desktop-\${VERSION}-linux-\${ARCH}.rpm" \\
  --public-key propr-desktop-rpm.asc \\
  --fingerprint "${rpmIdentity.fingerprint}"
\`\`\`

Run it only after independently confirming that fingerprint. SHA256SUMS describes all final DEB/RPM and repository bytes;
never replace them with originals from the unsigned preview or a build fragment.

Direct DEB downloads are authenticated by the detached signature on SHA256SUMS,
then the package hash. APT authenticates repository metadata and package hashes;
it does not verify an embedded DEB signature.

## Verify every download before installation

Obtain propr-desktop-release.asc from the independently reviewed public release-key
notice in the project docs. Confirm its complete fingerprint is
\`${rpmIdentity.fingerprint}\`. Use a fresh isolated keyring, with no host trust:

\`\`\`sh
KEYHOME="$(mktemp -d)"
chmod 700 "$KEYHOME"
gpg --homedir "$KEYHOME" --import propr-desktop-release.asc
gpg --homedir "$KEYHOME" --with-colons --fingerprint
# Stop unless there is exactly one primary key with the full fingerprint above.
gpg --homedir "$KEYHOME" --verify SHA256SUMS.asc SHA256SUMS
# Stop on failure, expiration, revocation, or a different signer.
sha256sum --check SHA256SUMS
# Only after both checks succeed, install the chosen DEB using the command below.
\`\`\`

## Exported APT repository bundle (no hosted endpoint)

The APT-* assets and the same final DEBs form an exported repository. After the
checks above, assemble it locally; no production APT URL is provisioned:

\`\`\`sh
mkdir -p apt-repository/dists/preview/main/binary-amd64 apt-repository/dists/preview/main/binary-arm64 apt-repository/pool
cp APT-Packages-amd64 apt-repository/dists/preview/main/binary-amd64/Packages
cp APT-Packages-arm64 apt-repository/dists/preview/main/binary-arm64/Packages
cp APT-Release apt-repository/dists/preview/Release
cp APT-InRelease apt-repository/dists/preview/InRelease
cp APT-Release.gpg apt-repository/dists/preview/Release.gpg
cp ProPR-Desktop-${version}-linux-*.deb apt-repository/pool/
gpg --homedir "$KEYHOME" --verify APT-Release.gpg APT-Release
gpg --homedir "$KEYHOME" --output "$KEYHOME/Release" --decrypt APT-InRelease
cmp APT-Release "$KEYHOME/Release"
gpg --homedir "$KEYHOME" --export '${rpmIdentity.fingerprint}' > propr-desktop-release.gpg
\`\`\`

For a locally served or file-backed copy, use a source entry of the form
\`deb [signed-by=/absolute/path/propr-desktop-release.gpg] file:/absolute/path/apt-repository preview main\`.
The public keyring and repository must be readable by APT. Keep Signed-By scoped to
this source. Run apt update before downloading; stop on any authentication or hash
failure. Release metadata expires after 30 days. This is not a live hosted endpoint,
a stable/latest promotion, or a self-update feed.

`;
  return notes.replace('## Debian and Ubuntu (DEB)', `${bootstrap}## Debian and Ubuntu (DEB)`);
};

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
      || artifact.fileName !== `ProPR-Desktop-${version}-linux-${artifact.arch}.${artifact.kind}`
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

const validateManifest = (manifest, { version, sourceRevision, repository, rpmIdentity, historicalRpmOnly = false }) => {
  if (rpmIdentity) requireRpmIdentity(rpmIdentity);
  const expectedSchema = rpmIdentity ? (historicalRpmOnly ? 3 : 4) : PREVIEW_SCHEMA_VERSION;
  if (manifest?.schemaVersion !== expectedSchema) {
    throw new Error(`Linux preview manifest schema ${manifest?.schemaVersion} is not the managed-agent-bound schema ${expectedSchema}; select the correct preview mode`);
  }
  exactKeys(manifest, [
    'schemaVersion', 'channel', 'trust', 'version', 'sourceRevision', 'tag', 'createdAt',
    'repository', 'workflowRunId', 'runtime', 'upgrade', 'artifacts',
    ...(rpmIdentity ? ['rpmSigning', ...(historicalRpmOnly ? [] : ['signing'])] : []),
  ], 'Linux preview manifest');
  if (manifest.channel !== 'linux-preview'
    || manifest.trust !== (rpmIdentity ? (historicalRpmOnly ? 'rpm-signed-preview' : 'authenticated-linux-preview') : 'unsigned-preview') || manifest.version !== version
    || manifest.sourceRevision !== sourceRevision
    || manifest.tag !== (historicalRpmOnly ? `${linuxPreviewTag(version, sourceRevision)}-rpm-signed` : linuxPreviewTag(version, sourceRevision, rpmIdentity))
    || manifest.repository !== repository
    || typeof manifest.workflowRunId !== 'string' || !/^\d+$/.test(manifest.workflowRunId)
    || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('Linux preview manifest identity is invalid');
  }
  exactKeys(manifest.runtime, [
    'distribution', 'appImage', 'uiImage', 'agentImage', 'agentPlatforms',
  ], 'Linux preview runtime');
  if (manifest.runtime.distribution !== 'published'
    || !exactRuntimeImage(manifest.runtime.appImage, 'app', sourceRevision)
    || !exactRuntimeImage(manifest.runtime.uiImage, 'ui', sourceRevision)
    || !exactRuntimeImage(manifest.runtime.agentImage, 'agent', sourceRevision)
    || JSON.stringify(manifest.runtime.agentPlatforms) !== JSON.stringify(MANAGED_AGENT_PLATFORMS)) {
    throw new Error('Linux preview runtime images are not published, digest-pinned, and source-aligned');
  }
  exactKeys(manifest.upgrade, ['selfUpdate', 'mode'], 'Linux preview upgrade policy');
  if (manifest.upgrade.selfUpdate !== false || manifest.upgrade.mode !== 'manual-package-manager') {
    throw new Error('Linux preview must keep self-update disabled and use package-manager upgrades');
  }
  if (rpmIdentity) {
    if (!historicalRpmOnly) {
      exactKeys(manifest.signing, ['createdAt', 'originalDebs'], 'Linux authentication evidence');
      if (typeof manifest.signing.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.signing.createdAt)) throw new Error('Invalid signing date');
      const debs = previewFileNames(version).filter(name => name.endsWith('.deb'));
      exactKeys(manifest.signing.originalDebs, debs, 'Original DEBs');
      for (const name of debs) {
        if (manifest.signing.originalDebs[name] !== manifest.artifacts.find(a => a.fileName === name)?.sha256) throw new Error('DEB changed from original bytes');
      }
    }
    exactKeys(manifest.rpmSigning, ['fingerprint', 'publicKey', 'originals'], 'RPM signing evidence');
    if (manifest.rpmSigning.fingerprint !== rpmIdentity.fingerprint
      || manifest.rpmSigning.publicKey !== rpmIdentity.publicKey) throw new Error('RPM signing identity differs from configured public identity');
    const rpms = previewFileNames(version).filter(name => name.endsWith('.rpm'));
    exactKeys(manifest.rpmSigning.originals, rpms, 'Original unsigned RPMs');
    for (const name of rpms) {
      const evidence = manifest.rpmSigning.originals[name];
      exactKeys(evidence, ['sha256', 'contentSha256'], 'Original RPM evidence');
      if (!SHA256.test(evidence.sha256) || !SHA256.test(evidence.contentSha256)) throw new Error('Invalid original RPM hashes');
    }
  }
  return validateArtifactMetadata(manifest.artifacts, version);
};

// Audit-only metadata reader. This does not verify packages or authenticate the
// old manifest/checksums; no staging/publication API accepts this result as trust.
export async function readHistoricalLinuxPreviewMetadata({ path, version, sourceRevision, repository, rpmIdentity }) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (![2, 3].includes(manifest.schemaVersion)) throw new Error('Expected historical schema 2 or 3');
  const historicalRpmOnly = manifest.schemaVersion === 3;
  if (historicalRpmOnly && !rpmIdentity) throw new Error('Historical RPM identity required');
  validateManifest(manifest, { version, sourceRevision, repository,
    rpmIdentity: historicalRpmOnly ? rpmIdentity : undefined, historicalRpmOnly });
  return { manifest, trust: manifest.trust, metadataAuthenticated: false, publicationEligible: false };
}

const expectedBundleNames = (version, identity) => [...previewFileNames(version), INSTALL_NOTES, PREVIEW_MANIFEST, CHECKSUMS, ...(identity ? authAssets : [])].sort();
const checksumNames = (version, identity) => expectedBundleNames(version, identity).filter(name => name !== CHECKSUMS && name !== 'SHA256SUMS.asc');

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
  runtimeAgentImage,
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
  if (!exactRuntimeImage(runtimeAgentImage, 'agent', sourceRevision)) {
    throw new Error('Linux preview requires an exact digest-pinned linux/amd64 propr/agent image for the source revision so first-user task setup can pull it');
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
    schemaVersion: PREVIEW_SCHEMA_VERSION,
    channel: 'linux-preview',
    trust: 'unsigned-preview',
    version,
    sourceRevision,
    tag,
    createdAt,
    repository,
    workflowRunId: String(workflowRunId),
    runtime: {
      distribution: 'published',
      appImage: runtimeAppImage,
      uiImage: runtimeUiImage,
      agentImage: runtimeAgentImage,
      agentPlatforms: [...MANAGED_AGENT_PLATFORMS],
    },
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

export const readLinuxPreviewBundle = async ({ directory, version, sourceRevision, repository, rpmIdentity, sourceDirectory }) => {
  const names = (await readdir(directory)).sort();
  const expectedNames = expectedBundleNames(version, rpmIdentity);
  if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
    throw new Error('Linux preview bundle contains missing or unexpected assets');
  }
  for (const name of expectedNames) {
    const details = await lstat(join(directory, name));
    if (!details.isFile() || details.size <= 0) throw new Error('Linux preview requires regular nonempty files');
    if (!previewFileNames(version).includes(name) && details.size > MAX_METADATA_BYTES) throw new Error('Oversized preview metadata');
  }
  if (rpmIdentity) await verifyMetadata({ path: join(directory, CHECKSUMS), signature: join(directory, 'SHA256SUMS.asc'), identity: rpmIdentity });
  const manifest = JSON.parse(await readFile(join(directory, PREVIEW_MANIFEST), 'utf8'));
  const artifacts = validateManifest(manifest, { version, sourceRevision, repository, rpmIdentity });
  const expectedChecksums = new Map([
    ...artifacts.map(artifact => [artifact.fileName, artifact.sha256]),
    ...await Promise.all([INSTALL_NOTES, PREVIEW_MANIFEST, ...(rpmIdentity ? aptAssets : [])]
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
    const details = await lstat(path);
    const artifact = artifacts.find(candidate => candidate.fileName === name);
    if (artifact && details.size !== artifact.size) throw new Error(`Linux preview asset size mismatch: ${name}`);
    if (!details.isFile() || details.size <= 0) throw new Error(`Linux preview asset is not a regular file: ${name}`);
    const digest = await sha256(path);
    if (name !== CHECKSUMS && name !== 'SHA256SUMS.asc' && checksums.get(name) !== digest) {
      throw new Error(`Linux preview asset digest mismatch: ${name}`);
    }
    assets.set(name, { name, path, size: details.size, sha256: digest });
  }
  if (rpmIdentity) {
    await verifyApt({ directory, manifest, identity: rpmIdentity });
    if (await readFile(join(directory, INSTALL_NOTES), 'utf8') !== linuxPreviewInstallNotes({ version, sourceRevision, tag: manifest.tag, rpmIdentity })) {
      throw new Error('Signed preview install instructions differ from canonical trust bootstrap');
    }
    for (const artifact of artifacts) {
      await verifySignedArtifact({ path: join(directory, artifact.fileName), artifact, manifest, rpmIdentity, sourceDirectory });
    }
  }
  return { manifest, assets, notes: await readFile(join(directory, INSTALL_NOTES), 'utf8') };
};

async function verifySignedArtifact({ path, artifact, manifest, rpmIdentity, sourceDirectory }) {
  await inspectLinuxPackageVersion({ path, kind: artifact.kind, version: manifest.version });
  if (artifact.kind === 'rpm') {
    await verifyRpm({ path, identity: rpmIdentity });
    if (await rpmContentDigest(path) !== manifest.rpmSigning.originals[artifact.fileName].contentSha256) {
      throw new Error('Signed RPM main header/payload differs from original');
    }
  }
  await inspectSignedPreviewPayload({ path, artifact, manifest, sourceDirectory });
}

export async function signLinuxPreviewBundle({ directory, outputDirectory, version, sourceRevision,
  repository, rpmIdentity, sourceDirectory, privateKey, passphrase }) {
  requireRpmIdentity(rpmIdentity);
  const { manifest } = await readLinuxPreviewBundle({ directory, version, sourceRevision, repository });
  // Never mutate or overwrite an unsigned bundle or an existing signed candidate.
  await mkdir(outputDirectory);
  const originalDebs = Object.fromEntries(manifest.artifacts.filter(a => a.kind === 'deb').map(a => [a.fileName, a.sha256]));
  const originals = {};
  for (const artifact of manifest.artifacts) {
    const source = join(directory, artifact.fileName);
    const destination = join(outputDirectory, artifact.fileName);
    await inspectLinuxPackageVersion({ path: source, kind: artifact.kind, version });
    await inspectSignedPreviewPayload({ path: source, artifact, manifest, sourceDirectory });
    await copyFile(source, destination);
    if (artifact.kind === 'rpm') {
      originals[artifact.fileName] = { sha256: artifact.sha256,
        contentSha256: await signRpm({ path: destination, identity: rpmIdentity, privateKey, passphrase }) };
    }
    artifact.sha256 = await sha256(destination);
    artifact.size = (await stat(destination)).size;
  }
  manifest.schemaVersion = 4;
  manifest.trust = 'authenticated-linux-preview';
  manifest.tag = linuxPreviewTag(version, sourceRevision, rpmIdentity);
  manifest.rpmSigning = { ...rpmIdentity, originals };
  manifest.signing = { createdAt: new Date().toISOString(), originalDebs };
  validateManifest(manifest, { version, sourceRevision, repository, rpmIdentity });
  // Reinspect final bytes before producing final metadata/checksums.
  for (const artifact of manifest.artifacts) {
    await verifySignedArtifact({ path: join(outputDirectory, artifact.fileName), artifact, manifest, rpmIdentity, sourceDirectory });
  }
  await writeFile(join(outputDirectory, PREVIEW_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, INSTALL_NOTES), linuxPreviewInstallNotes({ version, sourceRevision, tag: manifest.tag, rpmIdentity }));
  await createApt({ directory: outputDirectory, manifest, identity: rpmIdentity, privateKey, passphrase });
  const names = checksumNames(version, rpmIdentity);
  await writeFile(join(outputDirectory, CHECKSUMS), `${(await Promise.all(names.map(async name =>
    `${await sha256(join(outputDirectory, name))}  ${name}`))).join('\n')}\n`);
  await signMetadata({ path: join(outputDirectory, CHECKSUMS), output: join(outputDirectory, 'SHA256SUMS.asc'), identity: rpmIdentity, privateKey, passphrase });
  await readLinuxPreviewBundle({ directory: outputDirectory, version, sourceRevision, repository, rpmIdentity, sourceDirectory });
  return manifest;
}

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

const previewReleaseName = (version, sourceRevision, rpmIdentity) => (
  `ProPR Desktop Linux preview ${version} (${sourceRevision.slice(0, 12)})${rpmIdentity ? ' (authenticated DEB and RPM)' : ''}`
);

const assertDraft = (release, { tag, sourceRevision, version, rpmIdentity }) => {
  if (!Number.isSafeInteger(release?.id) || release.tag_name !== tag
    || release.target_commitish !== sourceRevision || release.draft !== true
    || release.prerelease !== true || release.published_at != null
    || release.name !== previewReleaseName(version, sourceRevision, rpmIdentity)
    || release.body !== linuxPreviewInstallNotes({ version, sourceRevision, tag, rpmIdentity })
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
  directory, version, sourceRevision, repository, token, rpmIdentity, sourceDirectory,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
}) => {
  if (!REPOSITORY.test(repository) || !token) throw new Error('Linux preview GitHub inputs are invalid');
  const tag = linuxPreviewTag(version, sourceRevision, rpmIdentity);
  const { manifest, assets, notes } = await readLinuxPreviewBundle({ directory, version, sourceRevision, repository, rpmIdentity, sourceDirectory });
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
        name: previewReleaseName(version, sourceRevision, rpmIdentity),
        body: notes,
        draft: true,
        prerelease: true,
        generate_release_notes: false,
      },
    });
  }
  assertDraft(release, { tag, sourceRevision, version, rpmIdentity });
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
  const completeNames = new Set();
  for (const asset of complete) {
    if (completeNames.has(asset.name)) throw new Error('Duplicate completed draft asset');
    completeNames.add(asset.name);
    const expected = assets.get(asset.name);
    if (!expected) throw new Error(`Linux preview draft contains unexpected asset: ${asset.name}`);
    await verifyRemoteAsset({ request, asset, expected, apiOrigin });
  }
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version, rpmIdentity });
  return { releaseId: release.id, tag, manifest };
};

export const publishLinuxPreviewDraft = async ({
  version, sourceRevision, repository, token, rpmIdentity, sourceDirectory, acceptanceEvidence, signingRunId,
  apiUrl = 'https://api.github.com', fetchImpl = fetch,
}) => {
  if (!rpmIdentity) throw new Error('Public Linux publication requires authenticated DEB and RPM mode');
  if (!REPOSITORY.test(repository) || !token) throw new Error('Linux preview publication inputs are invalid');
  const tag = linuxPreviewTag(version, sourceRevision, rpmIdentity);
  const apiOrigin = new URL(apiUrl).origin;
  const { request, json } = githubClient({ repository, token, apiUrl, fetchImpl });
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error('Linux preview tag already exists; refusing to republish or move it');
  }
  const release = await findReleaseByTag(json, tag);
  assertDraft(release, { tag, sourceRevision, version, rpmIdentity });
  const listed = await listAssets(json, release.id);
  const expectedNames = expectedBundleNames(version, rpmIdentity);
  if (listed.length !== expectedNames.length) throw new Error('Linux preview draft does not contain the exact asset set');
  const assets = new Map();
  for (const asset of listed) {
    if (!expectedNames.includes(asset.name) || assets.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Linux preview draft contains an invalid or duplicate asset: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }

  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES, CHECKSUMS, ...(rpmIdentity ? authAssets : [])]) {
    const asset = assets.get(name);
    if (!asset || asset.size > MAX_METADATA_BYTES
      || (asset.digest != null && !/^sha256:[a-f0-9]{64}$/.test(asset.digest))) {
      throw new Error(`Linux preview draft has invalid metadata asset ${name}`);
    }
  }
  const metadata = {};
  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES, CHECKSUMS, ...(rpmIdentity ? authAssets : [])]) {
    const asset = assets.get(name);
    metadata[name] = await verifyRemoteAsset({
      request,
      asset,
      expected: { name, size: asset.size },
      apiOrigin,
    });
  }
  const manifest = JSON.parse(metadata[PREVIEW_MANIFEST].toString('utf8'));
  const artifactMetadata = validateManifest(manifest, { version, sourceRevision, repository, rpmIdentity });
  const acceptedRpm = artifactMetadata.find(artifact => artifact.kind === 'rpm' && artifact.arch === 'x64');
  validateSignedRpmAcceptanceEvidence(acceptanceEvidence, { sourceRevision, rpmSha256: acceptedRpm.sha256,
    signingRunId, fingerprint: rpmIdentity.fingerprint });
  const signingRun = await json(`/actions/runs/${signingRunId}`);
  if (String(signingRun?.id) !== signingRunId || signingRun.event !== 'workflow_dispatch'
    || signingRun.path !== '.github/workflows/desktop-linux-signed-preview.yml'
    || signingRun.head_branch !== 'main' || signingRun.conclusion !== 'success'
    || signingRun.repository?.full_name !== repository) {
    throw new Error('Installed signed RPM acceptance requires a successful trusted signing workflow run');
  }
  await verifySignedRpmEvidenceArtifact({ json, request, signingRunId, evidence: acceptanceEvidence });
  if (metadata[INSTALL_NOTES].toString('utf8') !== linuxPreviewInstallNotes({ version, sourceRevision, tag, rpmIdentity })) {
    throw new Error('Linux preview install and channel instructions do not match the approved identity');
  }
  const checksums = parseChecksums(metadata[CHECKSUMS].toString('utf8'));
  if (checksums.size !== checksumNames(version, rpmIdentity).length) throw new Error('Linux preview checksum allowlist is incomplete');
  for (const name of [PREVIEW_MANIFEST, INSTALL_NOTES]) {
    const digest = createHash('sha256').update(metadata[name]).digest('hex');
    if (checksums.get(name) !== digest) throw new Error(`Linux preview checksum mismatch: ${name}`);
  }

  const downloadDirectory = await mkdtemp(join(tmpdir(), 'propr-linux-preview-publish-'));
  try {
    for (const [name, bytes] of Object.entries(metadata)) await writeFile(join(downloadDirectory, name), bytes);
    await verifyMetadata({ path: join(downloadDirectory, CHECKSUMS), signature: join(downloadDirectory, 'SHA256SUMS.asc'), identity: rpmIdentity });
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

    }
    await readLinuxPreviewBundle({ directory: downloadDirectory, version, sourceRevision, repository, rpmIdentity, sourceDirectory });
  } finally {
    await rm(downloadDirectory, { recursive: true, force: true });
  }

  const commit = await json(`/commits/${sourceRevision}`);
  if (commit?.sha !== sourceRevision) throw new Error('Linux preview source revision is unavailable at publication');
  assertDraft(await json(`/releases/${release.id}`), { tag, sourceRevision, version, rpmIdentity });
  if (await json(`/git/ref/tags/${encodeURIComponent(tag)}`, { allowNotFound: true }) !== undefined) {
    throw new Error('Linux preview tag appeared during authorization; refusing publication');
  }
  const finalAssets = await listAssets(json, release.id);
  if (finalAssets.length !== assets.size || new Set(finalAssets.map(a => a.name)).size !== assets.size
    || finalAssets.some(a => {
      const checked = assets.get(a.name);
      return !checked || a.id !== checked.id || a.size !== checked.size || a.digest !== checked.digest || a.state !== 'uploaded';
    })) throw new Error('Draft assets changed during publication verification');
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
  // Capture before any await or package parser can spawn an inheriting child.
  const privateKey = process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
  const passphrase = process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
  delete process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
  delete process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
  try {
    const command = process.argv[2];
    const version = argument('--version');
    const sourceRevision = argument('--source-revision');
    const repository = argument('--repository');
    const rpmIdentity = (process.argv.includes('--signed-linux') || process.argv.includes('--signed-rpm')) ? rpmIdentityFromEnvironment() : undefined;
    const sourceDirectory = argument('--source-directory');
    if (command === 'sign-bundle') {
      if (!rpmIdentity) throw new Error('sign-bundle requires --signed-linux');
      await signLinuxPreviewBundle({ directory: resolve(argument('--input')), outputDirectory: resolve(argument('--output')),
        version, sourceRevision, repository, rpmIdentity, sourceDirectory,
        privateKey, passphrase });
    } else if (command === 'prepare') {
      if (rpmIdentity) throw new Error('Use sign-bundle for signed previews');
      await prepareLinuxPreview({
        inputDirectory: resolve(argument('--input') || 'desktop-linux-preview-validated'),
        outputDirectory: resolve(argument('--output') || 'desktop-linux-preview-final'),
        version,
        sourceRevision,
        runtimeAppImage: argument('--runtime-app-image'),
        runtimeUiImage: argument('--runtime-ui-image'),
        runtimeAgentImage: argument('--runtime-agent-image'),
        repository,
        workflowRunId: argument('--workflow-run-id'),
      });
    } else if (command === 'stage-draft') {
      const result = await stageLinuxPreviewDraft({
        directory: resolve(argument('--directory') || 'desktop-linux-preview-final'),
        version,
        sourceRevision,
        repository,
        rpmIdentity, sourceDirectory,
        token: process.env.GITHUB_TOKEN,
        apiUrl: process.env.GITHUB_API_URL,
      });
      console.log(JSON.stringify(result));
    } else if (command === 'publish-draft') {
      const evidencePath = argument('--acceptance-evidence');
      if (!evidencePath || (await lstat(evidencePath)).size > 16 * 1024) throw new Error('Missing or oversized installed signed RPM acceptance evidence');
      const acceptanceEvidence = JSON.parse(await readFile(evidencePath, 'utf8'));
      await publishLinuxPreviewDraft({
        acceptanceEvidence, signingRunId: argument('--signing-run-id'),
        version,
        sourceRevision,
        repository,
        rpmIdentity, sourceDirectory,
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
