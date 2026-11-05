// A flat GitHub asset export of an APT repository. Paths are fixed by reviewed
// code, never by an archive or package-supplied Filename field.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withKey, run } from './rpm-signing.mjs';

export const aptAssets = ['APT-Packages-amd64', 'APT-Packages-arm64', 'APT-Release', 'APT-InRelease', 'APT-Release.gpg'];
export const authAssets = [...aptAssets, 'SHA256SUMS.asc'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function signMetadata({ path, output, identity, privateKey, passphrase, clear = false }) {
  if (!privateKey?.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')
    || typeof passphrase !== 'string' || !passphrase || /[\r\n\0]/.test(passphrase)) throw new Error('Invalid protected signing credentials');
  await withKey(identity, async home => {
    const secret = join(home, 'private.asc');
    const password = join(home, 'passphrase');
    await writeFile(secret, privateKey, { mode: 0o600 });
    await writeFile(password, passphrase, { mode: 0o600 });
    await run('gpg', ['--batch', '--import', secret], home);
    const { stdout } = await run('gpg', ['--batch', '--with-colons', '--list-secret-keys'], home);
    const records = stdout.split('\n').map(line => line.split(':'));
    if (records.filter(r => r[0] === 'sec').length !== 1
      || records.find(r => r[0] === 'fpr')?.[9] !== identity.fingerprint) throw new Error('Metadata private key mismatch');
    await run('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase-file', password,
      '--local-user', `${identity.fingerprint}!`, '--digest-algo', 'SHA256', '--armor',
      '--output', resolve(output), clear ? '--clearsign' : '--detach-sign', resolve(path)], home);
  });
  await verifyMetadata({ path, signature: output, identity, clear });
}

export async function verifyMetadata({ path, signature, identity, clear = false }) {
  const armored = await readFile(signature, 'utf8');
  if (clear && !armored.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n')) throw new Error('Noncanonical clear signature');
  const armor = clear ? armored.slice(armored.indexOf('-----BEGIN PGP SIGNATURE-----')) : armored;
  if (!/^-----BEGIN PGP SIGNATURE-----\n\n(?:[A-Za-z0-9+/=]{1,64}\n)+=[A-Za-z0-9+/]{4}\n-----END PGP SIGNATURE-----\n$/.test(armor)) throw new Error('Noncanonical armored signature');
  return withKey(identity, async home => {
    const args = ['--batch', '--status-fd', '1'];
    const decoded = join(home, 'decoded');
    const { stdout } = await run('gpg', [...args, ...(clear
      ? ['--output', decoded, '--decrypt', resolve(signature)]
      : ['--verify', resolve(signature), resolve(path)])], home);
    const valid = stdout.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
    const fields = valid[0]?.split(' ');
    if (valid.length !== 1 || fields[2] !== identity.fingerprint || fields[11] !== identity.fingerprint
      || fields[9] !== '8' || /\[GNUPG:\] (?:BADSIG|ERRSIG|EXPSIG|EXPKEYSIG|REVKEYSIG|KEYEXPIRED|SIGEXPIRED|NO_PUBKEY)/.test(stdout)) {
      throw new Error('Metadata signature is not from the exact valid pinned primary identity');
    }
    if (clear && !(await readFile(decoded)).equals(await readFile(path))) throw new Error('InRelease does not sign exact Release bytes');
  });
}

async function packageIndex(directory, artifact, version) {
  // Preserve dependency and other control fields so the exported repository has
  // real package-manager semantics. dpkg validates the binary control record.
  const { stdout } = await run('dpkg-deb', ['--field', resolve(directory, artifact.fileName)], directory);
  if (/^(?:Filename|Size|SHA256|MD5sum|SHA1):/mi.test(stdout) || /\n\s*\n/.test(stdout.trim())) throw new Error('Unexpected DEB index fields');
  const arch = artifact.arch === 'x64' ? 'amd64' : 'arm64';
  if (!stdout.split('\n').includes('Package: propr-desktop')
    || !stdout.split('\n').includes(`Version: ${version}`)
    || !stdout.split('\n').includes(`Architecture: ${arch}`)) throw new Error('DEB control identity mismatch');
  return `${stdout.trimEnd()}\nFilename: pool/${artifact.fileName}\nSize: ${artifact.size}\nSHA256: ${artifact.sha256}\n\n`;
}

async function canonicalApt(directory, manifest) {
  const records = {};
  for (const artifact of manifest.artifacts.filter(a => a.kind === 'deb')) {
    const arch = artifact.arch === 'x64' ? 'amd64' : 'arm64';
    records[`APT-Packages-${arch}`] = await packageIndex(directory, artifact, manifest.version);
  }
  const date = new Date(manifest.signing.createdAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 300_000
    || Date.now() >= date.getTime() + 30 * 86400_000) throw new Error('Signed preview is stale or future-dated');
  records['APT-Release'] = `Origin: ProPR\nLabel: ProPR Desktop authenticated preview\nSuite: preview\nCodename: preview\nDate: ${date.toUTCString()}\nValid-Until: ${new Date(date.getTime() + 30 * 86400_000).toUTCString()}\nArchitectures: amd64 arm64\nComponents: main\nDescription: Exported preview ${manifest.sourceRevision} run ${manifest.workflowRunId}\nSHA256:\n`;
  for (const arch of ['amd64', 'arm64']) {
    const bytes = Buffer.from(records[`APT-Packages-${arch}`]);
    records['APT-Release'] += ` ${hash(bytes)} ${bytes.length} main/binary-${arch}/Packages\n`;
  }
  return records;
}

export async function createApt({ directory, manifest, ...credentials }) {
  for (const [name, contents] of Object.entries(await canonicalApt(directory, manifest))) await writeFile(join(directory, name), contents);
  for (const [name, clear] of [['APT-InRelease', true], ['APT-Release.gpg', false]]) {
    await signMetadata({ ...credentials, path: join(directory, 'APT-Release'), output: join(directory, name), clear });
  }
}

export async function verifyApt({ directory, manifest, identity }) {
  for (const [name, clear] of [['APT-InRelease', true], ['APT-Release.gpg', false]]) {
    await verifyMetadata({ identity, path: join(directory, 'APT-Release'), signature: join(directory, name), clear });
  }
  for (const [name, contents] of Object.entries(await canonicalApt(directory, manifest))) {
    if (await readFile(join(directory, name), 'utf8') !== contents) throw new Error(`APT Release -> Packages -> DEB chain mismatch: ${name}`);
  }
  for (const artifact of manifest.artifacts.filter(a => a.kind === 'deb')) {
    const bytes = await readFile(join(directory, artifact.fileName));
    if (bytes.length !== artifact.size || hash(bytes) !== artifact.sha256) throw new Error('APT DEB hash mismatch');
  }
}
