import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createHeldDmgArtifact,
  inspectArtifactArchitecture,
  NATIVE_DMG_VALIDATOR,
} from './release-architecture.mjs';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_SIGNER_PIN_PATTERN = /^(?:certificate|spki)-sha256:[a-f0-9]{64}$/;
const SHA1_PATTERN = /^[a-fA-F0-9]{40}$/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const TARGETS = new Map([
  ['linux-x64', ['deb', 'rpm', 'zip']],
  ['linux-arm64', ['deb', 'rpm', 'zip']],
  ['darwin-x64', ['dmg', 'zip']],
  ['darwin-arm64', ['dmg', 'zip']],
  ['win32-x64', ['setup', 'nupkg', 'releases']],
  ['win32-arm64', ['setup', 'nupkg', 'releases']],
]);
const DMG_HELPERS = [
  'propr-desktop Helper.app',
  'propr-desktop Helper (GPU).app',
  'propr-desktop Helper (Plugin).app',
  'propr-desktop Helper (Renderer).app',
];

const requireExactKeys = (value, keys, label) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new Error(`${label} has missing or unknown keys`);
  }
};

const expectedDmgLayout = arch => ({
  topLevelApplication: 'propr-desktop.app',
  installLink: { path: 'Applications', type: 'symbolic-link', target: '/Applications' },
  mainExecutable: {
    path: 'propr-desktop.app/Contents/MacOS/propr-desktop',
    format: 'mach-o',
    architectures: [arch],
  },
  helperExecutables: DMG_HELPERS.map(bundle => ({
    bundle,
    path: `propr-desktop.app/Contents/Frameworks/${bundle}/Contents/MacOS/${bundle.slice(0, -'.app'.length)}`,
    format: 'mach-o',
    architectures: [arch],
  })),
});

const validateExecutableLayoutEvidence = (value, expected, label, { helper = false } = {}) => {
  requireExactKeys(value, helper
    ? ['bundle', 'path', 'format', 'architectures']
    : ['path', 'format', 'architectures'], label);
  if ((helper && value.bundle !== expected.bundle)
    || value.path !== expected.path
    || value.format !== 'mach-o'
    || !Array.isArray(value.architectures)
    || value.architectures.length !== 1
    || value.architectures[0] !== expected.architectures[0]) {
    throw new Error(`${label} does not match the canonical native Mach-O layout`);
  }
};

const validateDmgLayoutEvidence = (value, arch, label) => {
  requireExactKeys(value, ['topLevelApplication', 'installLink', 'mainExecutable', 'helperExecutables'], label);
  const expected = expectedDmgLayout(arch);
  if (value.topLevelApplication !== expected.topLevelApplication) {
    throw new Error(`${label} has a noncanonical top-level application`);
  }
  requireExactKeys(value.installLink, ['path', 'type', 'target'], `${label}.installLink`);
  if (value.installLink.path !== expected.installLink.path
    || value.installLink.type !== expected.installLink.type
    || value.installLink.target !== expected.installLink.target) {
    throw new Error(`${label} does not claim the exact native /Applications symbolic link`);
  }
  validateExecutableLayoutEvidence(value.mainExecutable, expected.mainExecutable, `${label}.mainExecutable`);
  if (!Array.isArray(value.helperExecutables) || value.helperExecutables.length !== expected.helperExecutables.length) {
    throw new Error(`${label}.helperExecutables must contain the exact canonical helper set`);
  }
  value.helperExecutables.forEach((helper, index) => {
    validateExecutableLayoutEvidence(helper, expected.helperExecutables[index], `${label}.helperExecutables[${index}]`, { helper: true });
  });
};

const createNativeDmgEvidence = ({ target, version, arch, artifact, nativeValidation }) => {
  requireExactKeys(
    nativeValidation,
    ['schemaVersion', 'tool', 'toolVersion', 'nativePlatform', 'mountMethod', 'layout'],
    'Native DMG validation marker',
  );
  for (const key of ['schemaVersion', 'tool', 'toolVersion', 'nativePlatform', 'mountMethod']) {
    if (nativeValidation[key] !== NATIVE_DMG_VALIDATOR[key]) {
      throw new Error(`Native DMG validation marker has an unsupported ${key}`);
    }
  }
  validateDmgLayoutEvidence(nativeValidation.layout, arch, 'Native DMG validation marker layout');
  return {
    schemaVersion: NATIVE_DMG_VALIDATOR.schemaVersion,
    tool: NATIVE_DMG_VALIDATOR.tool,
    toolVersion: NATIVE_DMG_VALIDATOR.toolVersion,
    nativePlatform: NATIVE_DMG_VALIDATOR.nativePlatform,
    mountMethod: NATIVE_DMG_VALIDATOR.mountMethod,
    validatedNatively: true,
    target,
    version,
    architecture: arch,
    artifact: {
      fileName: artifact.fileName,
      size: artifact.size,
      sha256: artifact.sha256,
    },
    layout: nativeValidation.layout,
  };
};

