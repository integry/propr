import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAnyCpuPe } from './build-windows-authority-helper.mjs';
import { inspectWindowsNativeLauncherPe } from './build-windows-native-launcher.mjs';

const EXECUTABLE_NAME = 'propr-windows-authority.exe';
const MANIFEST_NAME = 'propr-windows-authority.manifest.json';
const LAUNCHER_NAME = 'propr-windows-launcher.node';
const BOOTSTRAP_NAME = 'propr-windows-bootstrap.node';
const MANIFEST_KEYS = [
  'schemaVersion', 'name', 'format', 'architecture', 'machine', 'clr', 'size', 'sha256', 'sourceSha256',
  'protocol', 'trust', 'publisher', 'compiler',
  'signerPins', 'signerCertificateSha256', 'signerSpkiSha256',
  'bootstrap', 'launcher',
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
    || !manifest.launcher || typeof manifest.launcher !== 'object' || Array.isArray(manifest.launcher)
    || !manifest.bootstrap || typeof manifest.bootstrap !== 'object' || Array.isArray(manifest.bootstrap)
    || !exactKeys(manifest.compiler, ['kind', 'framework', 'signerCertificateSha256', 'signerSpkiSha256',
      'signerRootSpkiSha256', 'volumeSerial', 'fileId128', 'inputs']) || manifest.schemaVersion !== 1
    || !exactKeys(manifest.launcher, ['name', 'format', 'architecture', 'machine', 'size', 'sha256', 'trust',
      'publisher', 'signerPins', 'signerCertificateSha256', 'signerSpkiSha256'])
    || !exactKeys(manifest.bootstrap, ['name', 'format', 'architecture', 'machine', 'size', 'sha256', 'trust',
      'publisher', 'signerPins', 'signerCertificateSha256', 'signerSpkiSha256'])
    || manifest.name !== EXECUTABLE_NAME || manifest.format !== 'PE32' || manifest.architecture !== 'anycpu'
    || manifest.machine !== 'I386' || manifest.clr !== true || !Number.isSafeInteger(manifest.size)
    || manifest.size <= 0 || manifest.size > MAX_HELPER_BYTES || !/^[a-f0-9]{64}$/.test(manifest.sha256)
    || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256) || manifest.protocol !== 'propr-windows-authority-v1'
    || !['unsigned-validation', 'production-signed'].includes(manifest.trust)
    || (manifest.trust === 'unsigned-validation' && manifest.publisher !== null)
    || (manifest.trust === 'production-signed' && (typeof manifest.publisher !== 'string' || !manifest.publisher))
    || !Array.isArray(manifest.signerPins) || manifest.signerPins.length > 16
    || manifest.signerPins.some(pin => typeof pin !== 'string'
      || !/^(?:certificate|spki)-sha256:[a-f0-9]{64}$/.test(pin))
    || new Set(manifest.signerPins).size !== manifest.signerPins.length
    || manifest.signerPins.join(',') !== [...manifest.signerPins].sort().join(',')
    || (manifest.trust === 'unsigned-validation'
      && (manifest.signerPins.length !== 0 || manifest.signerCertificateSha256 !== null
        || manifest.signerSpkiSha256 !== null))
    || (manifest.trust === 'production-signed'
      && (manifest.signerPins.length === 0
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerCertificateSha256))
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerSpkiSha256))
        || !manifest.signerPins.some(pin => pin === `certificate-sha256:${manifest.signerCertificateSha256}`
          || pin === `spki-sha256:${manifest.signerSpkiSha256}`)))
    || manifest.launcher.name !== LAUNCHER_NAME || manifest.launcher.format !== 'PE'
    || !['x64', 'arm64'].includes(manifest.launcher.architecture)
    || (manifest.launcher.architecture === 'x64' ? manifest.launcher.machine !== 'AMD64'
      : manifest.launcher.machine !== 'ARM64')
    || !Number.isSafeInteger(manifest.launcher.size) || manifest.launcher.size <= 0
    || manifest.launcher.size > MAX_HELPER_BYTES || !/^[a-f0-9]{64}$/.test(manifest.launcher.sha256)
    || manifest.launcher.trust !== manifest.trust || manifest.launcher.publisher !== manifest.publisher
    || JSON.stringify(manifest.launcher.signerPins) !== JSON.stringify(manifest.signerPins)
    || manifest.launcher.signerCertificateSha256 !== manifest.signerCertificateSha256
    || manifest.launcher.signerSpkiSha256 !== manifest.signerSpkiSha256
    || manifest.bootstrap.name !== BOOTSTRAP_NAME || manifest.bootstrap.format !== 'PE'
    || manifest.bootstrap.architecture !== manifest.launcher.architecture
    || manifest.bootstrap.machine !== manifest.launcher.machine
    || !Number.isSafeInteger(manifest.bootstrap.size) || manifest.bootstrap.size <= 0
    || manifest.bootstrap.size > MAX_HELPER_BYTES || !/^[a-f0-9]{64}$/.test(manifest.bootstrap.sha256)
    || manifest.bootstrap.trust !== manifest.trust || manifest.bootstrap.publisher !== manifest.publisher
    || JSON.stringify(manifest.bootstrap.signerPins) !== JSON.stringify(manifest.signerPins)
    || manifest.bootstrap.signerCertificateSha256 !== manifest.signerCertificateSha256
    || manifest.bootstrap.signerSpkiSha256 !== manifest.signerSpkiSha256
    || manifest.compiler.kind !== 'windows-catalog-authorized-dotnet-framework-csc-v1'
    || !/^(?:Framework64|Framework)-v4\.0\.30319$/.test(manifest.compiler.framework)
    || !/^[a-f0-9]{64}$/.test(manifest.compiler.signerCertificateSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.compiler.signerSpkiSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.compiler.signerRootSpkiSha256)
    || !/^[a-f0-9]{16}$/.test(manifest.compiler.volumeSerial)
    || !/^[a-f0-9]{32}$/.test(manifest.compiler.fileId128)
    || !Array.isArray(manifest.compiler.inputs) || manifest.compiler.inputs.length !== 3
    || manifest.compiler.inputs.map(input => input?.name).join(',') !== 'csc.exe,System.dll,System.Web.Extensions.dll'
    || manifest.compiler.inputs.some(input => !input || typeof input !== 'object' || Array.isArray(input)
      || !exactKeys(input, ['name', 'size', 'sha256', 'signerCertificateSha256', 'signerSpkiSha256',
        'signerRootSpkiSha256', 'catalogName', 'catalogSha256', 'catalogVolumeSerial', 'catalogFileId128'])
      || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 32 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(input.sha256)
      || !/^[a-f0-9]{64}$/.test(input.signerCertificateSha256)
      || !/^[a-f0-9]{64}$/.test(input.signerSpkiSha256)
      || !/^[a-f0-9]{64}$/.test(input.signerRootSpkiSha256)
      || input.signerCertificateSha256 !== '1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de'
      || input.signerSpkiSha256 !== 'a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1'
      || !((manifest.launcher.architecture === 'x64'
          && input.catalogName === 'Package_4_for_KB5066128~31bf3856ad364e35~amd64~~10.0.9321.3.cat'
          && input.catalogSha256 === 'f447c801fde63f353448d90567363190964bb2e716c271256dba5859aaece7ef')
        || (manifest.launcher.architecture === 'arm64'
          && input.catalogName === 'Package_2_for_KB5066128~31bf3856ad364e35~arm64~~10.0.9321.3.cat'
          && input.catalogSha256 === 'fd4c63e1001a82816e4ac3cdc76af05a7a02096a7101b4ddd3963d23ab773b85'))
      || !/^[a-f0-9]{16}$/.test(input.catalogVolumeSerial)
      || !/^[a-f0-9]{32}$/.test(input.catalogFileId128))
    || manifest.compiler.inputs[0].signerCertificateSha256 !== manifest.compiler.signerCertificateSha256
    || manifest.compiler.inputs[0].signerSpkiSha256 !== manifest.compiler.signerSpkiSha256
    || manifest.compiler.inputs[0].signerRootSpkiSha256 !== manifest.compiler.signerRootSpkiSha256) fail();
  return manifest;
};

