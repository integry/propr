import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

const checksum = async path => createHash('sha256').update(await readFile(path)).digest('hex');

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

export const stageArtifacts = async ({ makeDirectory, outputDirectory, platform, arch, version }) => {
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
    const details = await stat(destination);
    artifacts.push({
      platform,
      arch,
      kind,
      fileName,
      size: details.size,
      sha256: await checksum(destination),
    });
  }
  const fragment = { schemaVersion: 1, version, tag: `desktop-v${version}`, target, artifacts };
  await writeFile(join(outputDirectory, 'release-fragment.json'), `${JSON.stringify(fragment, null, 2)}\n`);
  return fragment;
};

const readFragments = async inputDirectory => {
  const paths = (await recursiveFiles(inputDirectory)).filter(path => basename(path) === 'release-fragment.json');
  return Promise.all(paths.map(async path => ({ path, value: JSON.parse(await readFile(path, 'utf8')) })));
};

const parseHttpsUrl = (value, name) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be HTTPS and contain no credentials or fragment`);
  }
  return url.toString();
};

const createFeeds = env => {
  const definitions = [
    ['darwin-x64', 'PROPR_DESKTOP_DARWIN_X64_FEED_URL', 'PROPR_DESKTOP_UPDATE_MAC_SIGNING_IDENTITY'],
    ['darwin-arm64', 'PROPR_DESKTOP_DARWIN_ARM64_FEED_URL', 'PROPR_DESKTOP_UPDATE_MAC_SIGNING_IDENTITY'],
    ['win32-x64', 'PROPR_DESKTOP_WINDOWS_X64_FEED_URL', 'PROPR_DESKTOP_UPDATE_WINDOWS_SIGNING_IDENTITY'],
    ['win32-arm64', 'PROPR_DESKTOP_WINDOWS_ARM64_FEED_URL', 'PROPR_DESKTOP_UPDATE_WINDOWS_SIGNING_IDENTITY'],
  ];
  const configured = definitions.filter(([, urlName]) => env[urlName]?.trim());
  if (configured.length === 0) return {};
  if (configured.length !== definitions.length) throw new Error('Update feed configuration is incomplete');
  return Object.fromEntries(definitions.map(([target, urlName, identityName]) => {
    const identity = env[identityName]?.trim();
    if (!identity) throw new Error(`Update feed configuration requires ${identityName}`);
    return [target, { url: parseHttpsUrl(env[urlName].trim(), urlName), signingIdentity: identity }];
  }));
};

export const finalizeArtifacts = async ({ inputDirectory, outputDirectory, version, env = process.env }) => {
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
  for (const { path, value } of fragments) {
    if (value.schemaVersion !== 1 || value.version !== version || value.tag !== `desktop-v${version}`) {
      throw new Error(`Release fragment metadata does not match desktop-v${version}: ${path}`);
    }
    const expectedKinds = TARGETS.get(value.target);
    if (!expectedKinds || seenTargets.has(value.target)) throw new Error(`Duplicate or invalid target ${value.target}`);
    seenTargets.add(value.target);
    if (!Array.isArray(value.artifacts) || value.artifacts.length !== expectedKinds.length) {
      throw new Error(`Release fragment ${value.target} has an unexpected artifact count`);
    }
    const [targetPlatform, targetArch] = value.target.split('-');
    for (const artifact of value.artifacts) {
      const expectedFileName = releaseFileName(version, targetPlatform, targetArch, artifact.kind);
      if (
        !expectedKinds.includes(artifact.kind)
        || artifact.platform !== targetPlatform
        || artifact.arch !== targetArch
        || artifact.fileName !== expectedFileName
        || basename(artifact.fileName) !== artifact.fileName
        || seenNames.has(artifact.fileName)
      ) {
        throw new Error(`Release fragment ${value.target} has an invalid or duplicate artifact`);
      }
      const source = join(dirname(path), artifact.fileName);
      if (await checksum(source) !== artifact.sha256 || (await stat(source)).size !== artifact.size) {
        throw new Error(`Release artifact integrity does not match its fragment: ${artifact.fileName}`);
      }
      seenNames.add(artifact.fileName);
      await copyFile(source, join(outputDirectory, artifact.fileName));
      artifacts.push(artifact);
    }
  }
  for (const target of TARGETS.keys()) {
    if (!seenTargets.has(target)) throw new Error(`Missing release target ${target}`);
  }

  artifacts.sort((left, right) => left.fileName.localeCompare(right.fileName));
  const feeds = createFeeds(env);
  const publishedAt = env.SOURCE_DATE_EPOCH
    ? new Date(Number(env.SOURCE_DATE_EPOCH) * 1_000).toISOString()
    : new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    tag: `desktop-v${version}`,
    publishedAt,
    feeds,
    artifacts,
  };
  const manifestPayload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, 'desktop-release.json'), manifestPayload);
  await writeFile(
    join(outputDirectory, 'SHA256SUMS'),
    `${artifacts.map(artifact => `${artifact.sha256}  ${artifact.fileName}`).join('\n')}\n`,
  );

  const privateKeyBase64 = env.PROPR_DESKTOP_UPDATE_PRIVATE_KEY?.trim();
  if (privateKeyBase64) {
    const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing private key must be Ed25519');
    const expectedPublicKey = env.PROPR_DESKTOP_UPDATE_PUBLIC_KEY?.trim();
    if (!expectedPublicKey) throw new Error('Signing a release manifest requires PROPR_DESKTOP_UPDATE_PUBLIC_KEY');
    const actualPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    if (actualPublicKey !== expectedPublicKey) throw new Error('Update signing private and public keys do not match');
    if (Object.keys(feeds).length !== 4) throw new Error('Signed release manifest requires all native update feeds');
    await writeFile(join(outputDirectory, 'desktop-release.json.sig'), `${sign(null, manifestPayload, privateKey).toString('base64')}\n`);
  } else if (
    env.PROPR_DESKTOP_REQUIRE_UPDATE_SIGNATURE === '1'
    || (env.PROPR_DESKTOP_PUBLISH_RELEASE === 'true'
      && (env.PROPR_DESKTOP_UPDATE_PUBLIC_KEY?.trim() || Object.keys(feeds).length > 0))
  ) {
    throw new Error('Trusted update publishing requires PROPR_DESKTOP_UPDATE_PRIVATE_KEY');
  }
  return manifest;
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
  } else {
    throw new Error('Expected release-artifacts.mjs stage or finalize command');
  }
}
