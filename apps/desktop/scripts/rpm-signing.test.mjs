import { SIGNED_RPM_ACCEPTANCE_CHECKS } from './signed-rpm-acceptance-evidence.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { inspectSignedPreviewPayload } from './rpm-preview-payload.mjs';
import { OWNER_FINGERPRINT, rpmIdentityFromEnvironment, withKey, assertRpmSignatures, requireRpmIdentity, rpmContentDigest, rpmPublicKeyFileContents, signRpm, verifyRpm, writeRpmPublicKeyFile } from './rpm-signing.mjs';
import { linuxPreviewInstallNotes, linuxPreviewTag, prepareLinuxPreview, readLinuxPreviewBundle, signLinuxPreviewBundle, stageLinuxPreviewDraft, publishLinuxPreviewDraft } from './linux-preview-release.mjs';
import { aptAcceptance } from './apt-auth-acceptance.mjs';
import { authAssets, aptAssets, signMetadata, verifyMetadata, verifyApt } from './linux-package-auth.mjs';
import { createDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tools = ['gpg', 'rpm', 'rpmsign', 'rpmkeys', 'rpmdb', 'rpmbuild', 'rpm2cpio', 'cpio', 'dpkg-deb', 'apt-get', 'gpgv', 'python3'];
const missing = tools.filter(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
if (process.env.PROPR_REQUIRE_RPM_TESTS === '1' && missing.length) throw new Error(`Missing required RPM test tools: ${missing}`);
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
const repositoryRoot = resolve(import.meta.dirname, '../../..');

async function key(root, name, historical = false) {
  const home = join(root, name);
  await mkdir(home, { mode: 0o700 });
  const args = ['--homedir', home, ...(historical ? ['--faked-system-time', '1577836800'] : []), '--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0'];
  const passphrase = 'disposable-test-passphrase';
  run('gpg', [...args, '--quick-generate-key', `${name} <${name}@example.invalid>`, 'rsa2048', 'sign', '1d'], { input: passphrase });
  const listing = run('gpg', ['--homedir', home, '--with-colons', '--list-keys']);
  const fingerprint = listing.split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
  const publicKey = run('gpg', ['--homedir', home, '--armor', '--export', fingerprint]);
  const privateKey = run('gpg', [...args, '--armor', '--export-secret-keys', fingerprint], { input: passphrase });
  run('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
  return { identity: { fingerprint, publicKey }, privateKey, passphrase };
}

// Real format fixtures: ELF architecture headers, canonical layout, source-pinned
// native addons, runtime binding and sandbox metadata, with no executable launch.
async function packages(root, arch, manifest) {
  const build = join(root, arch);
  const tree = join(build, 'tree');
  const app = join(tree, 'usr/lib/propr-desktop');
  const resources = join(app, 'resources');
  const native = `.vite/native/prebuilds/linux-${arch}/directory-operations.node`;
  await mkdir(join(resources, 'app.asar.unpacked', dirname(native)), { recursive: true });
  await mkdir(join(tree, 'usr/bin'), { recursive: true });
  const elf = Buffer.alloc(128);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  await writeFile(join(app, 'propr-desktop'), elf, { mode: 0o755 });
  await writeFile(join(app, 'chrome-sandbox'), elf, { mode: 0o4755 });
  await chmod(join(app, 'chrome-sandbox'), 0o4755);
  await symlink('../lib/propr-desktop/propr-desktop', join(tree, 'usr/bin/propr-desktop'));
  await writeFile(join(resources, 'manifest.json'), JSON.stringify(manifest));
  await copyFile(join(repositoryRoot, 'packages/cli/native/prebuilds', `linux-${arch}`, 'directory-operations.node'),
    join(resources, 'app.asar.unpacked', native));
  await chmod(join(resources, 'app.asar.unpacked', native), 0o644);
  await mkdir(join(tree, 'DEBIAN'));
  await writeFile(join(tree, 'DEBIAN/control'), `Package: propr-desktop\nVersion: 1.2.3\nArchitecture: ${arch === 'x64' ? 'amd64' : 'arm64'}\nMaintainer: Test <test@example.invalid>\nDescription: Disposable signing test\n`);
  const deb = join(build, 'fixture.deb');
  run('dpkg-deb', ['--build', '--root-owner-group', tree, deb]);
  const rpmArch = arch === 'x64' ? 'x86_64' : 'aarch64';
  const spec = join(build, 'fixture.spec');
  await writeFile(spec, `Name: propr-desktop
Version: 1.2.3
Release: 1
Summary: Disposable signing test
License: MIT
AutoReqProv: no
%description
Disposable signing test
%install
mkdir -p %{buildroot}
cp -a ${tree}/usr %{buildroot}/
%files
%defattr(-,root,root,-)
/usr/bin/propr-desktop
/usr/lib/propr-desktop
%attr(4755,root,root) /usr/lib/propr-desktop/chrome-sandbox
`);
  run('rpmbuild', ['-bb', '--target', rpmArch, '--define', `_topdir ${build}`, '--define', '__os_install_post %{nil}', spec]);
  return { deb, rpm: join(build, 'RPMS', rpmArch, `propr-desktop-1.2.3-1.${rpmArch}.rpm`) };
}

// In-memory GitHub transport exercises the production retry/download/publication
// paths with real signed RPM bytes. No network or release credentials are used.
function github(sourceRevision) {
  const state = { release: undefined, assets: [], publications: 0 };
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  state.fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/repos/integry/propr', '');
    const method = options.method || 'GET';
    if (path.startsWith('/actions/runs/12345/artifacts')) return json({ artifacts: state.acceptanceArchive ? [{
      id: 42, name: 'propr-desktop-installed-signed-rpm-12345', expired: false, workflow_run: { id: 12345 },
      size_in_bytes: state.acceptanceArchive.length, digest: `sha256:${sha256(state.acceptanceArchive)}`,
    }] : [] });
    if (path === '/actions/artifacts/42/zip') return new Response(state.acceptanceArchive);
    if (path === '/actions/runs/12345') return json({ id: 12345, event: 'workflow_dispatch', path: '.github/workflows/desktop-linux-signed-preview.yml', head_branch: 'main', conclusion: 'success', repository: { full_name: 'integry/propr' } });
    if (path.startsWith('/git/ref/tags/')) return new Response('', { status: 404 });
    if (path.startsWith('/commits/')) return json({ sha: sourceRevision });
    if (path === '/releases' && method === 'GET') return json(state.release ? [state.release] : []);
    if (path === '/releases' && method === 'POST') {
      state.release = { ...JSON.parse(options.body), id: 7, published_at: null,
        upload_url: 'https://uploads.github.com/releases/7/assets{?name,label}' };
      return json(state.release);
    }
    if (parsed.hostname === 'uploads.github.com') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const asset = { id: state.assets.length + 1, name: parsed.searchParams.get('name'),
        state: 'uploaded', size: bytes.length, digest: `sha256:${sha256(bytes)}`, bytes };
      asset.url = `https://api.github.com/assets/${asset.id}`;
      state.assets.push(asset);
      return json(asset);
    }
    if (path === '/releases/7/assets') return json(state.assets);
    if (path.startsWith('/assets/')) return new Response(state.assets.find(a => a.url === url).bytes);
    if (path === '/releases/7' && method === 'PATCH') {
      const change = JSON.parse(options.body);
      assert.deepEqual(change, { draft: false, prerelease: true, make_latest: 'false' });
      state.publications++;
      Object.assign(state.release, change, { published_at: new Date().toISOString() });
    }
    if (path === '/releases/7') return json(state.release);
    throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
  };
  return state;
}

test('signed mode requires exact public identity inputs', async () => {
  for (const identity of [undefined, {}, { fingerprint: 'A'.repeat(16), publicKey: 'x' },
    { fingerprint: 'a'.repeat(40), publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----' },
    { fingerprint: 'A'.repeat(40), publicKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----' }]) {
    assert.throws(() => requireRpmIdentity(identity), /exact uppercase OpenPGP fingerprint/);
    await assert.rejects(verifyRpm({ path: '/unused', identity }), /exact uppercase OpenPGP fingerprint/);
  }
});

const PREVIOUS_FINGERPRINT = 'DD4E7F65CE2345A1F4597D643CF856B53093D3A3';
const ownerExport = 'docs/static/keys/propr-desktop-release.asc';
const historicalExport = `docs/static/keys/propr-desktop-release-historical-${PREVIOUS_FINGERPRINT}.asc`;

async function inspectExport(path, fingerprint) {
  const publicKey = await readFile(join(repositoryRoot, path), 'utf8');
  assert.doesNotMatch(publicKey, /PRIVATE KEY/);
  return withKey({ fingerprint, publicKey }, async home => {
    const records = run('gpg', ['--homedir', home, '--with-colons', '--list-keys']).split('\n').map(l => l.split(':'));
    assert.equal(records.filter(r => r[0] === 'pub').length, 1);
    assert.equal(records.filter(r => r[0] === 'sub').length, 0);
    assert.equal(run('gpg', ['--homedir', home, '--with-colons', '--list-secret-keys']).trim(), '');
    const primary = records.find(r => r[0] === 'pub');
    assert.equal(primary[2], '4096');
    assert.equal(primary[3], '1');
    return { publicKey, created: new Date(Number(primary[5]) * 1000).toISOString(),
      expires: new Date(Number(primary[6]) * 1000).toISOString(), uids: records.filter(r => r[0] === 'uid').map(r => r[9]) };
  });
}

test('documented owner public export has the exact complete RSA4096 identity and expiry', {
  skip: missing.length ? `Missing tools: ${missing}` : false,
}, async () => {
  assert.equal(OWNER_FINGERPRINT, '80FE0A7667A92A0AD3CEAE6D4C2FF8C3CC4E1599');
  const owner = await inspectExport(ownerExport, OWNER_FINGERPRINT);
  assert.deepEqual(owner.uids, ['ProPR Desktop Release Signing']);
  assert.equal(owner.created, '2026-10-19T14:09:59.000Z');
  assert.equal(owner.expires, '2028-10-18T14:09:59.000Z');
  // The previous export stays published unchanged as historical public material only.
  const previous = await inspectExport(historicalExport, PREVIOUS_FINGERPRINT);
  assert.deepEqual(previous.uids, ['ProPR Desktop RPM Signing']);
  assert.equal(previous.created, '2026-10-12T13:07:27.000Z');
  assert.equal(previous.expires, '2028-10-11T13:11:25.000Z');
  // Neither export can stand in for the other under either fingerprint.
  await assert.rejects(withKey({ fingerprint: OWNER_FINGERPRINT, publicKey: previous.publicKey }, async () => {}), /pinned, usable RSA/);
  await assert.rejects(withKey({ fingerprint: PREVIOUS_FINGERPRINT, publicKey: owner.publicKey }, async () => {}), /pinned, usable RSA/);
});

test('production environment pin accepts only the replacement owner fingerprint with its public export', {
  skip: missing.length ? `Missing tools: ${missing}` : false,
}, async t => {
  const saved = { fingerprint: process.env.PROPR_DESKTOP_RPM_FINGERPRINT, publicKey: process.env.PROPR_DESKTOP_RPM_PUBLIC_KEY };
  t.after(() => {
    for (const [name, value] of [['PROPR_DESKTOP_RPM_FINGERPRINT', saved.fingerprint], ['PROPR_DESKTOP_RPM_PUBLIC_KEY', saved.publicKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const ownerKey = await readFile(join(repositoryRoot, ownerExport), 'utf8');
  const previousKey = await readFile(join(repositoryRoot, historicalExport), 'utf8');
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disposable = await key(root, 'wrong-signer');
  for (const [fingerprint, publicKey] of [[PREVIOUS_FINGERPRINT, previousKey], [PREVIOUS_FINGERPRINT, ownerKey],
    [disposable.identity.fingerprint, disposable.identity.publicKey], [OWNER_FINGERPRINT.toLowerCase(), ownerKey],
    [OWNER_FINGERPRINT.slice(-16), ownerKey], [undefined, ownerKey]]) {
    if (fingerprint === undefined) delete process.env.PROPR_DESKTOP_RPM_FINGERPRINT;
    else process.env.PROPR_DESKTOP_RPM_FINGERPRINT = fingerprint;
    process.env.PROPR_DESKTOP_RPM_PUBLIC_KEY = publicKey;
    assert.throws(() => rpmIdentityFromEnvironment(), /differs from owner pin/);
  }
  process.env.PROPR_DESKTOP_RPM_FINGERPRINT = OWNER_FINGERPRINT;
  process.env.PROPR_DESKTOP_RPM_PUBLIC_KEY = ownerKey;
  const identity = rpmIdentityFromEnvironment();
  assert.deepEqual(identity, { fingerprint: OWNER_FINGERPRINT, publicKey: ownerKey });
  assert.equal(await withKey(identity, async () => 'accepted'), 'accepted');
  // A matching pin with mismatched public settings (old export or another signer) fails before signing.
  for (const publicKey of [previousKey, disposable.identity.publicKey]) {
    process.env.PROPR_DESKTOP_RPM_PUBLIC_KEY = publicKey;
    await assert.rejects(withKey(rpmIdentityFromEnvironment(), async () => {}), /pinned, usable RSA/);
  }
});

test('RPM public-key tool files are LF-terminated without rewriting key material', async t => {
  const armor = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBGdisposable\n=AbCd\n-----END PGP PUBLIC KEY BLOCK-----';
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-public-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [publicKey, expected] of [[armor, `${armor}\n`], [`${armor}\n`, `${armor}\n`], [`${armor}\r\n`, `${armor}\r\n`]]) {
    const identity = Object.freeze({ fingerprint: 'A'.repeat(40), publicKey });
    assert.equal(rpmPublicKeyFileContents(identity), expected);
    const path = join(root, `public-${publicKey.length}.asc`);
    await writeRpmPublicKeyFile(path, identity);
    assert.equal(await readFile(path, 'utf8'), expected);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(identity.publicKey, publicKey);
  }
  // Serialization never bypasses identity validation.
  for (const identity of [{ fingerprint: 'a'.repeat(40), publicKey: armor }, { fingerprint: 'A'.repeat(40), publicKey: armor.replace('PUBLIC', 'PRIVATE') }]) {
    assert.throws(() => rpmPublicKeyFileContents(identity), /exact uppercase OpenPGP fingerprint/);
    await assert.rejects(writeRpmPublicKeyFile(join(root, 'rejected.asc'), identity), /exact uppercase OpenPGP fingerprint/);
  }
  assert.equal(existsSync(join(root, 'rejected.asc')), false);
});

test('unterminated disposable public armor imports into a fresh RPM database through withKey', {
  skip: missing.length ? `Missing tools: ${missing}` : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-unterminated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disposable = await key(root, 'unterminated');
  const other = await key(root, 'other');
  const exported = disposable.identity.publicKey;
  assert.match(exported, /-----END PGP PUBLIC KEY BLOCK-----\n$/);
  const unterminated = exported.replace(/\n+$/, '');
  for (const publicKey of [unterminated, exported]) {
    const identity = Object.freeze({ fingerprint: disposable.identity.fingerprint, publicKey });
    const home = await withKey(identity, async (keyHome, publicPath) => {
      assert.equal(await readFile(publicPath, 'utf8'), `${unterminated}\n`);
      assert.equal((await stat(publicPath)).mode & 0o777, 0o600);
      const database = join(keyHome, 'rpmdb');
      await mkdir(database);
      run('rpmdb', ['--dbpath', database, '--initdb']);
      run('rpmkeys', ['--dbpath', database, '--import', publicPath]);
      const keys = run('rpm', ['--dbpath', database, '-qa', 'gpg-pubkey*']).trim().split('\n');
      assert.deepEqual(keys.map(name => name.split('-')[2]), [identity.fingerprint.slice(-8).toLowerCase()]);
      return keyHome;
    });
    assert.equal(existsSync(home), false, 'temporary key home is removed');
    assert.equal(identity.publicKey, publicKey);
  }
  // Fingerprint equality and exactly-one-key checks still reject unterminated input.
  await assert.rejects(withKey({ fingerprint: other.identity.fingerprint, publicKey: unterminated }, async () => {}), /pinned, usable RSA/);
  await assert.rejects(withKey({ fingerprint: disposable.identity.fingerprint, publicKey: `${unterminated}\n${other.identity.publicKey.trimEnd()}` },
    async () => {}), /pinned, usable RSA/);
});

test('generated install-note key extraction yields RPM-importable disposable armor with or without a final LF', {
  skip: missing.length ? `Missing tools: ${missing}` : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-install-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disposable = await key(root, 'notes');
  const exported = disposable.identity.publicKey;
  const unterminated = exported.replace(/\n+$/, '');
  for (const [index, publicKey] of [unterminated, exported].entries()) {
    const rpmIdentity = Object.freeze({ fingerprint: disposable.identity.fingerprint, publicKey });
    const notes = linuxPreviewInstallNotes({ version: '1.2.3', sourceRevision: '1'.repeat(40),
      tag: linuxPreviewTag('1.2.3', '1'.repeat(40), rpmIdentity), rpmIdentity });
    const [command] = notes.split('\n').filter(line => line.startsWith('python3 '));
    const directory = join(root, `consumer-${index}`);
    await mkdir(directory);
    const manifest = Buffer.from(JSON.stringify({ rpmSigning: { fingerprint: rpmIdentity.fingerprint, publicKey } }));
    await writeFile(join(directory, 'linux-preview.json'), manifest);
    run('sh', ['-c', command], { cwd: directory });
    const asc = join(directory, 'propr-desktop-rpm.asc');
    assert.equal(await readFile(asc, 'utf8'), `${unterminated}\n`);
    assert.deepEqual(await readFile(join(directory, 'linux-preview.json')), manifest);
    const shown = run('gpg', ['--homedir', join(root, 'notes'), '--with-colons', '--show-keys', asc]);
    assert.equal(shown.split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9], rpmIdentity.fingerprint);
    // A disposable database stands in for the administrator's manual system import.
    const database = join(directory, 'rpmdb');
    await mkdir(database);
    run('rpmdb', ['--dbpath', database, '--initdb']);
    run('rpmkeys', ['--dbpath', database, '--import', asc]);
    const keys = run('rpm', ['--dbpath', database, '-qa', 'gpg-pubkey*']).trim().split('\n');
    assert.deepEqual(keys.map(name => name.split('-')[2]), [rpmIdentity.fingerprint.slice(-8).toLowerCase()]);
    assert.equal(rpmIdentity.publicKey, publicKey);
  }
});

test('signature status parsing ignores filename tokens but requires both pinned signatures', () => {
  const fingerprint = 'A'.repeat(32) + '1234ABCD';
  const header = '    Header V4 RSA/SHA256 Signature, key ID 1234abcd: OK';
  const payload = '    V4 RSA/SHA256 Signature, key ID 1234abcd: OK';
  const digest = '    Payload SHA256 digest: OK';
  for (const path of ['/home/abadi/Downloads/valid.rpm', '/tmp/XbAd1z/UNKNOWN.rpm', '/tmp/NOT OK-NOKEY-NOTTRUSTED.rpm']) {
    const output = `${path}:\n${header}\n${payload}\n${digest}\n`;
    assert.doesNotThrow(() => assertRpmSignatures(output, fingerprint));
    for (const line of [header, payload]) {
      assert.throws(() => assertRpmSignatures(output.replace(line, ''), fingerprint), /signatures/);
      assert.throws(() => assertRpmSignatures(output.replace(line, line.replace('1234abcd', 'deadbeef')), fingerprint), /signatures/);
      for (const status of ['NOT OK', 'NOKEY', 'NOTTRUSTED', 'BAD', 'UNKNOWN']) {
        assert.throws(() => assertRpmSignatures(output.replace(line, line.replace(': OK', `: ${status}`)), fingerprint), /signatures/);
        // Additional failures must be rejected even alongside two good signatures.
        assert.throws(() => assertRpmSignatures(`${output}    Signature: ${status}\n`, fingerprint), /signatures/);
        assert.throws(() => assertRpmSignatures(output.replace(digest, digest.replace(': OK', `: ${status}`)), fingerprint), /signatures/);
      }
    }
  }
  assert.throws(() => assertRpmSignatures(`/tmp/unsigned.rpm:\n${digest}\n`, fingerprint), /signature|tool failed/);
});

test('signature status parsing accepts BAD within a verified hexadecimal key ID', () => {
  for (const id of ['bad12345', '12bad345', '12345bad']) {
    const fingerprint = 'A'.repeat(32) + id.toUpperCase();
    const header = `    Header V4 RSA/SHA256 Signature, key ID ${id}: OK`;
    const payload = `    V4 RSA/SHA256 Signature, key ID ${id}: OK`;
    const output = `/tmp/signed.rpm:\n${header}\n${payload}\n`;
    assert.doesNotThrow(() => assertRpmSignatures(output, fingerprint));
    for (const line of [header, payload]) {
      assert.throws(() => assertRpmSignatures(output.replace(line, line.replace(': OK', ': BAD')), fingerprint), /signatures/);
    }
    assert.throws(() => assertRpmSignatures(`${output}    Payload SHA256 digest: BAD\n`, fingerprint), /signatures/);
  }
});

test('real RPM signatures and signed preview bundles fail closed and preserve frozen payloads', {
  skip: missing.length ? `Missing tools: ${missing.join(', ')}` : false,
  timeout: 300_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-rpm-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const correct = await key(root, 'correct');
  const wrong = await key(root, 'wrong');
  const sourceRevision = '1'.repeat(40);
  const version = '1.2.3';
  const repository = 'integry/propr';
  const runtimeAppImage = `propr/app:${sourceRevision}@sha256:${'a'.repeat(64)}`;
  const runtimeUiImage = `propr/ui:${sourceRevision}@sha256:${'b'.repeat(64)}`;
  const runtimeAgentImage = `propr/agent:${sourceRevision}@sha256:${'c'.repeat(64)}`;
  const runtime = createDesktopRuntimeManifest({}, { sourceRevision, distribution: 'published',
    appImage: runtimeAppImage, uiImage: runtimeUiImage, agentImage: runtimeAgentImage, apiCompatibility: '2026-06-27' });
  const input = join(root, 'input');
  await mkdir(input);
  const artifacts = [];
  for (const arch of ['x64', 'arm64']) {
    const built = await packages(root, arch, runtime);
    for (const kind of ['deb', 'rpm']) {
      const fileName = `ProPR-Desktop-${version}-linux-${arch}.${kind}`;
      const bytes = await readFile(built[kind]);
      await copyFile(built[kind], join(input, fileName));
      artifacts.push({ platform: 'linux', arch, kind, fileName, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  artifacts.sort((a, b) => a.fileName.localeCompare(b.fileName));
  await writeFile(join(input, 'desktop-release.json'), JSON.stringify({ releaseProfile: 'linux-preview-v1', version, channel: 'validation', artifacts }));
  await writeFile(join(input, 'SHA256SUMS'), artifacts.map(a => `${a.sha256}  ${a.fileName}\n`).join(''));
  const directory = join(root, 'unsigned');
  const options = { version, sourceRevision, repository };
  await prepareLinuxPreview({ ...options, inputDirectory: input, outputDirectory: directory,
    runtimeAppImage, runtimeUiImage, runtimeAgentImage, workflowRunId: '123' });
  const unsignedRpm = join(directory, artifacts.find(a => a.kind === 'rpm').fileName);
  await assert.rejects(verifyRpm({ path: unsignedRpm, identity: correct.identity }), /signatures/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, passphrase: '' }), /passphrase/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, passphrase: 'wrong-password' }), /tool failed/);
  await assert.rejects(signRpm({ path: unsignedRpm, ...correct, identity: wrong.identity }), /private key/);
  await assert.rejects(verifyRpm({ path: unsignedRpm,
    identity: { ...correct.identity, fingerprint: wrong.identity.fingerprint } }), /pinned/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory, rpmIdentity: correct.identity }), /missing or unexpected/);

  const signed = join(root, 'signed');
  // Every package parser must see a scrubbed environment, before and after signing.
  const wrappers = join(root, 'bin');
  const parserLog = join(root, 'parsers.log');
  await mkdir(wrappers);
  for (const tool of ['rpm', 'dpkg-deb', 'rpm2cpio', 'cpio']) {
    const executable = run('which', [tool]).trim();
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(join(wrappers, tool), `#!/bin/sh
if [ "\${PROPR_DESKTOP_RPM_PRIVATE_KEY+x}" = x ] || [ "\${PROPR_DESKTOP_RPM_PASSPHRASE+x}" = x ]; then exit 99; fi
printf '%s\\n' ${quote(tool)} >> ${quote(parserLog)}
exec ${quote(executable)} "$@"
`, { mode: 0o755 });
  }
  run(process.execPath, ['--input-type=module', '-e', `
    import { signLinuxPreviewBundle } from './apps/desktop/scripts/linux-preview-release.mjs';
    const privateKey = process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
    const passphrase = process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
    delete process.env.PROPR_DESKTOP_RPM_PRIVATE_KEY;
    delete process.env.PROPR_DESKTOP_RPM_PASSPHRASE;
    await signLinuxPreviewBundle({ ...JSON.parse(process.env.TEST_OPTIONS), privateKey, passphrase });
  `], { cwd: repositoryRoot, env: { ...process.env, PATH: `${wrappers}:${process.env.PATH}`,
    TEST_OPTIONS: JSON.stringify({ ...options, directory, outputDirectory: signed,
      sourceDirectory: repositoryRoot, rpmIdentity: correct.identity }),
    PROPR_DESKTOP_RPM_PRIVATE_KEY: correct.privateKey, PROPR_DESKTOP_RPM_PASSPHRASE: correct.passphrase } });
  const parserCalls = (await readFile(parserLog, 'utf8')).trim().split('\n');
  for (const tool of ['rpm', 'dpkg-deb', 'rpm2cpio', 'cpio']) {
    assert.ok(parserCalls.filter(call => call === tool).length >= 4, `${tool} inspected both architectures before and after signing`);
  }
  const manifest = JSON.parse(await readFile(join(signed, 'linux-preview.json'), 'utf8'));
  assert.equal(manifest.tag, `${linuxPreviewTag(version, sourceRevision)}-all-signed`);
  assert.equal(manifest.trust, 'authenticated-linux-preview');
  const bundle = await readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot });
  assert.equal(bundle.assets.size, 13);
  assert.match(bundle.notes, /sudo zypper install/);
  assert.match(bundle.notes, /NOKEY/);
  assert.match(bundle.notes, /Direct DEB downloads are authenticated/);
  assert.doesNotMatch(bundle.notes, /--allow-unsigned-rpm|--nogpgcheck|--no-gpg-checks/);
  await aptAcceptance({ root, directory: signed, manifest, identity: correct.identity });
  for (const [data, signature, clear] of [['SHA256SUMS', 'SHA256SUMS.asc', false],
    ['APT-Release', 'APT-InRelease', true], ['APT-Release', 'APT-Release.gpg', false]]) {
    const verify = identity => verifyMetadata({ path: join(signed, data), signature: join(signed, signature), clear, identity });
    await verify(correct.identity);
    await assert.rejects(verify(wrong.identity), /failed|signature/);
    const replacement = join(root, `wrong-${signature}`);
    await signMetadata({ path: join(signed, data), output: replacement, clear, ...wrong });
    await assert.rejects(verifyMetadata({ path: join(signed, data), signature: replacement, clear, identity: correct.identity }), /failed|signature/);
  }
  const expired = await key(root, 'expired', true);
  await assert.rejects(signMetadata({ path: join(signed, 'SHA256SUMS'), output: join(root, 'expired.sig'), ...expired }), /usable RSA/);
  const expiredSignature = join(root, 'expired-real.asc');
  run('gpg', ['--homedir', join(root, 'expired'), '--batch', '--faked-system-time', '1577836810',
    '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '--local-user', `${expired.identity.fingerprint}!`,
    '--digest-algo', 'SHA256', '--armor', '--output', expiredSignature, '--detach-sign', join(signed, 'SHA256SUMS')], { input: expired.passphrase });
  run('gpgconf', ['--homedir', join(root, 'expired'), '--kill', 'gpg-agent']);
  await assert.rejects(verifyMetadata({ path: join(signed, 'SHA256SUMS'), signature: expiredSignature, identity: expired.identity }), /usable RSA/);
  const revoked = await key(root, 'revoked');
  const revokedSignature = join(root, 'revoked-real.asc');
  await signMetadata({ path: join(signed, 'SHA256SUMS'), output: revokedSignature, ...revoked });
  const revokePath = join(root, 'revoked', 'openpgp-revocs.d', `${revoked.identity.fingerprint}.rev`);
  const certificate = (await readFile(revokePath, 'utf8')).replace(':-----BEGIN', '-----BEGIN');
  run('gpg', ['--homedir', join(root, 'revoked'), '--batch', '--import'], { input: certificate });
  revoked.identity.publicKey = run('gpg', ['--homedir', join(root, 'revoked'), '--armor', '--export', revoked.identity.fingerprint]);
  run('gpgconf', ['--homedir', join(root, 'revoked'), '--kill', 'gpg-agent']);
  await assert.rejects(signMetadata({ path: join(signed, 'SHA256SUMS'), output: join(root, 'revoked.sig'), ...revoked }), /usable RSA/);
  await assert.rejects(verifyRpm({ path: unsignedRpm, identity: revoked.identity }), /usable RSA/);
  await assert.rejects(verifyMetadata({ path: join(signed, 'SHA256SUMS'), signature: revokedSignature, identity: revoked.identity }), /usable RSA/);
  await assert.rejects(verifyApt({ directory: signed, manifest: { ...manifest, signing: { ...manifest.signing, createdAt: '2020-01-01T00:00:00.000Z' } }, identity: correct.identity }), /stale/);
  const readSigned = () => readLinuxPreviewBundle({ ...options, directory: signed, rpmIdentity: correct.identity, sourceDirectory: repositoryRoot });
  for (const name of [...bundle.assets.keys()]) {
    const path = join(signed, name);
    const bytes = await readFile(path);
    await rm(path);
    await assert.rejects(readSigned(), /missing or unexpected/);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await writeFile(path, changed);
    await assert.rejects(readSigned(), undefined, `Tampered ${name}`);
    if (aptAssets.includes(name) || name.endsWith('.deb')) await assert.rejects(verifyApt({ directory: signed, manifest, identity: correct.identity }));
    await writeFile(path, bytes);
  }
  await writeFile(join(signed, 'unexpected'), 'extra');
  await assert.rejects(readSigned(), /unexpected/);
  await rm(join(signed, 'unexpected'));
  await assert.rejects(readLinuxPreviewBundle({ ...options, sourceRevision: '2'.repeat(40), directory: signed, rpmIdentity: correct.identity }), /identity/);
  const publicPath = join(root, 'public.asc');
  await writeFile(publicPath, correct.identity.publicKey);
  const cli = ['apps/desktop/scripts/rpm-signing.mjs', 'verify', '--rpm',
    join(signed, manifest.artifacts.find(a => a.kind === 'rpm').fileName),
    '--public-key', publicPath, '--fingerprint', correct.identity.fingerprint];
  assert.match(run(process.execPath, cli, { cwd: repositoryRoot }), /header and package signatures verified/);
  const awkwardPath = join(root, 'XbAd1z-UNKNOWN.rpm');
  await copyFile(cli[3], awkwardPath);
  await verifyRpm({ path: awkwardPath, identity: correct.identity });
  const awkwardCli = [...cli];
  awkwardCli[3] = awkwardPath;
  assert.match(run(process.execPath, awkwardCli, { cwd: repositoryRoot }), /header and package signatures verified/);

  const inspected = manifest.artifacts.find(a => a.kind === 'rpm');
  await assert.rejects(inspectSignedPreviewPayload({ path: join(signed, inspected.fileName), artifact: inspected,
    manifest: { ...manifest, runtime: { ...manifest.runtime, appImage: `propr/app:${sourceRevision}@sha256:${'d'.repeat(64)}` } },
    sourceDirectory: repositoryRoot }), /runtime digests/);
  const alteredSource = join(root, 'altered-source');
  const nativePath = `packages/cli/native/prebuilds/linux-${inspected.arch}/directory-operations.node`;
  await mkdir(dirname(join(alteredSource, nativePath)), { recursive: true });
  await mkdir(join(alteredSource, 'packages/cli/src/utils'), { recursive: true });
  await copyFile(join(repositoryRoot, 'packages/cli/src/utils/directoryDescriptor.ts'), join(alteredSource, 'packages/cli/src/utils/directoryDescriptor.ts'));
  await writeFile(join(alteredSource, nativePath), 'wrong native bytes');
  await assert.rejects(inspectSignedPreviewPayload({ path: join(signed, inspected.fileName), artifact: inspected,
    manifest, sourceDirectory: alteredSource }), /native addon/);

  for (const artifact of manifest.artifacts) {
    const original = join(directory, artifact.fileName);
    const final = join(signed, artifact.fileName);
    if (artifact.kind === 'deb') assert.deepEqual(await readFile(final), await readFile(original));
    else {
      assert.notEqual(sha256(await readFile(final)), sha256(await readFile(original)));
      assert.equal(await rpmContentDigest(final), await rpmContentDigest(original));
      await verifyRpm({ path: final, identity: correct.identity });
      await assert.rejects(verifyRpm({ path: final, identity: wrong.identity }), /failed|signatures/);
    }
  }
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed }), /missing or unexpected/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: wrong.identity, sourceDirectory: repositoryRoot }), /identity|tool failed/);
  const remote = github(sourceRevision);
  const acceptanceEvidence = { schemaVersion: 1, status: 'passed', target: 'linux-x64-rpm-opensuse',
    sourceRevision, rpmSha256: manifest.artifacts.find(a => a.kind === 'rpm' && a.arch === 'x64').sha256,
    fingerprint: correct.identity.fingerprint, signingRunId: '12345',
    checks: Object.fromEntries(SIGNED_RPM_ACCEPTANCE_CHECKS.map(key => [key, true])) };
  const authoritativeFile = join(root, 'signed-rpm-acceptance.json');
  const authoritativeZip = join(root, 'acceptance.zip');
  await writeFile(authoritativeFile, JSON.stringify(acceptanceEvidence));
  run('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED); z.write(sys.argv[2],"signed-rpm-acceptance.json"); z.close()', authoritativeZip, authoritativeFile]);
  remote.acceptanceArchive = await readFile(authoritativeZip);
  const publication = { ...options, acceptanceEvidence, signingRunId: '12345', directory: signed, rpmIdentity: correct.identity,
    sourceDirectory: repositoryRoot, token: 'disposable-test-token', fetchImpl: remote.fetchImpl };
  await stageLinuxPreviewDraft(publication);
  const signedTitle = `ProPR Desktop Linux preview ${version} (${sourceRevision.slice(0, 12)}) (authenticated DEB and RPM)`;
  assert.equal(remote.release.name, signedTitle);
  remote.release.name = signedTitle.replace(' (authenticated DEB and RPM)', '');
  await assert.rejects(stageLinuxPreviewDraft(publication), /exact unpublished/);
  await assert.rejects(publishLinuxPreviewDraft(publication), /exact unpublished/);
  assert.equal(remote.publications, 0);
  remote.release.name = signedTitle;
  await stageLinuxPreviewDraft(publication); // exact-byte upload retry
  // A title change across the awaited validation work must also fail the final check.
  const driftedPublication = { ...publication, fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/repos/integry/propr/releases/7') remote.release.name = 'wrong title';
    return remote.fetchImpl(url, options);
  } };
  await assert.rejects(stageLinuxPreviewDraft(driftedPublication), /exact unpublished/);
  remote.release.name = signedTitle;
  await assert.rejects(publishLinuxPreviewDraft(driftedPublication), /exact unpublished/);
  assert.equal(remote.publications, 0);
  remote.release.name = signedTitle;
  const remoteRpm = remote.assets.find(a => a.name.endsWith('.rpm'));
  const originalRemote = { ...remoteRpm };
  remoteRpm.bytes = await readFile(join(directory, remoteRpm.name));
  remoteRpm.size = remoteRpm.bytes.length;
  remoteRpm.digest = `sha256:${sha256(remoteRpm.bytes)}`;
  await assert.rejects(stageLinuxPreviewDraft(publication), /metadata mismatch|digest mismatch/);
  await assert.rejects(publishLinuxPreviewDraft(publication), /metadata mismatch|digest mismatch/);
  assert.equal(remote.publications, 0);
  Object.assign(remoteRpm, originalRemote);
  const firstAsset = remote.assets[0];
  const secondAsset = remote.assets[1];
  remote.assets[1] = firstAsset;
  await assert.rejects(publishLinuxPreviewDraft(publication), /duplicate/);
  remote.assets[1] = secondAsset;
  const savedName = firstAsset.name;
  firstAsset.name = '../escape';
  await assert.rejects(publishLinuxPreviewDraft(publication), /invalid/);
  firstAsset.name = savedName;
  for (const asset of remote.assets) {
    const saved = { ...asset };
    const changed = Buffer.from(asset.bytes); changed[changed.length - 1] ^= 1;
    Object.assign(asset, { bytes: changed, digest: `sha256:${sha256(changed)}` });
    await assert.rejects(publishLinuxPreviewDraft(publication));
    assert.equal(remote.publications, 0);
    Object.assign(asset, saved);
  }
  for (const evidence of [undefined, { ...acceptanceEvidence, status: 'failed' },
    { ...acceptanceEvidence, sourceRevision: 'f'.repeat(40) }, { ...acceptanceEvidence, rpmSha256: '0'.repeat(64) },
    { ...acceptanceEvidence, signingRunId: '9999' },
    { ...acceptanceEvidence, checks: { ...acceptanceEvidence.checks, browserApproval: false } }]) {
    await assert.rejects(publishLinuxPreviewDraft({ ...publication, acceptanceEvidence: evidence }), /acceptance evidence/);
    assert.equal(remote.publications, 0);
  }
  await assert.rejects(publishLinuxPreviewDraft({ ...publication, fetchImpl: async (url, init) =>
    new URL(url).pathname.endsWith('/actions/runs/12345') ? new Response(JSON.stringify({ id: 12345, conclusion: 'failure' })) : remote.fetchImpl(url, init) }), /successful trusted/);
  assert.equal(remote.publications, 0);
  const savedArchive = remote.acceptanceArchive;
  remote.acceptanceArchive = undefined;
  await assert.rejects(publishLinuxPreviewDraft(publication), /authoritative/);
  assert.equal(remote.publications, 0);
  remote.acceptanceArchive = savedArchive;
  await publishLinuxPreviewDraft(publication);
  assert.equal(remote.publications, 1);

  const target = manifest.artifacts.find(a => a.kind === 'rpm');
  const path = join(signed, target.fileName);
  const bytes = await readFile(path);
  const changedHeader = Buffer.from(bytes);
  const headerText = changedHeader.indexOf('Disposable signing test');
  assert.ok(headerText > 112);
  changedHeader[headerText] ^= 1;
  await writeFile(path, changedHeader);
  await assert.rejects(verifyRpm({ path, identity: correct.identity }), /failed|signatures/);
  bytes[bytes.length - 10] ^= 0xff;
  await writeFile(path, bytes);
  await assert.rejects(verifyRpm({ path, identity: correct.identity }), /failed|signatures/);
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot }), /digest mismatch/);

  // Even coherently rehashed unsigned substitution must fail cryptographic checks.
  await copyFile(join(directory, target.fileName), path);
  target.sha256 = sha256(await readFile(path));
  target.size = (await readFile(path)).length;
  await writeFile(join(signed, 'linux-preview.json'), JSON.stringify(manifest));
  const names = [...manifest.artifacts.map(a => a.fileName), 'INSTALL.md', 'linux-preview.json', ...aptAssets].sort();
  await writeFile(join(signed, 'SHA256SUMS'), (await Promise.all(names.map(async name =>
    `${sha256(await readFile(join(signed, name)))}  ${name}\n`))).join(''));
  await assert.rejects(readLinuxPreviewBundle({ ...options, directory: signed,
    rpmIdentity: correct.identity, sourceDirectory: repositoryRoot }), /signature|tool failed/);
});
