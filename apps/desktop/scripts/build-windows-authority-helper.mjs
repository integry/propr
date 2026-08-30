import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
export const WINDOWS_AUTHORITY_SOURCE = join(desktopRoot, 'src', 'native', 'propr-windows-authority.cs');
export const WINDOWS_AUTHORITY_BUILD_DIRECTORY = join(desktopRoot, 'build', 'windows-authority');
export const WINDOWS_AUTHORITY_EXECUTABLE = join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, 'propr-windows-authority.exe');
export const WINDOWS_AUTHORITY_MANIFEST = join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, 'propr-windows-authority.manifest.json');
export const WINDOWS_AUTHORITY_BUILD_STAGES = Object.freeze(['BUILD_COMPILER', 'BUILD_SOURCE', 'BUILD_OUTPUT']);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const fail = stage => {
  const error = new Error(`Windows authority helper build failed [win-authority:${stage}]`);
  error.stage = stage;
  throw error;
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

export const validateWindowsAuthoritySource = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_SOURCE_BYTES
    || Buffer.from(bytes.toString('utf8'), 'utf8').compare(bytes) !== 0
    || !bytes.toString('utf8').includes('public static int Main(string[] args)')) fail('BUILD_SOURCE');
  return sha256(bytes);
};

const validateTree = async (root, target, stage) => {
  const canonicalRoot = await realpath(root).catch(() => fail(stage));
  const canonicalTarget = await realpath(target).catch(() => fail(stage));
  if (!samePath(resolve(root), canonicalRoot) || !samePath(resolve(target), canonicalTarget)) fail(stage);
  const inside = relative(canonicalRoot, canonicalTarget);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail(stage);
  let cursor = canonicalRoot;
  for (const component of inside.split(sep)) {
    cursor = join(cursor, component);
    const entry = await lstat(cursor).catch(() => fail(stage));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && cursor !== canonicalTarget)) fail(stage);
  }
  const targetStats = await stat(canonicalTarget).catch(() => fail(stage));
  if (!targetStats.isFile() || targetStats.size <= 0) fail(stage);
  return canonicalTarget;
};

const readHeldBuildOutput = async (root, target) => {
  const canonical = await validateTree(root, target, 'BUILD_OUTPUT');
  const pathStats = await lstat(canonical, { bigint: true }).catch(() => fail('BUILD_OUTPUT'));
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
    || pathStats.size <= 0n || pathStats.size > BigInt(MAX_OUTPUT_BYTES)) fail('BUILD_OUTPUT');
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => fail('BUILD_OUTPUT'));
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
      || before.nlink !== pathStats.nlink) fail('BUILD_OUTPUT');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.nlink !== before.nlink || BigInt(bytes.length) !== before.size) fail('BUILD_OUTPUT');
    return bytes;
  } finally { await handle.close(); }
};

const compilerLayout = async env => {
  const systemRoot = env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) fail('BUILD_COMPILER');
  const canonicalRoot = await realpath(systemRoot).catch(() => fail('BUILD_COMPILER'));
  const layouts = ['Framework64', 'Framework'];
  for (const layout of layouts) {
    const framework = join(canonicalRoot, 'Microsoft.NET', layout, 'v4.0.30319');
    const compiler = join(framework, 'csc.exe');
    const systemReference = join(framework, 'System.dll');
    const webReference = join(framework, 'System.Web.Extensions.dll');
    try {
      await access(compiler, fsConstants.X_OK);
      await access(systemReference, fsConstants.R_OK);
      await access(webReference, fsConstants.R_OK);
      return {
        compiler: await validateTree(canonicalRoot, compiler, 'BUILD_COMPILER'),
        framework,
        systemReference: await validateTree(canonicalRoot, systemReference, 'BUILD_COMPILER'),
        webReference: await validateTree(canonicalRoot, webReference, 'BUILD_COMPILER'),
      };
    } catch { /* try the other trusted SystemRoot framework layout */ }
  }
  return fail('BUILD_COMPILER');
};