const validateNativeDmgEvidence = (value, { target, version, arch, artifact }) => {
  const label = `Native DMG evidence for ${target}`;
  requireExactKeys(value, [
    'schemaVersion', 'tool', 'toolVersion', 'nativePlatform', 'mountMethod', 'validatedNatively',
    'target', 'version', 'architecture', 'artifact', 'layout',
  ], label);
  for (const key of ['schemaVersion', 'tool', 'toolVersion', 'nativePlatform', 'mountMethod']) {
    if (value[key] !== NATIVE_DMG_VALIDATOR[key]) throw new Error(`${label} has an unsupported ${key}`);
  }
  if (value.validatedNatively !== true) throw new Error(`${label} lacks the native-validation marker`);
  if (typeof value.target !== 'string' || value.target.length > 32 || value.target !== target
    || typeof value.version !== 'string' || value.version.length > 64 || value.version !== version
    || typeof value.architecture !== 'string' || value.architecture.length > 16 || value.architecture !== arch) {
    throw new Error(`${label} has mixed, stale, or cross-target metadata`);
  }
  requireExactKeys(value.artifact, ['fileName', 'size', 'sha256'], `${label}.artifact`);
  if (typeof value.artifact.fileName !== 'string' || value.artifact.fileName.length > 255
    || value.artifact.fileName !== artifact.fileName
    || !Number.isSafeInteger(value.artifact.size) || value.artifact.size <= 0 || value.artifact.size !== artifact.size
    || typeof value.artifact.sha256 !== 'string' || !SHA256_PATTERN.test(value.artifact.sha256)
    || value.artifact.sha256 !== artifact.sha256) {
    throw new Error(`${label} does not bind the exact canonical DMG bytes`);
  }
  validateDmgLayoutEvidence(value.layout, arch, `${label}.layout`);
};

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
const squirrelChecksumBytes = value => createHash('sha1').update(value).digest('hex');

const dmgFileState = stats => ({
  device: stats.dev,
  inode: stats.ino,
  mode: stats.mode,
  links: stats.nlink,
  size: stats.size,
});

const sameDmgFileState = (left, right) => Object.keys(left).every(key => left[key] === right[key]);

const checksumDmgHandle = async (handle, size) => {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error('Staged DMG changed while its exact bytes were captured');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
};

const captureHeldDmgBytes = async handle => {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) {
    throw new Error('Staged DMG must be a real regular file, not a symbolic link or special file');
  }
  if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Staged DMG size must be a positive safe integer');
  }
  const size = Number(before.size);
  const sha256 = await checksumDmgHandle(handle, size);
  const after = await handle.stat({ bigint: true });
  if (!after.isFile() || !sameDmgFileState(dmgFileState(before), dmgFileState(after))) {
    throw new Error('Staged DMG identity or content changed while its exact bytes were captured');
  }
  return { state: dmgFileState(after), size, sha256 };
};

const assertDmgPathNamesHeldFile = async (path, held) => {
  const pathStats = await lstat(path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()
    || !sameDmgFileState(dmgFileState(pathStats), held.state)) {
    throw new Error('Staged DMG pathname no longer names the held exact artifact');
  }
};

const isCurrentPosixOwner = stats => process.platform !== 'win32'
  && typeof process.getuid === 'function'
  && stats.uid === BigInt(process.getuid());

const isScopedWindowsDmgFixtureAuthority = authority => process.platform === 'win32'
  && authority?.schemaVersion === 1
  && authority?.platform === 'win32'
  && authority?.scope === 'release-test-private-dmg'
  && Object.keys(authority).length === 3;

const lstatPrivateDmgPath = async (path, label) => {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw new Error(`${label} could not be validated`);
  }
};

const privateDmgAuthorityError = code => new Error(`Private DMG authority rejected [dmg-private:${code}]`);

