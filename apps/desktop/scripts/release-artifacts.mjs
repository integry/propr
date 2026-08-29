import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectArtifactArchitecture } from './release-architecture.mjs';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TARGETS = new Map([
  ['linux-x64', ['deb', 'rpm', 'zip']],
  ['linux-arm64', ['deb', 'rpm', 'zip']],
  ['darwin-x64', ['dmg', 'zip']],
  ['darwin-arm64', ['dmg', 'zip']],
  ['win32-x64', ['setup', 'nupkg', 'releases']],
  ['win32-arm64', ['setup', 'nupkg', 'releases']],
]);

const recursiveFiles = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const checksumBytes = value => createHash('sha256').update(value).digest('hex');
const checksum = async path => checksumBytes(await readFile(path));

const artifactKind = (path, platform) => {
  const name = basename(path);
  if (platform === 'win32') {
    if (/Setup\.exe$/i.test(name)) return 'setup';
    if (/-full\.nupkg$/i.test(name)) return 'nupkg';
    if (name === 'RELEASES') return 'releases';
    return undefined;
  }
  const extension = name.split('.').at(-1)?.toLowerCase();
  return ['deb', 'rpm', 'zip', 'dmg'].includes(extension) ? extension : undefined;
};

const releaseFileName = (version, platform, arch, kind) => {
  const platformName = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
  const suffix = kind === 'setup' ? 'Setup.exe' : kind === 'releases' ? 'RELEASES' : kind === 'nupkg' ? 'full.nupkg' : kind;
  return `ProPR-Desktop-${version}-${platformName}-${arch}-${suffix}`;
};

const readNativeSigner = (platform, env) => {
  if (platform === 'linux') return undefined;
  const type = env.PROPR_DESKTOP_ACTUAL_SIGNER_TYPE?.trim();
  const identity = env.PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY?.trim();
  const designatedRequirement = env.PROPR_DESKTOP_ACTUAL_MAC_DESIGNATED_REQUIREMENT?.trim();
  if (!type && !identity && !designatedRequirement) return undefined;
  const expectedType = platform === 'darwin' ? 'apple-team-id' : 'authenticode-subject';
  if (type !== expectedType || !identity || (platform === 'darwin' && !designatedRequirement)) {
    throw new Error(`Native signer evidence is incomplete or invalid for ${platform}`);
  }
  return {
    type,
    identity,
    ...(platform === 'darwin' ? { designatedRequirement } : {}),
  };
};

