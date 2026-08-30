import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = resolve(desktopRoot, '..', '..');
export const WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY = join(desktopRoot, 'src', 'native', 'windows-launcher');
export const WINDOWS_NATIVE_LAUNCHER = join(desktopRoot, 'build', 'windows-authority', 'propr-windows-launcher.node');
export const WINDOWS_NATIVE_BOOTSTRAP = join(desktopRoot, 'build', 'windows-authority', 'propr-windows-bootstrap.node');
export const WINDOWS_NATIVE_BUILD_BOOTSTRAP = join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release',
  'propr_windows_build_bootstrap.node');
export const WINDOWS_NATIVE_AUTHORITY_DIRECTORY = join(desktopRoot, 'build', 'windows-authority');
const MAX_LAUNCHER_BYTES = 4 * 1024 * 1024;
const KERNEL_TAKEOWN = String.raw`\\?\GLOBALROOT\SystemRoot\System32\takeown.exe`;
const KERNEL_ICACLS = String.raw`\\?\GLOBALROOT\SystemRoot\System32\icacls.exe`;
const SYSTEM_SID = '*S-1-5-18';
const ADMINISTRATORS_SID = '*S-1-5-32-544';
const TRUSTED_INSTALLER_SID = '*S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

const fail = (substage = 'OUTPUT_VALIDATION', diagnostics = []) => {
  const error = new Error(`Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`);
  error.stage = 'BUILD_COMPILER';
  error.substage = substage;
  error.code = substage;
  error.diagnostics = Object.freeze([...diagnostics]);
  throw error;
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const BUILD_DIAGNOSTIC_LIMIT = 8;
const diagnosticRecord = (file, line, code) => `${file}:${line}:${code}`;

// node-gyp output contains checkout paths, SDK paths, user profiles and the
// complete inherited build environment. Preserve only a bounded compiler
// location/code tuple rooted at the committed source basename.
export const sanitizeWindowsNativeBuildDiagnostics = output => {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : typeof output === 'string' ? output : '';
  const diagnostics = [];
  const seen = new Set();
  const patterns = [
    /(?:^|[\\/])(propr_windows_launcher\.cc)\((\d+)(?:,\d+)?\)\s*:\s*(?:fatal\s+)?error\s+(C\d{4})\b/gim,
    /(?:^|[\\/])(propr_windows_launcher\.(?:cc|obj))\s*:\s*(?:fatal\s+)?error\s+(LNK\d{4})\b/gim,
    /\b(?:fatal\s+)?error\s+(LNK\d{4})\b/gim,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[3]
        ? diagnosticRecord(match[1], match[2], match[3].toUpperCase())
        : match[2]
          ? diagnosticRecord(match[1], '0', match[2].toUpperCase())
          : diagnosticRecord('link', '0', match[1].toUpperCase());
      if (!seen.has(value)) {
        seen.add(value);
        diagnostics.push(value);
      }
      if (diagnostics.length === BUILD_DIAGNOSTIC_LIMIT) return Object.freeze(diagnostics);
    }
  }
  return Object.freeze(diagnostics);
};