const assertPrivateDmgDirectory = async (path, publicOutputDirectory, fixtureAuthority) => {
  const relationship = relative(resolve(publicOutputDirectory), resolve(path));
  if (relationship === '' || (!isAbsolute(relationship) && relationship !== '..' && !relationship.startsWith(`..${sep}`))) {
    throw new Error('Private DMG snapshot directory must be outside the public output path');
  }
  const stats = await lstatPrivateDmgPath(path, 'Private DMG snapshot directory');
  if (stats.isSymbolicLink()) throw privateDmgAuthorityError('directory-symlink');
  if (!stats.isDirectory()) throw privateDmgAuthorityError('directory-type');
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && !isCurrentPosixOwner(stats)) {
    throw privateDmgAuthorityError('directory-owner');
  }
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && (stats.mode & 0o777n) !== 0o700n) {
    throw privateDmgAuthorityError('directory-mode');
  }
};

const assertPrivateDmgHeldAuthority = async (handle, fixtureAuthority) => {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile()) throw privateDmgAuthorityError('file-type');
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && !isCurrentPosixOwner(stats)) {
    throw privateDmgAuthorityError('file-owner');
  }
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && (stats.mode & 0o777n) !== 0o600n) {
    throw privateDmgAuthorityError('file-mode');
  }
  if (stats.nlink !== 1n) throw privateDmgAuthorityError('file-link');
  return stats;
};

const assertPrivateDmgPathNamesHeldFile = async (path, held, fixtureAuthority) => {
  const pathStats = await lstatPrivateDmgPath(path, 'Private DMG snapshot pathname');
  if (pathStats.isSymbolicLink()) throw privateDmgAuthorityError('file-symlink');
  if (!pathStats.isFile()) throw privateDmgAuthorityError('file-type');
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && !isCurrentPosixOwner(pathStats)) {
    throw privateDmgAuthorityError('file-owner');
  }
  if (!isScopedWindowsDmgFixtureAuthority(fixtureAuthority) && (pathStats.mode & 0o777n) !== 0o600n) {
    throw privateDmgAuthorityError('file-mode');
  }
  if (pathStats.nlink !== 1n) throw privateDmgAuthorityError('file-link');
  if (!sameDmgFileState(dmgFileState(pathStats), held.state)) throw privateDmgAuthorityError('file-identity');
};

const assertStableDmgBytes = (before, after) => {
  if (!sameDmgFileState(before.state, after.state)
    || before.size !== after.size
    || before.sha256 !== after.sha256) {
    throw new Error('Staged DMG identity or content changed during native validation');
  }
};

const assertSameDmgContent = (expected, actual) => {
  if (expected.size !== actual.size || expected.sha256 !== actual.sha256) {
    throw new Error('Copied DMG bytes do not match the held validated artifact');
  }
};

const openHeldDmg = async (path, { privateSnapshot = false, fixtureAuthority } = {}) => {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (privateSnapshot ? 0 : fsConstants.O_NONBLOCK),
    );
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error('Staged DMG must be a real regular file, not a symbolic link or special file');
    }
    throw error;
  }
  try {
    const captured = await captureHeldDmgBytes(handle);
    if (privateSnapshot) {
      await assertPrivateDmgHeldAuthority(handle, fixtureAuthority);
      await assertPrivateDmgPathNamesHeldFile(path, captured, fixtureAuthority);
    }
    else await assertDmgPathNamesHeldFile(path, captured);
    return { handle, captured };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const copyHeldDmgToExclusivePath = async (handle, size, path) => {
  const output = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.length, size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new Error('Held DMG changed while it was copied for publication');
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new Error('Could not copy held DMG for publication');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await output.sync();
  } finally {
    await output.close();
  }
};

const createPrivateDmgSnapshot = async ({ sourcePath, publicOutputDirectory, description, fixtureAuthority }) => {
  const source = await openHeldDmg(sourcePath);
  let privateDirectory;
  let snapshot;
  try {
    privateDirectory = await mkdtemp(join(tmpdir(), 'propr-dmg-snapshot-'));
    await assertPrivateDmgDirectory(privateDirectory, publicOutputDirectory, fixtureAuthority);
    const privatePath = join(privateDirectory, `${randomUUID()}.dmg`);
    await copyHeldDmgToExclusivePath(source.handle, source.captured.size, privatePath);
    const sourceAfterCopy = await captureHeldDmgBytes(source.handle);
    assertStableDmgBytes(source.captured, sourceAfterCopy);
    snapshot = await openHeldDmg(privatePath, { privateSnapshot: true, fixtureAuthority });
    assertSameDmgContent(sourceAfterCopy, snapshot.captured);
    return {
      privateDirectory,
      privatePath,
      held: snapshot,
      heldArtifact: createHeldDmgArtifact(snapshot.handle, description, privatePath),
    };
  } catch (error) {
    if (snapshot) await snapshot.handle.close();
    if (privateDirectory) {
      try {
        await rm(privateDirectory, { recursive: true, force: true });
      } catch {
        throw new Error('Private DMG snapshot cleanup failed');
      }
    }
    if (privateDirectory && error?.message?.includes(privateDirectory)) {
      throw new Error('Private DMG snapshot creation or validation failed');
    }
    throw error;
  } finally {
    await source.handle.close();
  }
};

