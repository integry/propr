import { execFile as execFileCallback, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const heldDmgArtifacts = new WeakMap();
const EXECUTABLE_NAME = 'propr-desktop';
const DMG_INSTALL_LINK = 'Applications';
const DMG_HELPER_BUNDLES = new Set([
  `${EXECUTABLE_NAME} Helper.app`,
  `${EXECUTABLE_NAME} Helper (GPU).app`,
  `${EXECUTABLE_NAME} Helper (Plugin).app`,
  `${EXECUTABLE_NAME} Helper (Renderer).app`,
]);
const DMG_HELPER_EXECUTABLES = new Set([...DMG_HELPER_BUNDLES]
  .map(name => name.slice(0, -'.app'.length).toLocaleLowerCase('en-US')));
export const NATIVE_DMG_VALIDATOR = Object.freeze({
  schemaVersion: 1,
  tool: 'propr-desktop-release-architecture',
  toolVersion: '1.0.0',
  nativePlatform: 'darwin',
  mountMethod: 'hdiutil-attach-readonly',
});

export const createHeldDmgArtifact = (handle, description, privatePath) => {
  if (!handle || !Number.isInteger(handle.fd) || handle.fd < 0) {
    throw new Error('Held DMG artifact requires an open read-only file handle');
  }
  if (privatePath !== undefined && (typeof privatePath !== 'string' || !isAbsolute(privatePath))) {
    throw new Error('Held DMG private pathname must be absolute');
  }
  const capability = Object.freeze({ description });
  heldDmgArtifacts.set(capability, { handle, description, privatePath });
  return capability;
};

const requireHeldDmgArtifact = capability => {
  const held = heldDmgArtifacts.get(capability);
  if (!held || held.handle.fd < 0) {
    throw new Error('DMG inspection requires a live held exact-artifact capability');
  }
  return held;
};

export const readHeldDmgArtifactBytes = async capability => {
  const { handle } = requireHeldDmgArtifact(capability);
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.size < 0n || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Held DMG artifact is not a safe regular file');
  }
  const bytes = Buffer.alloc(Number(stats.size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) throw new Error('Held DMG artifact changed while it was read');
    offset += bytesRead;
  }
  return bytes;
};
const LINUX_APP_DIRECTORY = join('usr', 'lib', EXECUTABLE_NAME);
const LINUX_PAYLOAD = join(LINUX_APP_DIRECTORY, EXECUTABLE_NAME);
const LINUX_LAUNCHER = join('usr', 'bin', EXECUTABLE_NAME);
const LINUX_DOC_DIRECTORY = join('usr', 'share', 'doc', EXECUTABLE_NAME);
const DEB_LINTIAN_OVERRIDE = join('usr', 'share', 'lintian', 'overrides', EXECUTABLE_NAME);
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRY_METADATA_BYTES = 1024 * 1024;
const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_SYMLINK_BYTES = 1024;
const MAX_ZIP_SYMLINKS = 32;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EXPECTED_PACKAGE_ARCHITECTURE = {
  deb: { x64: 'amd64', arm64: 'arm64' },
  rpm: { x64: 'x86_64', arm64: 'aarch64' },
};

const readPrefix = async (path, length = 4096) => {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const architectureForCpuType = cpuType => {
  if (cpuType === 0x01000007) return 'x64';
  if (cpuType === 0x0100000c) return 'arm64';
  return `unknown-${cpuType.toString(16)}`;
};

export const inspectExecutableBytes = bytes => {
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const littleEndian = bytes[5] === 1;
    if (!littleEndian && bytes[5] !== 2) throw new Error('ELF executable has an invalid byte order');
    const machine = littleEndian ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    const architecture = machine === 62 ? 'x64' : machine === 183 ? 'arm64' : `unknown-${machine}`;
    return { format: 'elf', architectures: [architecture] };
  }

  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
      throw new Error('PE executable header is missing or truncated');
    }
    const machine = bytes.readUInt16LE(peOffset + 4);
    const architecture = machine === 0x014c
      ? 'x86'
      : machine === 0x8664
        ? 'x64'
        : machine === 0xaa64
          ? 'arm64'
          : `unknown-${machine.toString(16)}`;
    return { format: 'pe', architectures: [architecture] };
  }

  if (bytes.length >= 8) {
    const magic = bytes.readUInt32BE(0);
    const thin = new Map([
      [0xfeedface, false], [0xfeedfacf, false],
      [0xcefaedfe, true], [0xcffaedfe, true],
    ]);
    if (thin.has(magic)) {
      const cpuType = thin.get(magic) ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
      return { format: 'mach-o', architectures: [architectureForCpuType(cpuType)] };
    }
    const fat = new Map([
      [0xcafebabe, { little: false, width: 20 }],
      [0xcafebabf, { little: false, width: 24 }],
      [0xbebafeca, { little: true, width: 20 }],
      [0xbfbafeca, { little: true, width: 24 }],
    ]);
    const fatFormat = fat.get(magic);
    if (fatFormat) {
      const read32 = fatFormat.little ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
      const count = read32.call(bytes, 4);
      if (!Number.isSafeInteger(count) || count < 1 || count > 32 || 8 + count * fatFormat.width > bytes.length) {
        throw new Error('Mach-O universal header is invalid or truncated');
      }
      const architectures = [];
      for (let index = 0; index < count; index += 1) {
        architectures.push(architectureForCpuType(read32.call(bytes, 8 + index * fatFormat.width)));
      }
      return { format: 'mach-o', architectures: [...new Set(architectures)].sort() };
    }
  }
  throw new Error('Packaged executable is not a recognized ELF, PE, or Mach-O binary');
};

const assertExecutableArchitecture = (inspection, platform, arch, artifact) => {
  const expectedFormat = platform === 'linux' ? 'elf' : platform === 'win32' ? 'pe' : 'mach-o';
  if (inspection.format !== expectedFormat || inspection.architectures.length !== 1 || inspection.architectures[0] !== arch) {
    throw new Error(
      `${artifact} executable architecture mismatch: expected ${expectedFormat}/${arch}, found ${inspection.format}/${inspection.architectures.join(',')}`,
    );
  }
};