export const classifyWindowsNativeBuildFailure = error => {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') return 'SPAWN';
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error?.name === 'RangeError'
    && /maxBuffer/i.test(String(error?.message ?? ''))) return 'OUTPUT_LIMIT';
  if (error?.killed === true && error?.signal) return 'TIMEOUT';
  const diagnostics = sanitizeWindowsNativeBuildDiagnostics(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`);
  if (diagnostics.some(value => /:LNK\d{4}$/.test(value))) return 'LINK';
  if (diagnostics.some(value => /:C\d{4}$/.test(value))) return 'COMPILE';
  return 'EXIT';
};

const authorityAclTool = async (tool, args) => {
  await execFileAsync(tool, args, {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    env: {},
  }).catch(() => fail('DIRECTORY_PROBE'));
};

const exactAuthorityDirectory = async root => {
  const pathStats = await lstat(root).catch(() => null);
  if (!pathStats) return false;
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink()
    || (await realpath(root).catch(() => fail('DIRECTORY_PROBE'))).toLowerCase() !== resolve(root).toLowerCase()) {
    fail('DIRECTORY_PROBE');
  }
  return true;
};

// Build steps are the only writers. Reopening a previously sealed tree is an
// explicit trusted-build transition, never part of runtime authorization.
export const prepareWindowsAuthorityBuildDirectory = async (root = WINDOWS_NATIVE_AUTHORITY_DIRECTORY) => {
  if (process.platform !== 'win32' || !(await exactAuthorityDirectory(root))) return;
  await authorityAclTool(KERNEL_TAKEOWN, ['/F', root, '/A', '/R', '/SKIPSL']);
  await authorityAclTool(KERNEL_ICACLS, [root, '/inheritance:r', '/T', '/C', '/Q']);
  await authorityAclTool(KERNEL_ICACLS, [root, '/grant:r', `${ADMINISTRATORS_SID}:(OI)(CI)F`,
    `${SYSTEM_SID}:(OI)(CI)F`, '/T', '/C', '/Q']);
};

// Publish an OS-owned, protected, read/execute-only application authority.
// The verifier independently re-reads every effective explicit and inherited
// ACE from held handles; these setup operations are never accepted as proof.
export const sealWindowsAuthorityDirectory = async (root = WINDOWS_NATIVE_AUTHORITY_DIRECTORY) => {
  if (process.platform !== 'win32' || !(await exactAuthorityDirectory(root))) fail('DIRECTORY_PROBE');
  // Reset first so an explicit SID planted during the build cannot survive the
  // transition merely because /grant:r only replaces ACEs for named trustees.
  await authorityAclTool(KERNEL_ICACLS, [root, '/reset', '/T', '/C', '/Q']);
  await authorityAclTool(KERNEL_ICACLS, [root, '/inheritance:r', '/T', '/C', '/Q']);
  await authorityAclTool(KERNEL_ICACLS, [root, '/grant:r', `${SYSTEM_SID}:(OI)(CI)F`,
    `${TRUSTED_INSTALLER_SID}:(OI)(CI)F`, `${ADMINISTRATORS_SID}:(OI)(CI)RX`, '/T', '/C', '/Q']);
  await authorityAclTool(KERNEL_ICACLS, [root, '/setowner', SYSTEM_SID, '/T', '/C', '/Q']);
};

export const inspectWindowsNativeLauncherPe = (bytes, expectedArchitecture) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > MAX_LAUNCHER_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 24 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') fail();
  const machine = bytes.readUInt16LE(pe + 4);
  const expectedMachine = expectedArchitecture === 'arm64' ? 0xaa64 : expectedArchitecture === 'x64' ? 0x8664 : -1;
  if (machine !== expectedMachine) fail();
  return { format: 'PE', architecture: expectedArchitecture, machine: expectedMachine === 0xaa64 ? 'ARM64' : 'AMD64' };
};

const heldBytes = async path => {
  const canonical = await realpath(path).catch(() => fail('OUTPUT_VALIDATION'));
  if ((process.platform === 'win32' ? canonical.toLowerCase() : canonical) !== (process.platform === 'win32'
    ? resolve(path).toLowerCase() : resolve(path))) fail('OUTPUT_VALIDATION');
  const pathStats = await lstat(path, { bigint: true }).catch(() => fail('OUTPUT_VALIDATION'));
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
    || pathStats.size <= 0n || pathStats.size > BigInt(MAX_LAUNCHER_BYTES)) fail('OUTPUT_VALIDATION');
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .catch(() => fail('OUTPUT_VALIDATION'));
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
      || before.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || BigInt(bytes.length) !== before.size) fail('OUTPUT_VALIDATION');
    return bytes;
  } finally { await handle.close(); }
};

let launcherBuild;

const buildWindowsNativeLauncherOnce = async () => {
  if (process.platform !== 'win32') return { skipped: true };
  if (process.arch !== 'x64' && process.arch !== 'arm64') fail('OUTPUT_VALIDATION');
  await prepareWindowsAuthorityBuildDirectory();
  const nodeGyp = join(repositoryRoot, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  try {
    await execFileAsync(process.execPath, [nodeGyp, 'rebuild', '--directory', WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY,
      `--arch=${process.arch}`], { cwd: repositoryRoot, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    const diagnostics = sanitizeWindowsNativeBuildDiagnostics(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`);
    fail(classifyWindowsNativeBuildFailure(error), diagnostics);
  }
  const built = join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release', 'propr_windows_launcher.node');
  const builtBootstrap = join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release', 'propr_windows_bootstrap.node');
  const builtBuildBootstrap = WINDOWS_NATIVE_BUILD_BOOTSTRAP;
  const bytes = await heldBytes(built);
  const bootstrapBytes = await heldBytes(builtBootstrap);
  const buildBootstrapBytes = await heldBytes(builtBuildBootstrap);
  const pe = inspectWindowsNativeLauncherPe(bytes, process.arch);
  const bootstrapPe = inspectWindowsNativeLauncherPe(bootstrapBytes, process.arch);
  const buildBootstrapPe = inspectWindowsNativeLauncherPe(buildBootstrapBytes, process.arch);
  await mkdir(WINDOWS_NATIVE_AUTHORITY_DIRECTORY, { recursive: true });
  await copyFile(built, WINDOWS_NATIVE_LAUNCHER);
  await copyFile(builtBootstrap, WINDOWS_NATIVE_BOOTSTRAP);
  const published = await heldBytes(WINDOWS_NATIVE_LAUNCHER);
  const publishedBootstrap = await heldBytes(WINDOWS_NATIVE_BOOTSTRAP);
  if (!published.equals(bytes) || !publishedBootstrap.equals(bootstrapBytes)) fail('OUTPUT_VALIDATION');
  return {
    skipped: false,
    path: WINDOWS_NATIVE_LAUNCHER,
    name: 'propr-windows-launcher.node',
    size: bytes.length,
    sha256: sha256(bytes),
    bootstrap: {
      path: WINDOWS_NATIVE_BOOTSTRAP,
      name: 'propr-windows-bootstrap.node',
      size: bootstrapBytes.length,
      sha256: sha256(bootstrapBytes),
      ...bootstrapPe,
    },
    // This current-owner build capability is consumed only from node-gyp's
    // private output. It is deliberately never copied to the authority/package
    // directory and is not represented in the runtime manifest.
    buildBootstrap: {
      path: builtBuildBootstrap,
      size: buildBootstrapBytes.length,
      sha256: sha256(buildBootstrapBytes),
      ...buildBootstrapPe,
    },
    ...pe,
  };
};

export const buildWindowsNativeLauncher = async () => {
  if (process.platform !== 'win32') return { skipped: true };
  launcherBuild ??= buildWindowsNativeLauncherOnce().catch(error => {
    launcherBuild = undefined;
    throw error;
  });
  return launcherBuild;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWindowsNativeLauncher();
}