const openCanonicalRegular = async (trustedRoot, path, expectedName) => {
  const canonicalRoot = await realpath(trustedRoot).catch(fail);
  const canonical = await realpath(path).catch(fail);
  const expected = resolve(path);
  const child = relative(canonicalRoot, canonical);
  if (basename(path).toLowerCase() !== expectedName.toLowerCase()
    || !child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)
    || (process.platform === 'win32'
      ? canonicalRoot.toLowerCase() !== resolve(trustedRoot).toLowerCase()
      : canonicalRoot !== resolve(trustedRoot))
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
  const trustedRoot = dirname(executablePath);
  if (trustedRoot !== dirname(manifestPath)) fail();
  const executable = await openCanonicalRegular(trustedRoot, executablePath, EXECUTABLE_NAME);
  const launcher = await openCanonicalRegular(trustedRoot, resolve(trustedRoot, LAUNCHER_NAME), LAUNCHER_NAME);
  const bootstrap = await openCanonicalRegular(trustedRoot, resolve(trustedRoot, BOOTSTRAP_NAME), BOOTSTRAP_NAME);
  const heldManifest = await openCanonicalRegular(trustedRoot, manifestPath, MANIFEST_NAME);
  try {
    const bytes = await executable.handle.readFile();
    const launcherBytes = await launcher.handle.readFile();
    const bootstrapBytes = await bootstrap.handle.readFile();
    inspectAnyCpuPe(bytes);
    const manifest = parseManifest(await heldManifest.handle.readFile());
    try { inspectWindowsNativeLauncherPe(launcherBytes, manifest.launcher.architecture); } catch { fail(); }
    try { inspectWindowsNativeLauncherPe(bootstrapBytes, manifest.bootstrap.architecture); } catch { fail(); }
    const production = env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1';
    const publisher = production ? String(env.PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY || '') : null;
    const signerPins = production ? String(env.PROPR_DESKTOP_WINDOWS_SIGNER_PINS || '').split(',') : [];
    const signerCertificateSha256 = production
      ? String(env.PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256 || '') : null;
    const signerSpkiSha256 = production ? String(env.PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256 || '') : null;
    if (production && (!publisher || signerPins.length === 0
      || signerPins.some(pin => !/^(?:certificate|spki)-sha256:[a-f0-9]{64}$/.test(pin))
      || new Set(signerPins).size !== signerPins.length
      || signerPins.join(',') !== [...signerPins].sort().join(',')
      || !/^[a-f0-9]{64}$/.test(signerCertificateSha256)
      || !/^[a-f0-9]{64}$/.test(signerSpkiSha256)
      || !signerPins.some(pin => pin === `certificate-sha256:${signerCertificateSha256}`
        || pin === `spki-sha256:${signerSpkiSha256}`))) fail();
    const refreshed = Buffer.from(`${JSON.stringify({
      ...manifest,
      size: bytes.length,
      sha256: digest(bytes),
      trust: production ? 'production-signed' : 'unsigned-validation',
      publisher,
      signerPins,
      signerCertificateSha256,
      signerSpkiSha256,
      launcher: {
        ...manifest.launcher,
        size: launcherBytes.length,
        sha256: digest(launcherBytes),
        trust: production ? 'production-signed' : 'unsigned-validation',
        publisher,
        signerPins,
        signerCertificateSha256,
        signerSpkiSha256,
      },
      bootstrap: {
        ...manifest.bootstrap,
        size: bootstrapBytes.length,
        sha256: digest(bootstrapBytes),
        trust: production ? 'production-signed' : 'unsigned-validation',
        publisher,
        signerPins,
        signerCertificateSha256,
        signerSpkiSha256,
      },
    })}\n`, 'utf8');
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try { await handle.writeFile(refreshed); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, manifestPath);
  } finally {
    await executable.handle.close();
    await launcher.handle.close();
    await bootstrap.handle.close();
    await heldManifest.handle.close();
  }
};