const assertSupportedSquirrelBootstrap = (inspection, artifact) => {
  const architecture = inspection.architectures[0];
  if (inspection.format !== 'pe' || inspection.architectures.length !== 1
    || !['x86', 'x64', 'arm64'].includes(architecture)) {
    throw new Error(`${artifact} is not a supported x86, x64, or arm64 Squirrel PE bootstrapper`);
  }
};

const pathInside = (root, path) => {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
};

const displayPackagePath = (root, path) => relative(root, path).split(sep).join('/');

const describeFileType = stats => {
  if (stats.isFile()) return 'regular file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symbolic link';
  return 'special file';
};

const readPackageEntry = async (path, description) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Linux package is missing ${description}`);
    throw error;
  }
};

const collectSameNameEntries = async root => {
  const entries = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (entry.name.toLowerCase() === EXECUTABLE_NAME) entries.push({ path, stats });
      if (stats.isDirectory()) await visit(path);
    }
  };
  await visit(root);
  return entries;
};

const resolvePackageSymlink = async (root, start) => {
  const rootPath = resolve(root);
  const startPath = resolve(start);
  if (!pathInside(rootPath, startPath)) throw new Error('Linux package launcher escapes the extraction root');
  let components = relative(rootPath, startPath).split(sep).filter(Boolean);
  const visited = new Set();

  while (components.length > 0) {
    let current = rootPath;
    let followedLink = false;
    for (let index = 0; index < components.length; index += 1) {
      current = join(current, components[index]);
      const stats = await readPackageEntry(current, `launcher target ${displayPackagePath(rootPath, current)}`);
      if (stats.isSymbolicLink()) {
        if (visited.has(current)) throw new Error('Linux package launcher contains a symbolic-link cycle');
        visited.add(current);
        if (visited.size > 64) throw new Error('Linux package launcher has too many symbolic links');
        const target = await readlink(current);
        if (isAbsolute(target)) throw new Error('Linux package launcher uses an absolute symbolic link');
        const resolvedTarget = resolve(dirname(current), target);
        if (!pathInside(rootPath, resolvedTarget)) throw new Error('Linux package launcher escapes the extraction root');
        components = [
          ...relative(rootPath, resolvedTarget).split(sep).filter(Boolean),
          ...components.slice(index + 1),
        ];
        followedLink = true;
        break;
      }
      if (index < components.length - 1 && !stats.isDirectory()) {
        throw new Error(`Linux package launcher traverses non-directory ${displayPackagePath(rootPath, current)}`);
      }
      if (index === components.length - 1) return { path: current, stats };
    }
    if (!followedLink) break;
  }
  throw new Error('Linux package launcher target is invalid');
};

export const inspectLinuxPackageLayout = async ({ root, packageFormat, platform, arch, artifact }) => {
  if (platform !== 'linux') throw new Error(`${artifact} Linux package is only valid for Linux targets`);
  if (!['deb', 'rpm'].includes(packageFormat)) throw new Error(`${artifact} Linux package format is invalid`);
  const rootPath = resolve(root);
  const appDirectory = join(rootPath, LINUX_APP_DIRECTORY);
  const payload = join(rootPath, LINUX_PAYLOAD);
  const launcher = join(rootPath, LINUX_LAUNCHER);

  for (const [path, description] of [
    [join(rootPath, 'usr'), 'usr directory'],
    [join(rootPath, 'usr', 'lib'), 'usr/lib directory'],
    [appDirectory, `${LINUX_APP_DIRECTORY.split(sep).join('/')} directory`],
    [join(rootPath, 'usr', 'bin'), 'usr/bin directory'],
  ]) {
    const stats = await readPackageEntry(path, description);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Linux package ${description} must be a real directory, found ${describeFileType(stats)}`);
    }
  }

  const sameNameEntries = await collectSameNameEntries(rootPath);
  const requiredEntries = new Map([
    [appDirectory, 'directory'],
    [payload, 'regular file'],
    [launcher, 'symbolic link'],
  ]);
  const allowedEntries = new Map([
    ...requiredEntries,
    [join(rootPath, LINUX_DOC_DIRECTORY), 'directory'],
    ...(packageFormat === 'deb' ? [[join(rootPath, DEB_LINTIAN_OVERRIDE), 'regular file']] : []),
  ]);
  const unexpected = sameNameEntries.filter(({ path, stats }) => {
    const expectedType = allowedEntries.get(path);
    return !expectedType || describeFileType(stats) !== expectedType;
  });
  const missing = [...requiredEntries].filter(([path, expectedType]) => (
    !sameNameEntries.some(entry => entry.path === path && describeFileType(entry.stats) === expectedType)
  ));
  if (missing.length > 0 || unexpected.length > 0) {
    const found = sameNameEntries
      .map(({ path, stats }) => `${displayPackagePath(rootPath, path)} (${describeFileType(stats)})`)
      .sort()
      .join(', ') || 'none';
    throw new Error(`Linux package must contain only the canonical payload and launcher layout; found ${found}`);
  }

  const payloadStats = await readPackageEntry(payload, `regular payload ${LINUX_PAYLOAD.split(sep).join('/')}`);
  if (!payloadStats.isFile() || payloadStats.isSymbolicLink()) {
    throw new Error(`Linux package payload must be a regular file, found ${describeFileType(payloadStats)}`);
  }
  const lintianOverride = sameNameEntries.find(entry => entry.path === join(rootPath, DEB_LINTIAN_OVERRIDE));
  if (lintianOverride) {
    const prefix = await readPrefix(lintianOverride.path, 4);
    if (lintianOverride.stats.size > 64 * 1024
      || prefix.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('DEB lintian override must not contain an extra ELF payload');
    }
  }
  const resolvedLauncher = await resolvePackageSymlink(rootPath, launcher);
  if (resolvedLauncher.path !== payload || !resolvedLauncher.stats.isFile()) {
    throw new Error(`Linux package launcher must resolve to ${LINUX_PAYLOAD.split(sep).join('/')}`);
  }
  const inspection = inspectExecutableBytes(await readPrefix(payload));
  assertExecutableArchitecture(inspection, platform, arch, artifact);
  return inspection;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const readExact = async (handle, length, position, label) => {
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await handle.read(bytes, 0, length, position);
  if (bytesRead !== length) throw new Error(`${label} is truncated`);
  return bytes;
};