export const stageArtifacts = async ({
  makeDirectory,
  outputDirectory,
  platform,
  arch,
  version,
  env = process.env,
  inspectArchitecture = inspectArtifactArchitecture,
}) => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid desktop release version: ${version}`);
  const target = `${platform}-${arch}`;
  const expectedKinds = TARGETS.get(target);
  if (!expectedKinds) throw new Error(`Unsupported desktop release target: ${target}`);

  const candidates = await recursiveFiles(makeDirectory);
  const byKind = new Map();
  for (const path of candidates) {
    const kind = artifactKind(path, platform);
    if (!kind || !expectedKinds.includes(kind)) continue;
    if (byKind.has(kind)) throw new Error(`Found multiple ${kind} artifacts for ${target}`);
    byKind.set(kind, path);
  }
  const missing = expectedKinds.filter(kind => !byKind.has(kind));
  if (missing.length) throw new Error(`Missing ${missing.join(', ')} artifact(s) for ${target}`);

  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = [];
  for (const kind of expectedKinds) {
    const fileName = releaseFileName(version, platform, arch, kind);
    const destination = join(outputDirectory, fileName);
    if (kind === 'releases') {
      const originalPackageName = basename(byKind.get('nupkg'));
      const renamedPackageName = releaseFileName(version, platform, arch, 'nupkg');
      const releases = await readFile(byKind.get(kind), 'utf8');
      if (!releases.includes(originalPackageName)) {
        throw new Error(`Windows RELEASES metadata does not reference ${originalPackageName}`);
      }
      await writeFile(destination, releases.replaceAll(originalPackageName, renamedPackageName));
    } else {
      await copyFile(byKind.get(kind), destination);
    }
    const architectureEvidence = await inspectArchitecture({
      path: destination,
      kind,
      platform,
      arch,
    });
    const details = await stat(destination);
    artifacts.push({
      platform,
      arch,
      kind,
      fileName,
      size: details.size,
      sha256: await checksum(destination),
      architectureEvidence,
    });
  }
  const nativeSigner = readNativeSigner(platform, env);
  if (env.PROPR_DESKTOP_REQUIRE_SIGNED_ARTIFACTS === '1' && platform !== 'linux' && !nativeSigner) {
    throw new Error(`Production ${platform} artifacts require verified native signer evidence`);
  }
  const fragment = {
    schemaVersion: 2,
    version,
    tag: `desktop-v${version}`,
    target,
    artifacts,
    nativeSigner,
  };
  await writeFile(join(outputDirectory, 'release-fragment.json'), `${JSON.stringify(fragment, null, 2)}\n`);
  return fragment;
};

const readFragments = async inputDirectory => {
  const paths = (await recursiveFiles(inputDirectory)).filter(path => basename(path) === 'release-fragment.json');
  return Promise.all(paths.map(async path => ({ path, value: JSON.parse(await readFile(path, 'utf8')) })));
};

const parseHttpsUrl = (value, name, { allowQuery = true } = {}) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error(`${name} must be HTTPS and contain no credentials, fragment${allowQuery ? '' : ', or query'}`);
  }
  return url.toString();
};

export const finalizeArtifacts = async ({
  inputDirectory,
  outputDirectory,
  version,
  inspectArchitecture = inspectArtifactArchitecture,
}) => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid desktop release version: ${version}`);
  const fragments = await readFragments(inputDirectory);
  if (fragments.length !== TARGETS.size) {
    throw new Error(`Expected ${TARGETS.size} release fragments, found ${fragments.length}`);
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const seenTargets = new Set();
  const seenNames = new Set();
  const artifacts = [];
  const nativeSigners = {};
  for (const { path, value } of fragments) {
    if (value.schemaVersion !== 2 || value.version !== version || value.tag !== `desktop-v${version}`) {
      throw new Error(`Release fragment metadata does not match desktop-v${version}: ${path}`);
    }
    const expectedKinds = TARGETS.get(value.target);
    if (!expectedKinds || seenTargets.has(value.target)) throw new Error(`Duplicate or invalid target ${value.target}`);
    seenTargets.add(value.target);
    if (!Array.isArray(value.artifacts) || value.artifacts.length !== expectedKinds.length) {
      throw new Error(`Release fragment ${value.target} has an unexpected artifact count`);
    }
    const [targetPlatform, targetArch] = value.target.split('-');
    const expectedSigner = readNativeSigner(targetPlatform, {
      PROPR_DESKTOP_ACTUAL_SIGNER_TYPE: value.nativeSigner?.type,
      PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY: value.nativeSigner?.identity,
      PROPR_DESKTOP_ACTUAL_MAC_DESIGNATED_REQUIREMENT: value.nativeSigner?.designatedRequirement,
    });
    if (expectedSigner) nativeSigners[value.target] = expectedSigner;
    for (const artifact of value.artifacts) {
      const expectedFileName = releaseFileName(version, targetPlatform, targetArch, artifact.kind);
      if (
        !expectedKinds.includes(artifact.kind)
        || artifact.platform !== targetPlatform
        || artifact.arch !== targetArch
        || artifact.fileName !== expectedFileName
        || basename(artifact.fileName) !== artifact.fileName
        || !Number.isSafeInteger(artifact.size)
        || artifact.size <= 0
        || !SHA256_PATTERN.test(artifact.sha256)
        || typeof artifact.architectureEvidence !== 'object'
        || artifact.architectureEvidence === null
        || seenNames.has(artifact.fileName)
      ) {
        throw new Error(`Release fragment ${value.target} has an invalid or duplicate artifact`);
      }
      const source = join(dirname(path), artifact.fileName);
      if (await checksum(source) !== artifact.sha256 || (await stat(source)).size !== artifact.size) {
        throw new Error(`Release artifact integrity does not match its fragment: ${artifact.fileName}`);
      }
      const architectureEvidence = await inspectArchitecture({
        path: source,
        kind: artifact.kind,
        platform: targetPlatform,
        arch: targetArch,
      });
      if (JSON.stringify(architectureEvidence) !== JSON.stringify(artifact.architectureEvidence)) {
        throw new Error(`Release artifact architecture evidence does not match its fragment: ${artifact.fileName}`);
      }
      seenNames.add(artifact.fileName);
      await copyFile(source, join(outputDirectory, artifact.fileName));
      artifacts.push(artifact);
    }
    if (targetPlatform === 'win32') {
      const packageArtifact = value.artifacts.find(artifact => artifact.kind === 'nupkg');
      const releasesArtifact = value.artifacts.find(artifact => artifact.kind === 'releases');
      if (!packageArtifact || !releasesArtifact) throw new Error(`Release fragment ${value.target} lacks Squirrel metadata`);
      const releases = await readFile(join(dirname(path), releasesArtifact.fileName), 'utf8');
      const referencesPackage = releases.split(/\r?\n/).some(line => {
        const match = /^[a-fA-F0-9]{40}\s+(\S+)\s+(\d+)$/.exec(line.trim());
        return match?.[1] === packageArtifact.fileName && Number(match[2]) === packageArtifact.size;
      });
      if (!referencesPackage) throw new Error(`Release fragment ${value.target} has invalid Squirrel RELEASES metadata`);
    }
  }
  for (const target of TARGETS.keys()) {
    if (!seenTargets.has(target)) throw new Error(`Missing release target ${target}`);
  }

  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const publishedAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
    : new Date().toISOString();
  const manifest = {
    schemaVersion: 2,
    channel: 'stable',
    version,
    tag: `desktop-v${version}`,
    publishedAt,
    feeds: {},
    nativeSigners,
    artifacts,
  };
  await writeFile(join(outputDirectory, 'desktop-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(outputDirectory, 'SHA256SUMS'),
    `${artifacts.map(artifact => `${artifact.sha256}  ${artifact.fileName}`).join('\n')}\n`,
  );
  return manifest;
};

const configuredFeedDefinitions = [
  ['darwin-x64', 'PROPR_DESKTOP_DARWIN_X64_FEED_URL'],
  ['darwin-arm64', 'PROPR_DESKTOP_DARWIN_ARM64_FEED_URL'],
  ['win32-x64', 'PROPR_DESKTOP_WINDOWS_X64_FEED_URL'],
  ['win32-arm64', 'PROPR_DESKTOP_WINDOWS_ARM64_FEED_URL'],
];

const exactFeedUrl = (target, configured, name) => {
  const parsed = new URL(parseHttpsUrl(configured, name));
  if (parsed.pathname.endsWith('/')) {
    parsed.pathname += target.startsWith('darwin-') ? 'RELEASES.json' : 'RELEASES';
  } else if (target.startsWith('win32-') && !parsed.pathname.endsWith('/RELEASES')) {
    parsed.pathname += '/RELEASES';
  }
  return parsed.toString();
};

const createSignedFeeds = async (manifest, outputDirectory, env) => {
  const feeds = {};
  const feedFiles = [];
  for (const [target, variable] of configuredFeedDefinitions) {
    const feedUrl = exactFeedUrl(target, env[variable].trim(), variable);
    const updateKind = target.startsWith('darwin-') ? 'zip' : 'nupkg';
    const artifact = manifest.artifacts.find(candidate => `${candidate.platform}-${candidate.arch}` === target && candidate.kind === updateKind);
    const signer = manifest.nativeSigners[target];
    if (!artifact || !signer) throw new Error(`Signed update metadata lacks artifact or native signer evidence for ${target}`);
    const artifactUrl = new URL(artifact.fileName, feedUrl).toString();
    let feedBytes;
    let feedFileName;
    if (target.startsWith('darwin-')) {
      feedBytes = Buffer.from(`${JSON.stringify({
        url: artifactUrl,
        name: manifest.version,
        notes: `ProPR Desktop ${manifest.version}`,
        pub_date: manifest.publishedAt,
      }, null, 2)}\n`);
      feedFileName = `ProPR-Desktop-${manifest.version}-macos-${target.split('-')[1]}-RELEASES.json`;
      await writeFile(join(outputDirectory, feedFileName), feedBytes);
      feedFiles.push({ fileName: feedFileName, size: feedBytes.length, sha256: checksumBytes(feedBytes) });
    } else {
      feedFileName = releaseFileName(manifest.version, 'win32', target.split('-')[1], 'releases');
      feedBytes = await readFile(join(outputDirectory, feedFileName));
      const referenced = feedBytes.toString('utf8').split(/\r?\n/).some(line => {
        const match = /^[a-fA-F0-9]{40}\s+(\S+)\s+(\d+)$/.exec(line.trim());
        return match?.[1] === artifact.fileName && Number(match[2]) === artifact.size;
      });
      if (!referenced) throw new Error(`Windows feed bytes do not reference the exact package for ${target}`);
    }
    feeds[target] = {
      target,
      version: manifest.version,
      feed: { url: feedUrl, size: feedBytes.length, sha256: checksumBytes(feedBytes) },
      artifact: {
        url: artifactUrl,
        fileName: artifact.fileName,
        kind: updateKind,
        size: artifact.size,
        sha256: artifact.sha256,
      },
      signer,
    };
  }
  return { feeds, feedFiles };
};

export const signReleaseMetadata = async ({ inputDirectory, outputDirectory, version, env = process.env }) => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid desktop release version: ${version}`);
  const unsignedManifest = JSON.parse(await readFile(join(inputDirectory, 'desktop-release.json'), 'utf8'));
  if (
    unsignedManifest.schemaVersion !== 2
    || unsignedManifest.version !== version
    || unsignedManifest.tag !== `desktop-v${version}`
    || Object.keys(unsignedManifest.feeds ?? {}).length !== 0
    || !Array.isArray(unsignedManifest.artifacts)
  ) {
    throw new Error('Unsigned release metadata is invalid');
  }
  for (const artifact of unsignedManifest.artifacts) {
    const path = join(inputDirectory, artifact.fileName);
    if (basename(artifact.fileName) !== artifact.fileName
      || await checksum(path) !== artifact.sha256
      || (await stat(path)).size !== artifact.size) {
      throw new Error(`Unsigned release artifact integrity is invalid: ${artifact.fileName}`);
    }
  }

  const configurationNames = [
    'PROPR_DESKTOP_UPDATE_PRIVATE_KEY',
    'PROPR_DESKTOP_UPDATE_PUBLIC_KEY',
    'PROPR_DESKTOP_UPDATE_MANIFEST_URL',
    'PROPR_DESKTOP_MAC_TEAM_ID',
    'PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY',
    ...configuredFeedDefinitions.map(([, name]) => name),
  ];
  const present = configurationNames.filter(name => env[name]?.trim());
  if (present.length !== configurationNames.length) {
    throw new Error(`Trusted update signing configuration is incomplete; missing ${configurationNames.filter(name => !env[name]?.trim()).join(', ')}`);
  }

  for (const target of ['darwin-x64', 'darwin-arm64']) {
    if (unsignedManifest.nativeSigners?.[target]?.type !== 'apple-team-id'
      || unsignedManifest.nativeSigners[target].identity !== env.PROPR_DESKTOP_MAC_TEAM_ID.trim()) {
      throw new Error(`Actual native signer mismatch for ${target}`);
    }
  }
  for (const target of ['win32-x64', 'win32-arm64']) {
    if (unsignedManifest.nativeSigners?.[target]?.type !== 'authenticode-subject'
      || unsignedManifest.nativeSigners[target].identity !== env.PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY.trim()) {
      throw new Error(`Actual native signer mismatch for ${target}`);
    }
  }

  const manifestUrl = parseHttpsUrl(
    env.PROPR_DESKTOP_UPDATE_MANIFEST_URL.trim(),
    'PROPR_DESKTOP_UPDATE_MANIFEST_URL',
    { allowQuery: false },
  );
  const privateKey = createPrivateKey({
    key: Buffer.from(env.PROPR_DESKTOP_UPDATE_PRIVATE_KEY.trim(), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing private key must be Ed25519');
  const actualPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  if (actualPublicKey !== env.PROPR_DESKTOP_UPDATE_PUBLIC_KEY.trim()) {
    throw new Error('Update signing private and public keys do not match');
  }

  await rm(outputDirectory, { recursive: true, force: true });
  await cp(inputDirectory, outputDirectory, { recursive: true });
  const { feeds, feedFiles } = await createSignedFeeds(unsignedManifest, outputDirectory, env);
  const signedManifest = { ...unsignedManifest, manifestUrl, feeds };
  const manifestPayload = Buffer.from(`${JSON.stringify(signedManifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, 'desktop-release.json'), manifestPayload);
  await writeFile(
    join(outputDirectory, 'desktop-release.json.sig'),
    `${sign(null, manifestPayload, privateKey).toString('base64')}\n`,
  );
  await writeFile(
    join(outputDirectory, 'SHA256SUMS'),
    `${[
      ...unsignedManifest.artifacts,
      ...feedFiles,
    ].sort((left, right) => left.fileName.localeCompare(right.fileName))
      .map(file => `${file.sha256}  ${file.fileName}`)
      .join('\n')}\n`,
  );
  return signedManifest;
};

const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2];
  const version = argument('--version');
  if (!version) throw new Error('--version is required');
  if (command === 'stage') {
    await stageArtifacts({
      makeDirectory: resolve(argument('--make-directory') || 'out/make'),
      outputDirectory: resolve(argument('--output') || 'release-staging'),
      platform: argument('--platform') || process.platform,
      arch: argument('--arch') || process.arch,
      version,
    });
  } else if (command === 'finalize') {
    await finalizeArtifacts({
      inputDirectory: resolve(argument('--input') || 'release-artifacts'),
      outputDirectory: resolve(argument('--output') || 'release-final'),
      version,
    });
  } else if (command === 'sign') {
    await signReleaseMetadata({
      inputDirectory: resolve(argument('--input') || 'release-final'),
      outputDirectory: resolve(argument('--output') || 'release-signed'),
      version,
    });
  } else {
    throw new Error('Expected release-artifacts.mjs stage, finalize, or sign command');
  }
}