const closePrivateDmgSnapshot = async snapshot => {
  if (!snapshot) return;
  try {
    await snapshot.held.handle.close();
  } finally {
    try {
      await rm(snapshot.privateDirectory, { recursive: true, force: true });
    } catch {
      throw new Error('Private DMG snapshot cleanup failed');
    }
  }
};

const publishHeldDmg = async ({ handle, captured, destination }) => {
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
  try {
    await copyHeldDmgToExclusivePath(handle, captured.size, temporary);
    const afterCopy = await captureHeldDmgBytes(handle);
    assertStableDmgBytes(captured, afterCopy);
    const copied = await openHeldDmg(temporary);
    let copiedCapture;
    try {
      assertSameDmgContent(afterCopy, copied.captured);
      copiedCapture = copied.captured;
    } finally {
      await copied.handle.close();
    }
    await rename(temporary, destination);
    const published = await openHeldDmg(destination);
    try {
      assertStableDmgBytes(copiedCapture, published.captured);
      assertSameDmgContent(afterCopy, published.captured);
    } finally {
      await published.handle.close();
    }
    return afterCopy;
  } finally {
    await rm(temporary, { force: true });
  }
};

const parseWindowsSignerPins = value => {
  if (!value) throw new Error('PROPR_DESKTOP_WINDOWS_SIGNER_PINS is required');
  const pins = value.split(',');
  if (pins.length > 16 || pins.some(pin => !WINDOWS_SIGNER_PIN_PATTERN.test(pin))
    || new Set(pins).size !== pins.length || pins.join(',') !== [...pins].sort().join(',')) {
    throw new Error('PROPR_DESKTOP_WINDOWS_SIGNER_PINS must be a sorted, unique canonical SHA-256 fingerprint allowlist');
  }
  return pins;
};

const windowsSignerMatchesPins = (signer, pins) => pins.some(pin => (
  pin === `certificate-sha256:${signer.certificateSha256}`
  || pin === `spki-sha256:${signer.spkiSha256}`
));

export const parseSquirrelReleases = bytes => {
  let text;
  try { text = STRICT_UTF8.decode(bytes); } catch { throw new Error('Squirrel RELEASES metadata is not valid UTF-8'); }
  if (!text || text.includes('\0') || /\r(?!\n)/.test(text)) {
    throw new Error('Squirrel RELEASES metadata is empty or has invalid line endings');
  }
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.includes('\r\n') && text.replaceAll('\r\n', '').includes('\n')) {
    throw new Error('Squirrel RELEASES metadata mixes line endings');
  }
  const lines = text.split(lineEnding);
  const trailingNewline = lines.at(-1) === '';
  if (trailingNewline) lines.pop();
  if (lines.length === 0 || lines.some(line => !line)) {
    throw new Error('Squirrel RELEASES metadata must contain only nonempty records');
  }
  const records = lines.map(line => {
    const match = /^([a-fA-F0-9]{40}) ([^\s/\\]+) ((?:0|[1-9]\d*))$/.exec(line);
    if (!match || !SHA1_PATTERN.test(match[1])) throw new Error(`Invalid Squirrel RELEASES record: ${line}`);
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size <= 0 || !/-full\.nupkg$/.test(match[2]) || /-delta\.nupkg$/i.test(match[2])) {
      throw new Error(`Invalid Squirrel RELEASES package record: ${line}`);
    }
    return { sha1: match[1].toLowerCase(), fileName: match[2], size };
  });
  const names = new Set();
  const caseNames = new Set();
  for (const record of records) {
    const caseName = record.fileName.toLocaleLowerCase('en-US');
    if (names.has(record.fileName) || caseNames.has(caseName)) {
      throw new Error(`Squirrel RELEASES contains duplicate or case-colliding package ${record.fileName}`);
    }
    names.add(record.fileName);
    caseNames.add(caseName);
  }
  return { records, lineEnding, trailingNewline };
};