const validateExtraFields = (bytes, label) => {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw new Error(`${label} contains truncated ZIP extra metadata`);
    const id = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    if (offset + 4 + length > bytes.length) throw new Error(`${label} contains truncated ZIP extra metadata`);
    if (id === 0x0001 || id === 0x9901) throw new Error(`${label} uses unsupported ZIP64 or encrypted metadata`);
    offset += 4 + length;
  }
};

const decodeZipName = (bytes, flags) => {
  let name;
  try {
    if ((flags & 0x0800) !== 0) name = UTF8_DECODER.decode(bytes);
    else {
      if (bytes.some(byte => byte > 0x7f)) throw new Error('legacy non-ASCII ZIP names are unsupported');
      name = bytes.toString('ascii');
    }
  } catch (error) {
    throw new Error(`ZIP entry name cannot be decoded strictly: ${error.message}`);
  }
  if (!name || name.includes('\0') || name.includes('\\') || name.normalize('NFC') !== name
    || name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`ZIP entry has an unsafe name: ${JSON.stringify(name)}`);
  }
  const directory = name.endsWith('/');
  const path = directory ? name.slice(0, -1) : name;
  if (!path || path.startsWith('/') || path.endsWith('/') || posix.normalize(path) !== path
    || path.split('/').some(component => !component || component === '.' || component === '..')) {
    throw new Error(`ZIP entry has a non-normalized relative POSIX path: ${JSON.stringify(name)}`);
  }
  return { name, path, directory };
};

const archiveExecutablePath = (kind, platform, arch) => {
  if (kind === 'nupkg' && platform === 'win32') return `lib/net45/${EXECUTABLE_NAME}.exe`;
  if (kind === 'zip' && platform === 'linux') return `${EXECUTABLE_NAME}-linux-${arch}/${EXECUTABLE_NAME}`;
  if (kind === 'zip' && platform === 'darwin') return `${EXECUTABLE_NAME}.app/Contents/MacOS/${EXECUTABLE_NAME}`;
  throw new Error(`${kind} does not have a canonical executable path for ${platform}-${arch}`);
};

const darwinFrameworkRoot = entryPath => {
  const components = entryPath.split('/');
  if (components.length < 5
    || components[0] !== `${EXECUTABLE_NAME}.app`
    || components[1] !== 'Contents'
    || components[2] !== 'Frameworks'
    || !components[3].endsWith('.framework')
    || components[3] === '.framework'
    || components.slice(4).some(component => component.toLocaleLowerCase('en-US').endsWith('.app'))
    || DMG_HELPER_EXECUTABLES.has(components.at(-1).toLocaleLowerCase('en-US'))) return undefined;
  return components.slice(0, 4).join('/');
};

const decodeZipSymlinkTarget = entry => {
  if (entry.bytes.length === 0 || entry.bytes.length > MAX_ZIP_SYMLINK_BYTES) {
    throw new Error(`ZIP symbolic link ${entry.name} has an empty or oversized payload`);
  }
  let target;
  try {
    target = UTF8_DECODER.decode(entry.bytes);
  } catch (error) {
    throw new Error(`ZIP symbolic link ${entry.name} target cannot be decoded strictly: ${error.message}`);
  }
  if (target.includes('\0') || target.includes('\\') || target.normalize('NFC') !== target
    || target.startsWith('/') || target.startsWith('//') || /^[A-Za-z]:/.test(target)
    || posix.normalize(target) !== target
    || target.split('/').some(component => !component || component === '.' || component === '..')) {
    throw new Error(`ZIP symbolic link ${entry.name} has an unsafe relative target`);
  }
  return target;
};

const decodeDmgSymlinkTarget = (bytes, entryPath) => {
  if (bytes.length === 0 || bytes.length > MAX_ZIP_SYMLINK_BYTES) {
    throw new Error(`DMG framework symbolic link ${entryPath} has an empty or oversized target`);
  }
  let target;
  try {
    target = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`DMG framework symbolic link ${entryPath} target cannot be decoded strictly: ${error.message}`);
  }
  if (target.includes('\0') || target.includes('\\') || target.normalize('NFC') !== target
    || target.startsWith('/') || target.startsWith('//') || /^[A-Za-z]:/.test(target)
    || posix.normalize(target) !== target
    || target.split('/').some(component => !component || component === '.' || component === '..')) {
    throw new Error(`DMG framework symbolic link ${entryPath} has an unsafe relative target`);
  }
  return target;
};