export const inspectPackagedWindowsAuthority = async (executablePath, manifestPath) => {
  if (dirname(executablePath) !== dirname(manifestPath)) fail();
  const trustedRoot = dirname(executablePath);
  const executable = await openCanonicalRegular(trustedRoot, executablePath, EXECUTABLE_NAME);
  const launcher = await openCanonicalRegular(trustedRoot, resolve(trustedRoot, LAUNCHER_NAME), LAUNCHER_NAME);
  const bootstrap = await openCanonicalRegular(trustedRoot, resolve(trustedRoot, BOOTSTRAP_NAME), BOOTSTRAP_NAME);
  const heldManifest = await openCanonicalRegular(trustedRoot, manifestPath, MANIFEST_NAME);
  try {
    const manifest = parseManifest(await heldManifest.handle.readFile());
    const bytes = await executable.handle.readFile();
    const launcherBytes = await launcher.handle.readFile();
    const bootstrapBytes = await bootstrap.handle.readFile();
    inspectAnyCpuPe(bytes);
    try { inspectWindowsNativeLauncherPe(launcherBytes, manifest.launcher.architecture); } catch { fail(); }
    try { inspectWindowsNativeLauncherPe(bootstrapBytes, manifest.bootstrap.architecture); } catch { fail(); }
    if (bytes.length !== manifest.size || digest(bytes) !== manifest.sha256
      || launcherBytes.length !== manifest.launcher.size || digest(launcherBytes) !== manifest.launcher.sha256
      || bootstrapBytes.length !== manifest.bootstrap.size || digest(bootstrapBytes) !== manifest.bootstrap.sha256) fail();
    const after = await executable.handle.stat({ bigint: true });
    const manifestAfter = await heldManifest.handle.stat({ bigint: true });
    const launcherAfter = await launcher.handle.stat({ bigint: true });
    const bootstrapAfter = await bootstrap.handle.stat({ bigint: true });
    if (after.dev !== executable.stats.dev || after.ino !== executable.stats.ino || after.size !== executable.stats.size
      || manifestAfter.dev !== heldManifest.stats.dev || manifestAfter.ino !== heldManifest.stats.ino
      || manifestAfter.size !== heldManifest.stats.size
      || launcherAfter.dev !== launcher.stats.dev || launcherAfter.ino !== launcher.stats.ino
      || launcherAfter.size !== launcher.stats.size
      || bootstrapAfter.dev !== bootstrap.stats.dev || bootstrapAfter.ino !== bootstrap.stats.ino
      || bootstrapAfter.size !== bootstrap.stats.size) fail();
    return manifest;
  } finally {
    await executable.handle.close();
    await launcher.handle.close();
    await bootstrap.handle.close();
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
