// Native RPM signatures are separate from desktop update metadata and DEB trust.
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
// Owner replacement key effective 2026-10-19; the previous key is historical, not cross-signed.
export const OWNER_FINGERPRINT = '80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599';
const fingerprintPattern = /^[A-F0-9]{40}$/;

export function requireRpmIdentity(identity) {
  if (!identity || !fingerprintPattern.test(identity.fingerprint)
    || typeof identity.publicKey !== 'string'
    || !identity.publicKey.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')
    || identity.publicKey.includes('PRIVATE KEY')) {
    throw new Error('RPM signing requires an exact uppercase OpenPGP fingerprint and armored public key');
  }
  return identity;
}

export function rpmIdentityFromEnvironment() {
  if (process.env.PROPR_DESKTOP_RPM_FINGERPRINT !== OWNER_FINGERPRINT) throw new Error('Release identity differs from owner pin');
  return requireRpmIdentity({
    fingerprint: process.env.PROPR_DESKTOP_RPM_FINGERPRINT,
    publicKey: process.env.PROPR_DESKTOP_RPM_PUBLIC_KEY,
  });
}

// Do not forward subprocess diagnostics: import/sign errors can echo key material.
export async function run(file, args, home) {
  try {
    return await execFile(file, args, {
      env: { PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        RPM_CONFIGDIR: process.env.RPM_CONFIGDIR, HOME: home, GNUPGHOME: home, LC_ALL: 'C' },
      timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error(`RPM signing/verification tool failed: ${file}`);
  }
}

export async function withKey(identity, callback) {
  requireRpmIdentity(identity);
  const home = await mkdtemp(join(tmpdir(), 'propr-rpm-key-'));
  try {
    const publicPath = join(home, 'release.asc');
    await writeFile(publicPath, identity.publicKey, { mode: 0o600 });
    await run('gpg', ['--batch', '--no-autostart', '--import', publicPath], home);
    const { stdout } = await run('gpg', ['--batch', '--with-colons', '--list-keys'], home);
    const lines = stdout.trim().split('\n').map(line => line.split(':'));
    const primary = lines.filter(fields => fields[0] === 'pub');
    const fingerprints = lines.filter(fields => fields[0] === 'fpr');
    // Use an exact signing-capable RSA primary key (no implicit subkey selection).
    // RPM 4.x / Leap 15.6 compatibility: RSA + SHA256, OpenPGP v4 fingerprint.
    if (primary.length !== 1 || fingerprints[0]?.[9] !== identity.fingerprint
      || primary[0][3] !== '1' || Number(primary[0][2]) < 2048
      || /[red]/.test(primary[0][1]) || !primary[0][11].includes('s')
      || (Number(primary[0][6]) > 0 && Number(primary[0][6]) <= Date.now() / 1000)) {
      throw new Error('RPM public key is not the pinned, usable RSA signing identity');
    }
    return await callback(home, publicPath);
  } finally {
    await run('gpgconf', ['--kill', 'gpg-agent'], home).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
}

// rpmkeys prints the supplied pathname as its first line. Only indented
// result lines are verification evidence; filenames can contain status words.
export function assertRpmSignatures(stdout, fingerprint) {
  const statuses = stdout.split('\n').filter(line => /^[ \t]+/.test(line)).join('\n');
  // A digest-only unsigned RPM also exits zero. Require BOTH native header and
  // header+payload signatures, with no missing key or digest/signature failure.
  const id = fingerprint.slice(-8).toLowerCase();
  // Parse key IDs with fixed patterns, then compare them as literal strings.
  const header = [...statuses.matchAll(/^\s*Header V[34] RSA\/SHA256 Signature, key ID ([a-f0-9]{8}): OK$/gmi)]
    .some(match => match[1].toLowerCase() === id);
  const packageSignature = [...statuses.matchAll(/^\s*V[34] RSA\/SHA256 Signature, key ID ([a-f0-9]{8}): OK$/gmi)]
    .some(match => match[1].toLowerCase() === id);
  // Failure words must be result values, not substrings of hexadecimal key IDs.
  if (!header || !packageSignature
    || /:[ \t]*(?:NOT OK|NOKEY|NOTTRUSTED|BAD|UNKNOWN)\b/i.test(statuses)) {
    throw new Error('RPM must have verified header and package signatures from the pinned identity');
  }
}

export async function verifyRpm({ path, identity }) {
  return withKey(identity, async (home, publicPath) => {
    const database = join(home, 'rpmdb');
    await mkdir(database);
    await run('rpmdb', ['--dbpath', database, '--initdb'], home);
    await run('rpmkeys', ['--dbpath', database, '--import', publicPath], home);
    const { stdout } = await run('rpmkeys', ['--dbpath', database, '--checksig', '--verbose', resolve(path)], home);
    assertRpmSignatures(stdout, identity.fingerprint);
    return { fingerprint: identity.fingerprint };
  });
}

// RPM v3/v4 lead + signature header precede the immutable main header and payload.
// Compare the entire latter region, including file hashes, modes, scripts and
// compressed native bytes; do not rely only on the uncompressed payload digest.
export async function rpmContentDigest(path) {
  const file = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(112);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== 112 || prefix.readUInt32BE(0) !== 0xedabeedb
      || prefix.readUInt32BE(96) !== 0x8eade801) throw new Error('Invalid RPM lead/signature header');
    const length = 16 + 16 * prefix.readUInt32BE(104) + prefix.readUInt32BE(108);
    const start = 96 + Math.ceil(length / 8) * 8;
    if (start >= (await file.stat()).size) throw new Error('Truncated RPM');
    const magic = Buffer.alloc(4);
    await file.read(magic, 0, 4, start);
    if (magic.readUInt32BE() !== 0x8eade801) throw new Error('Invalid RPM main header');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ start, autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await file.close(); }
}

export async function signRpm({ path, identity, privateKey, passphrase }) {
  if (typeof privateKey !== 'string' || !privateKey.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')
    || typeof passphrase !== 'string' || passphrase.length === 0 || /[\r\n\0]/.test(passphrase)) {
    throw new Error('RPM signing requires a protected armored private key and single-line passphrase');
  }
  const before = await rpmContentDigest(path);
  await withKey(identity, async home => {
    const secretPath = join(home, 'private.asc');
    const passwordPath = join(home, 'passphrase');
    await writeFile(secretPath, privateKey, { mode: 0o600 });
    await writeFile(passwordPath, passphrase, { mode: 0o600 });
    await run('gpg', ['--batch', '--import', secretPath], home);
    const { stdout } = await run('gpg', ['--batch', '--with-colons', '--list-secret-keys'], home);
    const records = stdout.split('\n').map(line => line.split(':'));
    if (records.filter(fields => fields[0] === 'sec').length !== 1
      || records.find(fields => fields[0] === 'fpr')?.[9] !== identity.fingerprint) {
      throw new Error('RPM private key does not match the pinned identity');
    }
    let gpgBinary;
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(directory, 'gpg');
      if (!/^\/[A-Za-z0-9/._-]+$/.test(candidate)) continue;
      try { await access(candidate, 1); gpgBinary = candidate; break; } catch { /* next PATH entry */ }
    }
    if (!gpgBinary) throw new Error('RPM signer requires an absolute GnuPG executable path');
    await run('rpmsign', ['--addsign', '--rpmv3',
      '--define', `_gpg_name ${identity.fingerprint}!`,
      '--define', '_gpg_digest_algo sha256',
      '--define', `__gpg ${gpgBinary}`,
      '--define', `_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback --passphrase-file ${passwordPath}`,
      resolve(path)], home);
  });
  if (await rpmContentDigest(path) !== before) throw new Error('RPM signing changed main header or payload bytes');
  // New GnuPG home + new RPM database, with only the public key. Never verify in
  // the signing keyring or the host's system trust database.
  await verifyRpm({ path, identity });
  return before;
}

// Public-only verification entry point. It never imports host/system trust.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.shift() !== 'verify' || args.length !== 6) throw new Error('Expected verify --rpm PATH --public-key PATH --fingerprint FULL_FINGERPRINT');
    const values = {};
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      if (!['--rpm', '--public-key', '--fingerprint'].includes(name) || values[name] !== undefined) {
        throw new Error('Invalid RPM verification arguments');
      }
      values[name] = args[index + 1];
    }
    const identity = { fingerprint: values['--fingerprint'], publicKey: await readFile(values['--public-key'], 'utf8') };
    await verifyRpm({ path: values['--rpm'], identity });
    console.log(`RPM header and package signatures verified: ${identity.fingerprint}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