const validateDarwinFrameworkSymlinks = entries => {
  const symlinks = entries.filter(entry => entry.symbolicLink);
  if (symlinks.length > MAX_ZIP_SYMLINKS) throw new Error('ZIP contains too many symbolic links');
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));
  const entryPaths = [...entriesByPath.keys()];
  for (const entry of symlinks) entry.target = decodeZipSymlinkTarget(entry);

  const pathExistsAsDirectory = candidate => entryPaths.some(entryPath => entryPath.startsWith(`${candidate}/`));
  for (const link of symlinks) {
    const frameworkRoot = link.frameworkRoot;
    let components = link.path.split('/');
    const visited = new Set();
    let index = 0;
    while (index < components.length) {
      const candidate = components.slice(0, index + 1).join('/');
      const entry = entriesByPath.get(candidate);
      if (entry?.symbolicLink) {
        if (visited.has(candidate)) throw new Error(`ZIP symbolic link ${link.name} contains a cycle`);
        visited.add(candidate);
        if (visited.size > MAX_ZIP_SYMLINKS) throw new Error(`ZIP symbolic link ${link.name} chain is too long`);
        const resolvedTarget = posix.normalize(posix.join(posix.dirname(candidate), entry.target));
        if (resolvedTarget !== frameworkRoot && !resolvedTarget.startsWith(`${frameworkRoot}/`)) {
          throw new Error(`ZIP symbolic link ${link.name} escapes its canonical framework`);
        }
        components = [...resolvedTarget.split('/'), ...components.slice(index + 1)];
        index = 0;
        continue;
      }
      const hasRemainingComponents = index < components.length - 1;
      if (!entry && !pathExistsAsDirectory(candidate)) {
        throw new Error(`ZIP symbolic link ${link.name} has a missing target ${candidate}`);
      }
      if (hasRemainingComponents && entry && !entry.directory) {
        throw new Error(`ZIP symbolic link ${link.name} traverses non-directory target ${candidate}`);
      }
      index += 1;
    }
    const resolved = components.join('/');
    if (resolved !== frameworkRoot && !resolved.startsWith(`${frameworkRoot}/`)) {
      throw new Error(`ZIP symbolic link ${link.name} escapes its canonical framework`);
    }
  }
};

const validateDmgFrameworkSymlinks = entries => {
  const symlinks = entries.filter(entry => entry.symbolicLink);
  if (symlinks.length > MAX_ZIP_SYMLINKS) throw new Error('DMG contains too many symbolic links');
  const entriesByPath = new Map(entries.map(entry => [entry.path, entry]));

  for (const link of symlinks) {
    const frameworkRoot = link.frameworkRoot;
    let components = link.path.split('/');
    const visited = new Set();
    let index = 0;
    while (index < components.length) {
      const candidate = components.slice(0, index + 1).join('/');
      const entry = entriesByPath.get(candidate);
      if (entry?.symbolicLink) {
        if (visited.has(candidate)) throw new Error(`DMG framework symbolic link ${link.path} contains a cycle`);
        visited.add(candidate);
        if (visited.size > MAX_ZIP_SYMLINKS) throw new Error(`DMG framework symbolic link ${link.path} chain is too long`);
        const resolvedTarget = posix.normalize(posix.join(posix.dirname(candidate), entry.target));
        if (resolvedTarget !== frameworkRoot && !resolvedTarget.startsWith(`${frameworkRoot}/`)) {
          throw new Error(`DMG framework symbolic link ${link.path} escapes its canonical framework`);
        }
        components = [...resolvedTarget.split('/'), ...components.slice(index + 1)];
        index = 0;
        continue;
      }
      if (!entry) throw new Error(`DMG framework symbolic link ${link.path} has a missing target ${candidate}`);
      if (index < components.length - 1 && !entry.directory) {
        throw new Error(`DMG framework symbolic link ${link.path} traverses non-directory target ${candidate}`);
      }
      index += 1;
    }
    const resolved = components.join('/');
    if (resolved !== frameworkRoot && !resolved.startsWith(`${frameworkRoot}/`)) {
      throw new Error(`DMG framework symbolic link ${link.path} escapes its canonical framework`);
    }
  }
};