export const validateSquirrelReleases = (releasesBytes, packages) => {
  if (!Array.isArray(packages) || packages.length === 0) throw new Error('Staged Squirrel package set is empty');
  const parsed = parseSquirrelReleases(releasesBytes);
  const expectedNames = new Set(packages.map(pkg => pkg.fileName));
  if (expectedNames.size !== packages.length || parsed.records.length !== packages.length) {
    throw new Error('Squirrel RELEASES record set does not exactly match the staged full NUPKG set');
  }
  for (const pkg of packages) {
    if (basename(pkg.fileName) !== pkg.fileName || !/-full\.nupkg$/.test(pkg.fileName) || !Buffer.isBuffer(pkg.bytes)) {
      throw new Error(`Invalid staged Squirrel package ${pkg.fileName}`);
    }
    const matches = parsed.records.filter(record => record.fileName === pkg.fileName);
    if (matches.length !== 1) {
      throw new Error(`Squirrel RELEASES does not contain exactly staged package ${pkg.fileName}`);
    }
    const record = matches[0];
    if (record.size !== pkg.bytes.length) throw new Error(`Squirrel RELEASES size mismatch for ${pkg.fileName}`);
    if (record.sha1 !== squirrelChecksumBytes(pkg.bytes)) throw new Error(`Squirrel RELEASES SHA-1 mismatch for ${pkg.fileName}`);
  }
  if (parsed.records.some(record => !expectedNames.has(record.fileName))) {
    throw new Error('Squirrel RELEASES references a foreign or unstaged package');
  }
  return parsed;
};

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
  const certificateSha256 = env.PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256?.trim();
  const spkiSha256 = env.PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256?.trim();
  if (!type && !identity && !designatedRequirement && !certificateSha256 && !spkiSha256) return undefined;
  const expectedType = platform === 'darwin' ? 'apple-team-id' : 'authenticode-subject';
  if (type !== expectedType || !identity
    || (platform === 'darwin' && (!designatedRequirement || certificateSha256 || spkiSha256))
    || (platform === 'win32' && (designatedRequirement
      || !SHA256_PATTERN.test(certificateSha256 ?? '')
      || !SHA256_PATTERN.test(spkiSha256 ?? '')))) {
    throw new Error(`Native signer evidence is incomplete or invalid for ${platform}`);
  }
  return {
    type,
    identity,
    ...(platform === 'darwin'
      ? { designatedRequirement }
      : { certificateSha256, spkiSha256 }),
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
  privateDmgFixtureAuthority,
}) => {
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid desktop release version: ${version}`);
  const target = `${platform}-${arch}`;
  const expectedKinds = TARGETS.get(target);
  if (!expectedKinds) throw new Error(`Unsupported desktop release target: ${target}`);
  if (platform === 'darwin' && process.platform === 'win32'
    && (inspectArchitecture === inspectArtifactArchitecture
      || !isScopedWindowsDmgFixtureAuthority(privateDmgFixtureAuthority))) {
    throw new Error('Windows-hosted DMG fixtures require an explicit scoped fixture authority and injected inspector');
  }

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
    if (kind === 'dmg') {
      let snapshot;
      try {
        snapshot = await createPrivateDmgSnapshot({
          sourcePath: byKind.get(kind),
          publicOutputDirectory: outputDirectory,
          description: fileName,
          fixtureAuthority: privateDmgFixtureAuthority,
        });
        const inspection = await inspectArchitecture({ heldArtifact: snapshot.heldArtifact, kind, platform, arch });
        // Authority reasons intentionally precede byte/identity stability after
        // any native validation hook. The same descriptor remains authoritative.
        await assertPrivateDmgHeldAuthority(snapshot.held.handle, privateDmgFixtureAuthority);
        await assertPrivateDmgPathNamesHeldFile(
          snapshot.privatePath,
          snapshot.held.captured,
          privateDmgFixtureAuthority,
        );
        const afterInspection = await captureHeldDmgBytes(snapshot.held.handle);
        assertStableDmgBytes(snapshot.held.captured, afterInspection);
        await assertPrivateDmgPathNamesHeldFile(snapshot.privatePath, afterInspection, privateDmgFixtureAuthority);
        const details = await publishHeldDmg({
          handle: snapshot.held.handle,
          captured: afterInspection,
          destination,
        });
        const artifact = {
          platform,
          arch,
          kind,
          fileName,
          size: details.size,
          sha256: details.sha256,
          architectureEvidence: { format: inspection.format, executable: inspection.executable },
        };
        artifact.nativeDmgValidationEvidence = createNativeDmgEvidence({
          target,
          version,
          arch,
          artifact,
          nativeValidation: inspection.nativeValidation,
        });
        artifacts.push(artifact);
      } finally {
        await closePrivateDmgSnapshot(snapshot);
      }
      continue;
    }
    if (kind === 'releases') {
      const originalPackageName = basename(byKind.get('nupkg'));
      const renamedPackageName = releaseFileName(version, platform, arch, 'nupkg');
      const packageBytes = await readFile(byKind.get('nupkg'));
      const releasesBytes = await readFile(byKind.get(kind));
      const parsed = validateSquirrelReleases(releasesBytes, [{ fileName: originalPackageName, bytes: packageBytes }]);
      const rendered = parsed.records
        .map(record => `${record.sha1} ${record.fileName === originalPackageName ? renamedPackageName : record.fileName} ${record.size}`)
        .join(parsed.lineEnding) + (parsed.trailingNewline ? parsed.lineEnding : '');
      const renderedBytes = Buffer.from(rendered);
      validateSquirrelReleases(renderedBytes, [{ fileName: renamedPackageName, bytes: packageBytes }]);
      await writeFile(destination, renderedBytes);
    } else {
      await copyFile(byKind.get(kind), destination);
    }
    const inspection = await inspectArchitecture({
      path: destination,
      kind,
      platform,
      arch,
    });
    const details = await stat(destination);
    const artifact = {
      platform,
      arch,
      kind,
      fileName,
      size: details.size,
      sha256: await checksum(destination),
      architectureEvidence: inspection,
    };
    artifacts.push(artifact);
  }
  const nativeSigner = readNativeSigner(platform, env);
  if (env.PROPR_DESKTOP_REQUIRE_SIGNED_ARTIFACTS === '1' && platform !== 'linux' && !nativeSigner) {
    throw new Error(`Production ${platform} artifacts require verified native signer evidence`);
  }
  if (env.PROPR_DESKTOP_REQUIRE_SIGNED_ARTIFACTS === '1' && platform === 'win32') {
    const pins = parseWindowsSignerPins(env.PROPR_DESKTOP_WINDOWS_SIGNER_PINS);
    if (!windowsSignerMatchesPins(nativeSigner, pins)) {
      throw new Error('Production Windows signer fingerprint is not in the configured allowlist');
    }
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

export const probePrivateDmgSnapshotIsolation = async ({ makeDirectory, arch, version, env = process.env }) => {
  if (process.platform !== 'darwin') {
    throw new Error('Private-snapshot DMG isolation probe is available only on native macOS');
  }
  const dmgPaths = (await recursiveFiles(makeDirectory)).filter(path => artifactKind(path, 'darwin') === 'dmg');
  if (dmgPaths.length !== 1) throw new Error('Private-snapshot DMG isolation probe requires exactly one source DMG');
  const sourcePath = dmgPaths[0];
  const expected = await openHeldDmg(sourcePath);
  const expectedSize = expected.captured.size;
  const expectedSha256 = expected.captured.sha256;
  await expected.handle.close();
  const outputDirectory = await mkdtemp(join(tmpdir(), 'propr-dmg-isolation-output-'));
  const destination = join(outputDirectory, releaseFileName(version, 'darwin', arch, 'dmg'));
  const displaced = `${sourcePath}.private-snapshot-isolation-held`;
  let sourceDisplaced = false;
  try {
    const fragment = await stageArtifacts({
      makeDirectory,
      outputDirectory,
      platform: 'darwin',
      arch,
      version,
      env,
      inspectArchitecture: arguments_ => inspectArtifactArchitecture({
        ...arguments_,
        ...(arguments_.kind === 'dmg' ? {
          onDmgMounted: async () => {
            await rename(sourcePath, displaced);
            sourceDisplaced = true;
            await writeFile(sourcePath, 'hostile replacement of the original pathname');
            await writeFile(destination, 'hostile replacement of the public pathname');
          },
        } : {}),
      }),
    });
    const artifact = fragment.artifacts.find(candidate => candidate.kind === 'dmg');
    if (!artifact
      || artifact.size !== expectedSize
      || artifact.sha256 !== expectedSha256
      || artifact.nativeDmgValidationEvidence?.artifact?.sha256 !== expectedSha256
      || await checksum(destination) !== expectedSha256) {
      throw new Error('Private-snapshot isolation probe did not keep mounted, evidenced, and published DMG bytes bound to held A');
    }
    return { size: expectedSize, sha256: expectedSha256 };
  } finally {
    if (sourceDisplaced) {
      await rm(sourcePath, { force: true });
      await rename(displaced, sourcePath);
    }
    await rm(outputDirectory, { recursive: true, force: true });
  }
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
      PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256: value.nativeSigner?.certificateSha256,
      PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256: value.nativeSigner?.spkiSha256,
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
      if (artifact.kind === 'dmg') {
        validateNativeDmgEvidence(artifact.nativeDmgValidationEvidence, {
          target: value.target,
          version,
          arch: targetArch,
          artifact,
        });
      } else if (artifact.nativeDmgValidationEvidence !== undefined) {
        throw new Error(`Release fragment ${value.target} attaches native DMG evidence to a non-DMG artifact`);
      }
      const source = join(dirname(path), artifact.fileName);
      let inspection;
      if (artifact.kind === 'dmg') {
        const held = await openHeldDmg(source);
        try {
          if (held.captured.sha256 !== artifact.sha256 || held.captured.size !== artifact.size) {
            throw new Error(`Release artifact integrity does not match its fragment: ${artifact.fileName}`);
          }
          inspection = await inspectArchitecture({
            heldArtifact: createHeldDmgArtifact(held.handle, artifact.fileName),
            kind: artifact.kind,
            platform: targetPlatform,
            arch: targetArch,
          });
          const afterInspection = await captureHeldDmgBytes(held.handle);
          assertStableDmgBytes(held.captured, afterInspection);
          await assertDmgPathNamesHeldFile(source, afterInspection);
          await publishHeldDmg({
            handle: held.handle,
            captured: afterInspection,
            destination: join(outputDirectory, artifact.fileName),
          });
        } finally {
          await held.handle.close();
        }
      } else {
        if (await checksum(source) !== artifact.sha256 || (await stat(source)).size !== artifact.size) {
          throw new Error(`Release artifact integrity does not match its fragment: ${artifact.fileName}`);
        }
        inspection = await inspectArchitecture({
          path: source,
          kind: artifact.kind,
          platform: targetPlatform,
          arch: targetArch,
        });
      }
      const architectureEvidence = artifact.kind === 'dmg'
        ? { format: inspection.format, executable: inspection.executable }
        : inspection;
      if (JSON.stringify(architectureEvidence) !== JSON.stringify(artifact.architectureEvidence)) {
        throw new Error(`Release artifact architecture evidence does not match its fragment: ${artifact.fileName}`);
      }
      seenNames.add(artifact.fileName);
      if (artifact.kind !== 'dmg') await copyFile(source, join(outputDirectory, artifact.fileName));
      artifacts.push(artifact);
    }
    if (targetPlatform === 'win32') {
      const packageArtifact = value.artifacts.find(artifact => artifact.kind === 'nupkg');
      const releasesArtifact = value.artifacts.find(artifact => artifact.kind === 'releases');
      if (!packageArtifact || !releasesArtifact) throw new Error(`Release fragment ${value.target} lacks Squirrel metadata`);
      const packageBytes = await readFile(join(dirname(path), packageArtifact.fileName));
      const releasesBytes = await readFile(join(dirname(path), releasesArtifact.fileName));
      try {
        validateSquirrelReleases(releasesBytes, [{ fileName: packageArtifact.fileName, bytes: packageBytes }]);
      } catch (error) {
        throw new Error(`Release fragment ${value.target} has invalid Squirrel RELEASES metadata: ${error.message}`);
      }
    }
  }
  for (const target of TARGETS.keys()) {
    if (!seenTargets.has(target)) throw new Error(`Missing release target ${target}`);
  }
  const windowsSigners = ['win32-x64', 'win32-arm64'].map(target => nativeSigners[target]).filter(Boolean);
  if (windowsSigners.length === 2 && JSON.stringify(windowsSigners[0]) !== JSON.stringify(windowsSigners[1])) {
    throw new Error('Windows release targets contain mixed native signer evidence');
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
      const packageBytes = await readFile(join(outputDirectory, artifact.fileName));
      try {
        validateSquirrelReleases(feedBytes, [{ fileName: artifact.fileName, bytes: packageBytes }]);
      } catch (error) {
        throw new Error(`Windows feed bytes do not reference only the exact package for ${target}: ${error.message}`);
      }
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
    'PROPR_DESKTOP_WINDOWS_SIGNER_PINS',
    ...configuredFeedDefinitions.map(([, name]) => name),
  ];
  const present = configurationNames.filter(name => env[name]?.trim());
  if (present.length !== configurationNames.length) {
    throw new Error(`Trusted update signing configuration is incomplete; missing ${configurationNames.filter(name => !env[name]?.trim()).join(', ')}`);
  }
  const windowsSignerPins = parseWindowsSignerPins(env.PROPR_DESKTOP_WINDOWS_SIGNER_PINS);

  for (const target of ['darwin-x64', 'darwin-arm64']) {
    const signer = readNativeSigner('darwin', {
      PROPR_DESKTOP_ACTUAL_SIGNER_TYPE: unsignedManifest.nativeSigners?.[target]?.type,
      PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY: unsignedManifest.nativeSigners?.[target]?.identity,
      PROPR_DESKTOP_ACTUAL_MAC_DESIGNATED_REQUIREMENT: unsignedManifest.nativeSigners?.[target]?.designatedRequirement,
      PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256: unsignedManifest.nativeSigners?.[target]?.certificateSha256,
      PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256: unsignedManifest.nativeSigners?.[target]?.spkiSha256,
    });
    if (!signer || signer.identity !== env.PROPR_DESKTOP_MAC_TEAM_ID.trim()) {
      throw new Error(`Actual native signer mismatch for ${target}`);
    }
  }
  const windowsSigners = [];
  for (const target of ['win32-x64', 'win32-arm64']) {
    const signer = readNativeSigner('win32', {
      PROPR_DESKTOP_ACTUAL_SIGNER_TYPE: unsignedManifest.nativeSigners?.[target]?.type,
      PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY: unsignedManifest.nativeSigners?.[target]?.identity,
      PROPR_DESKTOP_ACTUAL_MAC_DESIGNATED_REQUIREMENT: unsignedManifest.nativeSigners?.[target]?.designatedRequirement,
      PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256: unsignedManifest.nativeSigners?.[target]?.certificateSha256,
      PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256: unsignedManifest.nativeSigners?.[target]?.spkiSha256,
    });
    if (!signer || signer.identity !== env.PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY.trim()
      || !windowsSignerMatchesPins(signer, windowsSignerPins)) {
      throw new Error(`Actual native signer mismatch for ${target}`);
    }
    windowsSigners.push(signer);
  }
  if (JSON.stringify(windowsSigners[0]) !== JSON.stringify(windowsSigners[1])) {
    throw new Error('Windows release targets contain mixed native signer evidence');
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
  const signaturePayload = Buffer.from(`${sign(null, manifestPayload, privateKey).toString('base64')}\n`);
  await writeFile(join(outputDirectory, 'desktop-release.json'), manifestPayload);
  await writeFile(join(outputDirectory, 'desktop-release.json.sig'), signaturePayload);
  await writeFile(
    join(outputDirectory, 'SHA256SUMS'),
    `${[
      ...unsignedManifest.artifacts,
      ...feedFiles,
      { fileName: 'desktop-release.json', size: manifestPayload.length, sha256: checksumBytes(manifestPayload) },
      { fileName: 'desktop-release.json.sig', size: signaturePayload.length, sha256: checksumBytes(signaturePayload) },
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
  if (command === 'probe-dmg-private-snapshot-isolation') {
    const makeDirectory = argument('--make-directory');
    const arch = argument('--arch');
    const version = argument('--version');
    if (!makeDirectory || !arch || !version) {
      throw new Error('Private-snapshot DMG isolation probe requires --make-directory, --arch, and --version');
    }
    const result = await probePrivateDmgSnapshotIsolation({
      makeDirectory: resolve(makeDirectory),
      arch,
      version,
    });
    console.log(JSON.stringify({ privateSnapshotDmgIsolation: true, architecture: arch, ...result }));
  } else if (command === 'stage') {
    const version = argument('--version');
    if (!version) throw new Error('--version is required');
    await stageArtifacts({
      makeDirectory: resolve(argument('--make-directory') || 'out/make'),
      outputDirectory: resolve(argument('--output') || 'release-staging'),
      platform: argument('--platform') || process.platform,
      arch: argument('--arch') || process.arch,
      version,
    });
  } else if (command === 'finalize') {
    const version = argument('--version');
    if (!version) throw new Error('--version is required');
    await finalizeArtifacts({
      inputDirectory: resolve(argument('--input') || 'release-artifacts'),
      outputDirectory: resolve(argument('--output') || 'release-final'),
      version,
    });
  } else if (command === 'sign') {
    const version = argument('--version');
    if (!version) throw new Error('--version is required');
    await signReleaseMetadata({
      inputDirectory: resolve(argument('--input') || 'release-final'),
      outputDirectory: resolve(argument('--output') || 'release-signed'),
      version,
    });
  } else {
    throw new Error('Expected release-artifacts.mjs private-snapshot probe, stage, finalize, or sign command');
  }
}
