import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAnyCpuPe } from './build-windows-authority-helper.mjs';

const EXECUTABLE_NAME = 'propr-windows-authority.exe';
const MANIFEST_NAME = 'propr-windows-authority.manifest.json';
const MANIFEST_KEYS = [
  'schemaVersion', 'name', 'format', 'architecture', 'machine', 'clr', 'size', 'sha256', 'sourceSha256',
  'protocol', 'trust', 'publisher', 'compiler',
];
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;

const fail = () => { throw new Error('Packaged Windows authority helper inspection failed'); };
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const parseManifest = bytes => {
  if (bytes.length <= 1 || bytes.length > MAX_MANIFEST_BYTES || bytes.at(-1) !== 0x0a) fail();
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1))); }
  catch { fail(); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !exactKeys(manifest, MANIFEST_KEYS)
    || !manifest.compiler || typeof manifest.compiler !== 'object' || Array.isArray(manifest.compiler)
    || !exactKeys(manifest.compiler, ['kind', 'framework']) || manifest.schemaVersion !== 1
    || manifest.name !== EXECUTABLE_NAME || manifest.format !== 'PE32' || manifest.architecture !== 'anycpu'
    || manifest.machine !== 'I386' || manifest.clr !== true || !Number.isSafeInteger(manifest.size)
    || manifest.size <= 0 || manifest.size > MAX_HELPER_BYTES || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) || manifest.protocol !== 'propr-windows-authority-v1'
    || !['unsigned-validation', 'production-signed'].includes(manifest.trust)
    || (manifest.trust === 'unsigned-validation' && manifest.publisher !== null)
    || (manifest.trust === 'production-signed' && (typeof manifest.publisher !== 'string' || !manifest.publisher))
    || manifest.compiler.kind !== 'systemroot-dotnet-framework-csc'
    || !/^(?:Framework64|Framework)-v4\.0\.30319$/.test(manifest.compiler.framework)) fail();
  return manifest;
};

const openCanonicalRegular = async (path, expectedName) => {
  const canonical = await realpath(path).catch(fail);
  const expected = resolve(path);
  if (basename(path).toLowerCase() !== expectedName.toLowerCase()
    || (process.platform === 'win32' ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected)) fail();
  const pathStats = await lstat(path, { bigint: true }).catch(fail);
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n) fail();
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(fail);
  const heldStats = await handle.stat({ bigint: true });
  if (heldStats.dev !== pathStats.dev || heldStats.ino !== pathStats.ino || heldStats.size !== pathStats.size
    || heldStats.nlink !== pathStats.nlink) { await handle.close(); fail(); }
  return { handle, stats: heldStats };
};

export const refreshPackagedWindowsAuthorityManifest = async (executablePath, manifestPath, env = process.env) => {
  const executable = await openCanonicalRegular(executablePath, EXECUTABLE_NAME);
  const heldManifest = await openCanonicalRegular(manifestPath, MANIFEST_NAME);
  try {
    const bytes = await executable.handle.readFile();
    inspectAnyCpuPe(bytes);
    const manifest = parseManifest(await heldManifest.handle.readFile());
    const production = env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1';
    const publisher = production ? String(env.PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY || '') : null;
    if (production && !publisher) fail();
    const refreshed = Buffer.from(`${JSON.stringify({
      ...manifest,
      size: bytes.length,
      sha256: digest(bytes),
      trust: production ? 'production-signed' : 'unsigned-validation',
      publisher,
    })}\n`, 'utf8');
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { await handle.writeFile(refreshed); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, manifestPath);
  } finally {
    await executable.handle.close();
    await heldManifest.handle.close();
  }
};

export const inspectPackagedWindowsAuthority = async (executablePath, manifestPath) => {
  if (dirname(executablePath) !== dirname(manifestPath)) fail();
  const executable = await openCanonicalRegular(executablePath, EXECUTABLE_NAME);
  const heldManifest = await openCanonicalRegular(manifestPath, MANIFEST_NAME);
  try {
    const manifest = parseManifest(await heldManifest.handle.readFile());
    const bytes = await executable.handle.readFile();
    inspectAnyCpuPe(bytes);
    if (bytes.length !== manifest.size || digest(bytes) !== manifest.sha256) fail();
    const after = await executable.handle.stat({ bigint: true });
    const manifestAfter = await heldManifest.handle.stat({ bigint: true });
    if (after.dev !== executable.stats.dev || after.ino !== executable.stats.ino || after.size !== executable.stats.size
      || manifestAfter.dev !== heldManifest.stats.dev || manifestAfter.ino !== heldManifest.stats.ino
      || manifestAfter.size !== heldManifest.stats.size) fail();
    return manifest;
  } finally {
    await executable.handle.close();
    await heldManifest.handle.close();
  }
};

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const refresh = process.argv[2] === '--refresh';
  const [executablePath, manifestPath] = refresh ? process.argv.slice(3) : process.argv.slice(2);
  if (!executablePath || !manifestPath || (refresh ? process.argv.length !== 5 : process.argv.length !== 4)) fail();
  await (refresh
    ? refreshPackagedWindowsAuthorityManifest(executablePath, manifestPath)
    : inspectPackagedWindowsAuthority(executablePath, manifestPath));
  process.stdout.write(`Packaged Windows authority helper ${refresh ? 'manifest refreshed' : 'verified'}\n`);
}