const readValidatedZipExecutable = async (path, kind, platform, arch) => {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = await readExact(handle, tailLength, size - tailLength, 'ZIP tail');
    const eocdCandidates = [];
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) eocdCandidates.push(offset);
    }
    if (eocdCandidates.length !== 1) throw new Error('ZIP end-of-central-directory record is missing or ambiguous');
    const eocd = eocdCandidates[0];
    if (tail.readUInt16LE(eocd + 20) !== 0) throw new Error('ZIP archive comments create trailing ambiguity');
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw new Error('Multi-disk ZIP archives are unsupported');
    }
    const diskEntries = tail.readUInt16LE(eocd + 8);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    const eocdOffset = size - tailLength + eocd;
    if (diskEntries !== entryCount || entryCount > MAX_ZIP_ENTRIES
      || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralSize > MAX_ZIP_DIRECTORY_BYTES || centralOffset + centralSize !== eocdOffset) {
      throw new Error('ZIP central directory is invalid or oversized');
    }
    const central = await readExact(handle, centralSize, centralOffset, 'ZIP central directory');
    const entries = [];
    for (let offset = 0; offset < central.length;) {
      if (offset + 46 > central.length) throw new Error('ZIP central directory entry is truncated');
      if (central.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid');
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const checksum = central.readUInt32LE(offset + 16);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const disk = central.readUInt16LE(offset + 34);
      const externalAttributes = central.readUInt32LE(offset + 38);
      const localOffset = central.readUInt32LE(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (nextOffset > central.length || nameLength + extraLength + commentLength > MAX_ZIP_ENTRY_METADATA_BYTES) {
        throw new Error('ZIP central directory entry is truncated or has oversized metadata');
      }
      if (disk !== 0 || (flags & ~(0x0800 | 0x0008 | 0x0006)) !== 0 || ![0, 8].includes(method)
        || (method === 0 && (flags & 0x0006) !== 0)
        || compressedSize > MAX_EXECUTABLE_BYTES || uncompressedSize > MAX_EXECUTABLE_BYTES) {
        throw new Error('ZIP entry is encrypted, unsupported, or oversized');
      }
      const nameBytes = central.subarray(offset + 46, offset + 46 + nameLength);
      const decoded = decodeZipName(nameBytes, flags);
      const extra = central.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      validateExtraFields(extra, `ZIP entry ${decoded.name}`);
      const unixType = (externalAttributes >>> 16) & 0xf000;
      const symbolicLink = unixType === 0xa000;
      const frameworkRoot = symbolicLink && kind === 'zip' && platform === 'darwin'
        ? darwinFrameworkRoot(decoded.path)
        : undefined;
      if (symbolicLink && (!frameworkRoot || decoded.directory)) {
        throw new Error(`ZIP entry ${decoded.name} is a symbolic link outside canonical macOS framework internals`);
      }
      if (unixType && unixType !== 0x4000 && unixType !== 0x8000 && !symbolicLink) {
        throw new Error(`ZIP entry ${decoded.name} is a symbolic link or special file`);
      }
      if ((decoded.directory && unixType === 0x8000) || (!decoded.directory && unixType === 0x4000)) {
        throw new Error(`ZIP entry ${decoded.name} has conflicting file and directory metadata`);
      }
      if (symbolicLink && (compressedSize > MAX_ZIP_SYMLINK_BYTES || uncompressedSize > MAX_ZIP_SYMLINK_BYTES)) {
        throw new Error(`ZIP symbolic link ${decoded.name} has an oversized payload`);
      }
      entries.push({
        ...decoded,
        flags,
        method,
        checksum,
        compressedSize,
        uncompressedSize,
        localOffset,
        nameBytes,
        symbolicLink,
        frameworkRoot,
      });
      offset = nextOffset;
    }
    if (entries.length !== entryCount) throw new Error('ZIP central directory entry count is inconsistent');
    const exactNames = new Set();
    const caseNames = new Set();
    const componentCase = new Map();
    for (const entry of entries) {
      if (exactNames.has(entry.path) || caseNames.has(entry.path.toLocaleLowerCase('en-US'))) {
        throw new Error(`ZIP contains duplicate or case-colliding entry ${entry.name}`);
      }
      exactNames.add(entry.path);
      caseNames.add(entry.path.toLocaleLowerCase('en-US'));
      const components = entry.path.split('/');
      for (let length = 1; length <= components.length; length += 1) {
        const prefix = components.slice(0, length).join('/');
        const key = prefix.toLocaleLowerCase('en-US');
        if (componentCase.has(key) && componentCase.get(key) !== prefix) {
          throw new Error(`ZIP contains case-colliding path components at ${entry.name}`);
        }
        componentCase.set(key, prefix);
      }
    }
    for (const entry of entries.filter(candidate => !candidate.directory)) {
      const prefix = `${entry.path.toLocaleLowerCase('en-US')}/`;
      if (entries.some(candidate => candidate.path.toLocaleLowerCase('en-US').startsWith(prefix))) {
        throw new Error(`ZIP contains conflicting file and directory prefix ${entry.path}`);
      }
    }

    const ranges = [];
    let executableBytes;
    const canonicalExecutable = archiveExecutablePath(kind, platform, arch);
    const expectedExecutableName = platform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME;
    const alternateExecutables = entries.filter(entry => !entry.directory
      && basename(entry.path).toLocaleLowerCase('en-US') === expectedExecutableName.toLocaleLowerCase('en-US')
      && entry.path !== canonicalExecutable);
    if (alternateExecutables.length) throw new Error(`ZIP contains an executable outside ${canonicalExecutable}`);
    for (const entry of entries) {
      if (entry.localOffset + 30 > centralOffset) throw new Error(`ZIP local header offset is invalid for ${entry.name}`);
      const local = await readExact(handle, 30, entry.localOffset, `ZIP local header for ${entry.name}`);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP local entry header is invalid for ${entry.name}`);
      const localFlags = local.readUInt16LE(6);
      const localMethod = local.readUInt16LE(8);
      const localChecksum = local.readUInt32LE(14);
      const localCompressedSize = local.readUInt32LE(18);
      const localUncompressedSize = local.readUInt32LE(22);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if (localNameLength + localExtraLength > MAX_ZIP_ENTRY_METADATA_BYTES) {
        throw new Error(`ZIP local entry metadata is oversized for ${entry.name}`);
      }
      const localMetadata = await readExact(
        handle,
        localNameLength + localExtraLength,
        entry.localOffset + 30,
        `ZIP local metadata for ${entry.name}`,
      );
      const localNameBytes = localMetadata.subarray(0, localNameLength);
      const localName = decodeZipName(localNameBytes, localFlags);
      validateExtraFields(localMetadata.subarray(localNameLength), `ZIP local entry ${entry.name}`);
      if (localFlags !== entry.flags || localMethod !== entry.method
        || !localNameBytes.equals(entry.nameBytes) || localName.name !== entry.name) {
        throw new Error(`ZIP central and local entry metadata disagree for ${entry.name}`);
      }
      const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + entry.compressedSize;
      if (dataEnd > centralOffset) throw new Error(`ZIP entry exceeds archive bounds for ${entry.name}`);
      const compressed = await readExact(handle, entry.compressedSize, dataOffset, `ZIP entry data for ${entry.name}`);
      let bytes;
      try {
        bytes = entry.method === 0
          ? compressed
          : inflateRawSync(compressed, { maxOutputLength: MAX_EXECUTABLE_BYTES });
      } catch {
        throw new Error(`ZIP entry compression is invalid for ${entry.name}`);
      }
      if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.checksum) {
        throw new Error(`ZIP entry size or CRC is invalid for ${entry.name}`);
      }
      let recordEnd = dataEnd;
      if ((entry.flags & 0x0008) !== 0) {
        const prefix = await readExact(handle, 4, recordEnd, `ZIP data descriptor for ${entry.name}`);
        const hasSignature = prefix.readUInt32LE(0) === 0x08074b50;
        const descriptor = await readExact(handle, hasSignature ? 16 : 12, recordEnd, `ZIP data descriptor for ${entry.name}`);
        const base = hasSignature ? 4 : 0;
        if (descriptor.readUInt32LE(base) !== entry.checksum
          || descriptor.readUInt32LE(base + 4) !== entry.compressedSize
          || descriptor.readUInt32LE(base + 8) !== entry.uncompressedSize
          || ![0, entry.checksum].includes(localChecksum)
          || ![0, entry.compressedSize].includes(localCompressedSize)
          || ![0, entry.uncompressedSize].includes(localUncompressedSize)) {
          throw new Error(`ZIP central, local, and descriptor sizes or CRC disagree for ${entry.name}`);
        }
        recordEnd += descriptor.length;
      } else if (localChecksum !== entry.checksum || localCompressedSize !== entry.compressedSize
        || localUncompressedSize !== entry.uncompressedSize) {
        throw new Error(`ZIP central and local sizes or CRC disagree for ${entry.name}`);
      }
      ranges.push({ start: entry.localOffset, end: recordEnd, name: entry.name });
      if (entry.symbolicLink) entry.bytes = bytes;
      if (entry.path === canonicalExecutable) executableBytes = bytes;
    }
    ranges.sort((left, right) => left.start - right.start);
    let expectedOffset = 0;
    for (const range of ranges) {
      if (range.start !== expectedOffset || range.end <= range.start || range.end > centralOffset) {
        throw new Error(`ZIP entries overlap or contain unclaimed data near ${range.name}`);
      }
      expectedOffset = range.end;
    }
    if (expectedOffset !== centralOffset) throw new Error('ZIP contains unclaimed data before its central directory');
    validateDarwinFrameworkSymlinks(entries);
    if (!executableBytes) throw new Error(`ZIP is missing canonical executable ${canonicalExecutable}`);
    return executableBytes;
  } finally {
    await handle.close();
  }
};

const runPipeline = (firstCommand, firstArgs, secondCommand, secondArgs, cwd) => new Promise((resolve, reject) => {
  const first = spawn(firstCommand, firstArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const second = spawn(secondCommand, secondArgs, { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  first.stderr.on('data', chunk => { errors += chunk; });
  second.stderr.on('data', chunk => { errors += chunk; });
  first.stdout.pipe(second.stdin);
  let firstCode;
  let secondCode;
  const complete = () => {
    if (firstCode === undefined || secondCode === undefined) return;
    if (firstCode === 0 && secondCode === 0) resolve();
    else reject(new Error(`${firstCommand}/${secondCommand} failed: ${errors.trim()}`));
  };
  first.on('error', reject);
  second.on('error', reject);
  first.on('close', code => { firstCode = code; complete(); });
  second.on('close', code => { secondCode = code; complete(); });
});

const inspectDeb = async (path, platform, arch) => {
  const { stdout } = await execFile('dpkg-deb', ['--field', path, 'Architecture']);
  const packageArchitecture = stdout.trim();
  if (packageArchitecture !== EXPECTED_PACKAGE_ARCHITECTURE.deb[arch]) {
    throw new Error(`DEB architecture mismatch: expected ${EXPECTED_PACKAGE_ARCHITECTURE.deb[arch]}, found ${packageArchitecture}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'propr-deb-'));
  try {
    await execFile('dpkg-deb', ['--extract', path, directory]);
    const executable = await inspectLinuxPackageLayout({ root: directory, packageFormat: 'deb', platform, arch, artifact: path });
    return { format: 'deb', packageArchitecture, executable };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const inspectRpm = async (path, platform, arch) => {
  const { stdout } = await execFile('rpm', ['-qp', '--qf', '%{ARCH}', path]);
  const packageArchitecture = stdout.trim();
  if (packageArchitecture !== EXPECTED_PACKAGE_ARCHITECTURE.rpm[arch]) {
    throw new Error(`RPM architecture mismatch: expected ${EXPECTED_PACKAGE_ARCHITECTURE.rpm[arch]}, found ${packageArchitecture}`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'propr-rpm-'));
  try {
    await runPipeline('rpm2cpio', [path], 'cpio', ['-idm', '--quiet'], directory);
    const executable = await inspectLinuxPackageLayout({ root: directory, packageFormat: 'rpm', platform, arch, artifact: path });
    return { format: 'rpm', packageArchitecture, executable };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const execFileWithHeldDescriptor = (file, arguments_, descriptor) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(file, arguments_, {
    stdio: ['ignore', 'pipe', 'pipe', descriptor],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  const collect = destination => chunk => {
    outputBytes += chunk.length;
    if (outputBytes > 16 * 1024 * 1024) {
      child.kill();
      rejectPromise(new Error(`${file} produced excessive output`));
      return;
    }
    destination.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.once('error', rejectPromise);
  child.once('close', (code, signal) => {
    const standardOutput = Buffer.concat(stdout).toString('utf8');
    const standardError = Buffer.concat(stderr).toString('utf8');
    if (code === 0) {
      resolvePromise({ stdout: standardOutput, stderr: standardError });
      return;
    }
    rejectPromise(new Error(
      `${file} exited with ${signal ? `signal ${signal}` : `code ${code}`}${standardError ? `: ${standardError.trim()}` : ''}`,
    ));
  });
});

const attachPrivateDmg = async (heldArtifact, directory) => {
  const { handle, privatePath } = requireHeldDmgArtifact(heldArtifact);
  if (!privatePath) {
    throw new Error('Native DMG inspection requires an internal private-snapshot pathname capability');
  }
  let heldStats;
  let pathStats;
  try {
    [heldStats, pathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(privatePath, { bigint: true }),
    ]);
  } catch {
    throw new Error('Native DMG inspection could not prove the held private-snapshot pathname capability');
  }
  if (!heldStats.isFile()
    || !pathStats.isFile()
    || pathStats.isSymbolicLink()
    || heldStats.dev !== pathStats.dev
    || heldStats.ino !== pathStats.ino
    || heldStats.mode !== pathStats.mode
    || heldStats.nlink !== 1n
    || pathStats.nlink !== 1n
    || heldStats.size !== pathStats.size
    || (pathStats.mode & 0o777n) !== 0o600n
    || typeof process.getuid !== 'function'
    || pathStats.uid !== BigInt(process.getuid())) {
    throw new Error('Native DMG inspection rejected an invalid private-snapshot pathname capability');
  }
  try {
    await execFile('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', directory, privatePath]);
  } catch {
    // hdiutil includes its source argument in some failures. Keep the internal
    // randomized pathname out of logs while still failing closed.
    throw new Error('Native read-only DMG attach failed for the held private snapshot');
  }
};

const inspectDmg = async (heldArtifact, platform, arch, onDmgMounted) => {
  const { handle, description } = requireHeldDmgArtifact(heldArtifact);
  const directory = await mkdtemp(join(tmpdir(), 'propr-dmg-'));
  let mounted = false;
  try {
    if (process.platform === 'darwin') {
      await attachPrivateDmg(heldArtifact, directory);
      mounted = true;
      if (onDmgMounted) await onDmgMounted();
      const executable = await inspectDmgLayout({ root: directory, platform, arch, artifact: description });
      return {
        format: 'dmg',
        executable,
        nativeValidation: nativeDmgLayoutEvidence(arch),
      };
    } else {
      await execFileWithHeldDescriptor(
        '7z',
        ['x', '-y', '-bso0', '-bsp0', `-o${directory}`, '/dev/fd/3'],
        handle.fd,
      );
      const executable = await inspectExtractedDmgArchitecture({ root: directory, platform, arch, artifact: description });
      return { format: 'dmg', executable };
    }
  } finally {
    if (mounted) await execFile('hdiutil', ['detach', directory]);
    await rm(directory, { recursive: true, force: true });
  }
};

const dmgExecutableLayout = arch => ({
  topLevelApplication: `${EXECUTABLE_NAME}.app`,
  installLink: {
    path: DMG_INSTALL_LINK,
    type: 'symbolic-link',
    target: '/Applications',
  },
  mainExecutable: {
    path: `${EXECUTABLE_NAME}.app/Contents/MacOS/${EXECUTABLE_NAME}`,
    format: 'mach-o',
    architectures: [arch],
  },
  helperExecutables: [...DMG_HELPER_BUNDLES].map(bundle => {
    const executable = bundle.slice(0, -'.app'.length);
    return {
      bundle,
      path: `${EXECUTABLE_NAME}.app/Contents/Frameworks/${bundle}/Contents/MacOS/${executable}`,
      format: 'mach-o',
      architectures: [arch],
    };
  }),
});

const nativeDmgLayoutEvidence = arch => ({
  ...NATIVE_DMG_VALIDATOR,
  layout: dmgExecutableLayout(arch),
});

export const inspectExtractedDmgArchitecture = async ({ root, platform, arch, artifact }) => {
  if (platform !== 'darwin') throw new Error(`${artifact} DMG is only valid for macOS targets`);
  const rootPath = resolve(root);
  const layout = dmgExecutableLayout(arch);
  const executablePaths = [layout.mainExecutable, ...layout.helperExecutables];
  let mainInspection;
  for (const entry of executablePaths) {
    const path = join(rootPath, ...entry.path.split('/'));
    let stats;
    try { stats = await lstat(path); } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`DMG is missing canonical executable ${entry.path}`);
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`DMG canonical executable ${entry.path} must be a real regular file`);
    }
    const inspection = inspectExecutableBytes(await readPrefix(path));
    assertExecutableArchitecture(inspection, platform, arch, artifact);
    if (entry === layout.mainExecutable) mainInspection = inspection;
  }
  return mainInspection;
};

