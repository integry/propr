import { execFile as execFileCallback, spawn } from 'node:child_process';
import { open, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const EXECUTABLE_NAME = 'propr-desktop';
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
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
    const architecture = machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `unknown-${machine.toString(16)}`;
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

const findPackagedExecutable = async (root, platform) => {
  const expected = platform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME;
  const candidates = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && basename(path).toLowerCase() === expected.toLowerCase()) candidates.push(path);
    }
  };
  await visit(root);
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one packaged ${expected} executable, found ${candidates.length}`);
  }
  return candidates[0];
};

const inspectExtractedExecutable = async (root, platform, arch, artifact) => {
  const executable = await findPackagedExecutable(root, platform);
  const inspection = inspectExecutableBytes(await readPrefix(executable));
  assertExecutableArchitecture(inspection, platform, arch, artifact);
  return inspection;
};

const readZipExecutable = async (path, platform) => {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('ZIP end-of-central-directory record is missing');
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralSize > MAX_ZIP_DIRECTORY_BYTES || centralOffset + centralSize > size) {
      throw new Error('ZIP central directory is invalid or oversized');
    }
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);
    const expected = platform === 'win32' ? `${EXECUTABLE_NAME}.exe` : EXECUTABLE_NAME;
    const matches = [];
    for (let offset = 0; offset < central.length;) {
      if (offset + 46 > central.length) throw new Error('ZIP central directory entry is truncated');
      if (central.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid');
      const compression = central.readUInt16LE(offset + 10);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localOffset = central.readUInt32LE(offset + 42);
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (nextOffset > central.length) throw new Error('ZIP central directory entry is truncated');
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
      if (basename(name).toLowerCase() === expected.toLowerCase()) {
        matches.push({ compression, compressedSize, uncompressedSize, localOffset, name });
      }
      offset = nextOffset;
    }
    if (matches.length !== 1) throw new Error(`Expected exactly one packaged ${expected} executable in ZIP, found ${matches.length}`);
    const entry = matches[0];
    if (entry.compressedSize > MAX_EXECUTABLE_BYTES || entry.uncompressedSize > MAX_EXECUTABLE_BYTES
      || entry.localOffset + 30 > size) {
      throw new Error('Packaged executable ZIP entry is invalid or oversized');
    }
    const local = Buffer.alloc(30);
    await handle.read(local, 0, local.length, entry.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local entry header is invalid');
    const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataOffset + entry.compressedSize > size) throw new Error('Packaged executable ZIP entry exceeds archive bounds');
    const compressed = Buffer.alloc(entry.compressedSize);
    await handle.read(compressed, 0, compressed.length, dataOffset);
    const bytes = entry.compression === 0 ? compressed : entry.compression === 8 ? inflateRawSync(compressed) : undefined;
    if (!bytes || bytes.length !== entry.uncompressedSize) throw new Error(`Unsupported or invalid ZIP compression for ${entry.name}`);
    return bytes;
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
    const executable = await inspectExtractedExecutable(directory, platform, arch, path);
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
    const executable = await inspectExtractedExecutable(directory, platform, arch, path);
    return { format: 'rpm', packageArchitecture, executable };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const inspectDmg = async (path, platform, arch) => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-dmg-'));
  let mounted = false;
  try {
    if (process.platform === 'darwin') {
      await execFile('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', directory, path]);
      mounted = true;
    } else {
      await execFile('7z', ['x', '-y', '-bso0', '-bsp0', `-o${directory}`, path]);
    }
    const executable = await inspectExtractedExecutable(directory, platform, arch, path);
    return { format: 'dmg', executable };
  } finally {
    if (mounted) await execFile('hdiutil', ['detach', directory]);
    await rm(directory, { recursive: true, force: true });
  }
};

export const inspectArtifactArchitecture = async ({ path, kind, platform, arch }) => {
  if (kind === 'releases') return { format: 'squirrel-releases', target: `${platform}-${arch}` };
  if (kind === 'deb') return inspectDeb(path, platform, arch);
  if (kind === 'rpm') return inspectRpm(path, platform, arch);
  if (kind === 'dmg') return inspectDmg(path, platform, arch);
  if (kind === 'setup') {
    const executable = inspectExecutableBytes(await readPrefix(path));
    assertExecutableArchitecture(executable, platform, arch, path);
    return { format: 'squirrel-setup', executable };
  }
  if (kind === 'zip' || kind === 'nupkg') {
    const executable = inspectExecutableBytes(await readZipExecutable(path, platform));
    assertExecutableArchitecture(executable, platform, arch, path);
    return { format: kind, executable };
  }
  throw new Error(`Unsupported release artifact format: ${kind}`);
};