export const inspectAnyCpuPe = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > MAX_OUTPUT_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) fail('BUILD_OUTPUT');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 248 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('BUILD_OUTPUT');
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  if (machine !== 0x14c || sectionCount <= 0 || sectionCount > 96
    || optionalSize < 224 || bytes.readUInt16LE(optional) !== 0x10b) fail('BUILD_OUTPUT');
  const clrDirectory = optional + 96 + (14 * 8);
  const clrRva = bytes.readUInt32LE(clrDirectory);
  if (clrDirectory + 8 > optional + optionalSize || clrRva === 0 || bytes.readUInt32LE(clrDirectory + 4) < 72) fail('BUILD_OUTPUT');
  const sectionTable = optional + optionalSize;
  let clrOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + (index * 40);
    if (section + 40 > bytes.length) fail('BUILD_OUTPUT');
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawAddress = bytes.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (clrRva >= virtualAddress && clrRva < virtualAddress + span) clrOffset = rawAddress + clrRva - virtualAddress;
  }
  if (clrOffset < 0 || clrOffset + 20 > bytes.length) fail('BUILD_OUTPUT');
  const corFlags = bytes.readUInt32LE(clrOffset + 16);
  if ((corFlags & 0x1) === 0 || (corFlags & (0x2 | 0x10 | 0x20000)) !== 0) fail('BUILD_OUTPUT');
  return { format: 'PE32', architecture: 'anycpu', machine: 'I386', clr: true };
};

const writeAtomic = async (target, bytes) => {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
};

export const buildWindowsAuthorityHelper = async (env = process.env) => {
  if (process.platform !== 'win32') return { skipped: true };
  const { compiler, framework, systemReference, webReference } = await compilerLayout(env);
  const source = await readFile(WINDOWS_AUTHORITY_SOURCE).catch(() => fail('BUILD_SOURCE'));
  const sourceSha256 = validateWindowsAuthoritySource(source);
  await mkdir(WINDOWS_AUTHORITY_BUILD_DIRECTORY, { recursive: true });
  const temporaryOutput = join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, `broker-${process.pid}-${Date.now()}.exe`);
  try {
    const frameworkIdentity = framework.toLowerCase().endsWith(`${sep}framework64${sep}v4.0.30319`.toLowerCase())
      ? 'Framework64-v4.0.30319'
      : 'Framework-v4.0.30319';
    await execFileAsync(compiler, [
      '/nologo', '/noconfig', '/target:exe', '/platform:anycpu', '/optimize+', '/checked+', '/warnaserror+',
      `/out:${temporaryOutput}`, `/reference:${systemReference}`, `/reference:${webReference}`,
      WINDOWS_AUTHORITY_SOURCE,
    ], { cwd: desktopRoot, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024, env: { SystemRoot: env.SystemRoot } })
      .catch(() => fail('BUILD_OUTPUT'));
    const output = await readHeldBuildOutput(WINDOWS_AUTHORITY_BUILD_DIRECTORY, temporaryOutput);
    const pe = inspectAnyCpuPe(output);
    if (output.length <= 0 || output.length > MAX_OUTPUT_BYTES) fail('BUILD_OUTPUT');
    await writeAtomic(WINDOWS_AUTHORITY_EXECUTABLE, output);
    const manifest = {
      schemaVersion: 1,
      name: 'propr-windows-authority.exe',
      format: pe.format,
      architecture: pe.architecture,
      machine: pe.machine,
      clr: pe.clr,
      size: output.length,
      sha256: sha256(output),
      sourceSha256,
      protocol: 'propr-windows-authority-v1',
      trust: 'unsigned-validation',
      publisher: null,
      compiler: {
        kind: 'systemroot-dotnet-framework-csc',
        framework: frameworkIdentity,
      },
    };
    await writeAtomic(WINDOWS_AUTHORITY_MANIFEST, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
    return { skipped: false, executable: WINDOWS_AUTHORITY_EXECUTABLE, manifest: WINDOWS_AUTHORITY_MANIFEST, ...manifest };
  } finally {
    await rm(temporaryOutput, { force: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsAuthorityHelper().then(result => {
    if (!result.skipped) process.stdout.write('Windows authority helper built and verified\n');
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Windows authority helper build failed'}\n`);
    process.exitCode = 1;
  });
}