export const inspectDmgLayout = async ({ root, platform, arch, artifact }) => {
  if (platform !== 'darwin') throw new Error(`${artifact} DMG is only valid for macOS targets`);
  const rootPath = resolve(root);
  const application = join(rootPath, `${EXECUTABLE_NAME}.app`);
  const contents = join(application, 'Contents');
  const macos = join(contents, 'MacOS');
  const executable = join(macos, EXECUTABLE_NAME);
  const helperDirectory = join(contents, 'Frameworks');
  const installLink = join(rootPath, DMG_INSTALL_LINK);
  const canonicalPaths = [
    [application, `${EXECUTABLE_NAME}.app`, 'directory'],
    [contents, `${EXECUTABLE_NAME}.app/Contents`, 'directory'],
    [macos, `${EXECUTABLE_NAME}.app/Contents/MacOS`, 'directory'],
    [executable, `${EXECUTABLE_NAME}.app/Contents/MacOS/${EXECUTABLE_NAME}`, 'regular file'],
    [helperDirectory, `${EXECUTABLE_NAME}.app/Contents/Frameworks`, 'directory'],
  ];
  for (const helperBundle of DMG_HELPER_BUNDLES) {
    const helperName = helperBundle.slice(0, -'.app'.length);
    const helper = join(helperDirectory, helperBundle);
    const helperContents = join(helper, 'Contents');
    const helperMacos = join(helperContents, 'MacOS');
    canonicalPaths.push(
      [helper, `${EXECUTABLE_NAME}.app/Contents/Frameworks/${helperBundle}`, 'directory'],
      [helperContents, `${EXECUTABLE_NAME}.app/Contents/Frameworks/${helperBundle}/Contents`, 'directory'],
      [helperMacos, `${EXECUTABLE_NAME}.app/Contents/Frameworks/${helperBundle}/Contents/MacOS`, 'directory'],
      [join(helperMacos, helperName), `${EXECUTABLE_NAME}.app/Contents/Frameworks/${helperBundle}/Contents/MacOS/${helperName}`, 'regular file'],
    );
  }
  for (const [path, description, expectedType] of canonicalPaths) {
    let stats;
    try { stats = await lstat(path); } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`DMG is missing canonical ${description}`);
      throw error;
    }
    if (describeFileType(stats) !== expectedType) {
      throw new Error(`DMG canonical ${description} must be a real ${expectedType}, found ${describeFileType(stats)}`);
    }
  }
  let installLinkStats;
  try { installLinkStats = await lstat(installLink); } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`DMG is missing canonical ${DMG_INSTALL_LINK} install link`);
    throw error;
  }
  if (!installLinkStats.isSymbolicLink() || await readlink(installLink) !== '/Applications') {
    throw new Error(`DMG canonical ${DMG_INSTALL_LINK} install link must be the exact /Applications symbolic link`);
  }

  const topLevel = await readdir(rootPath, { withFileTypes: true });
  const topLevelCaseNames = new Set();
  for (const entry of topLevel) {
    const caseName = entry.name.toLocaleLowerCase('en-US');
    if (topLevelCaseNames.has(caseName)) throw new Error(`DMG has duplicate or case-colliding top-level entry ${entry.name}`);
    topLevelCaseNames.add(caseName);
  }
  const allowedTopLevel = new Set([`${EXECUTABLE_NAME}.app`, DMG_INSTALL_LINK]);
  if (topLevel.length !== allowedTopLevel.size || topLevel.some(entry => !allowedTopLevel.has(entry.name))) {
    throw new Error(`DMG contains an unclaimed or alternate top-level payload; expected only ${[...allowedTopLevel].join(' and ')}`);
  }

  const applications = [];
  const sameNameExecutables = [];
  const applicationEntries = [{
    path: `${EXECUTABLE_NAME}.app`,
    symbolicLink: false,
    directory: true,
  }];
  const casePaths = new Map();
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      const stats = await lstat(entryPath);
      const relativePath = displayPackagePath(rootPath, entryPath);
      const casePath = relativePath.toLocaleLowerCase('en-US');
      if (casePaths.has(casePath) && casePaths.get(casePath) !== relativePath) {
        throw new Error(`DMG contains duplicate or case-colliding application path ${relativePath}`);
      }
      casePaths.set(casePath, relativePath);
      if (entry.name.toLocaleLowerCase('en-US') === EXECUTABLE_NAME) sameNameExecutables.push(entryPath);
      if (stats.isSymbolicLink()) {
        const frameworkRoot = darwinFrameworkRoot(relativePath);
        if (!frameworkRoot) {
          throw new Error(`DMG symbolic link ${relativePath} is outside canonical macOS framework internals`);
        }
        const target = decodeDmgSymlinkTarget(await readlink(entryPath, { encoding: 'buffer' }), relativePath);
        applicationEntries.push({ path: relativePath, symbolicLink: true, directory: false, frameworkRoot, target });
      } else if (stats.isDirectory()) {
        applicationEntries.push({ path: relativePath, symbolicLink: false, directory: true });
        if (entry.name.toLocaleLowerCase('en-US').endsWith('.app')) applications.push(entryPath);
        await visit(entryPath);
      } else if (stats.isFile()) {
        applicationEntries.push({ path: relativePath, symbolicLink: false, directory: false });
      } else if (!stats.isFile()) {
        throw new Error(`DMG contains special file ${relativePath}`);
      }
    }
  };
  await visit(application);
  validateDmgFrameworkSymlinks(applicationEntries);
  const unexpectedApplications = applications.filter(path => (
    dirname(path) !== helperDirectory || !DMG_HELPER_BUNDLES.has(basename(path))
  ));
  if (unexpectedApplications.length > 0) {
    throw new Error(`DMG contains an alternate application bundle outside the canonical Electron helper layout`);
  }
  const helperNames = new Set(applications.map(path => basename(path)));
  if (helperNames.size !== DMG_HELPER_BUNDLES.size
    || [...DMG_HELPER_BUNDLES].some(name => !helperNames.has(name))) {
    throw new Error('DMG canonical application is missing a required Electron helper bundle');
  }
  for (const helperBundle of DMG_HELPER_BUNDLES) {
    const helperName = helperBundle.slice(0, -'.app'.length);
    const helperExecutable = join(helperDirectory, helperBundle, 'Contents', 'MacOS', helperName);
    const helperInspection = inspectExecutableBytes(await readPrefix(helperExecutable));
    assertExecutableArchitecture(helperInspection, platform, arch, artifact);
  }
  if (sameNameExecutables.length !== 1 || sameNameExecutables[0] !== executable) {
    throw new Error(`DMG contains a missing or alternate same-name executable outside the canonical application bundle path`);
  }
  const inspection = inspectExecutableBytes(await readPrefix(executable));
  assertExecutableArchitecture(inspection, platform, arch, artifact);
  return inspection;
};

export const inspectArtifactArchitecture = async ({ path, heldArtifact, kind, platform, arch, onDmgMounted }) => {
  if (kind === 'releases') return { format: 'squirrel-releases', target: `${platform}-${arch}` };
  if (kind === 'deb') return inspectDeb(path, platform, arch);
  if (kind === 'rpm') return inspectRpm(path, platform, arch);
  if (kind === 'dmg') {
    if (path !== undefined) throw new Error('DMG inspection rejects mutable pathnames; pass a held exact-artifact capability');
    if (onDmgMounted !== undefined && typeof onDmgMounted !== 'function') {
      throw new Error('DMG mounted callback must be a function');
    }
    return inspectDmg(heldArtifact, platform, arch, onDmgMounted);
  }
  if (kind === 'setup') {
    const executable = inspectExecutableBytes(await readPrefix(path));
    if (platform !== 'win32') throw new Error(`${path} Squirrel bootstrapper is only valid for Windows targets`);
    assertSupportedSquirrelBootstrap(executable, path);
    return { format: 'squirrel-setup', executable };
  }
  if (kind === 'zip' || kind === 'nupkg') {
    const executable = inspectExecutableBytes(await readValidatedZipExecutable(path, kind, platform, arch));
    assertExecutableArchitecture(executable, platform, arch, path);
    return { format: kind, executable };
  }
  throw new Error(`Unsupported release artifact format: ${kind}`);
};

const argument = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === 'inspect') {
    const path = argument('--path');
    const kind = argument('--kind');
    const platform = argument('--platform');
    const arch = argument('--arch');
    if (!path || !kind || !platform || !arch) throw new Error('Archive inspection requires --path, --kind, --platform, and --arch');
    if (kind === 'dmg') throw new Error('Use release-artifacts staging for private-snapshot DMG inspection');
    console.log(JSON.stringify(await inspectArtifactArchitecture({ path: resolve(path), kind, platform, arch })));
  } else {
    throw new Error('Expected release-architecture.mjs inspect command');
  }
}
