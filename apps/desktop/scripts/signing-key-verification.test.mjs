import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { OWNER_FINGERPRINT } from './rpm-signing.mjs';
import { PINNED_PUBLIC_EXPORT, VERIFY_KEY_CHALLENGE, confirmCleanup, signChallenge, verifyChallenge, verifyKeyReceipt,
  verifySigningKey } from './signing-key-verification.mjs';

const tools = ['gpg', 'gpgconf'];
const missing = tools.filter(tool => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
if (process.env.PROPR_REQUIRE_RPM_TESTS === '1' && missing.length) throw new Error(`Missing required signing test tools: ${missing}`);
// verify-key runs only on the Linux protected runner; cleanup proof reads /proc, and
// macOS temporary paths are too long for GnuPG agent sockets.
const linuxOnly = process.platform === 'linux' ? false : 'Requires the Linux verify-key runner (/proc cleanup proof)';
const skip = linuxOnly || (missing.length ? `Missing tools: ${missing}` : false);
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const script = join(import.meta.dirname, 'signing-key-verification.mjs');

// Disposable keys only; every GnuPG home is a fresh test directory, never the host keyring.
async function key(root, name, { expired = false, revoked = false } = {}) {
  const home = join(root, name);
  await mkdir(home, { mode: 0o700 });
  const passphrase = `disposable-${name}-passphrase`;
  const args = ['--homedir', home, ...(expired ? ['--faked-system-time', '1577836800'] : []),
    '--batch', '--pinentry-mode', 'loopback', '--passphrase-fd', '0'];
  run('gpg', [...args, '--quick-generate-key', `${name} <${name}@example.invalid>`, 'rsa2048', 'sign', '1d'], { input: passphrase });
  const fingerprint = run('gpg', ['--homedir', home, '--with-colons', '--list-keys'])
    .split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
  if (revoked) {
    const certificate = await readFile(join(home, 'openpgp-revocs.d', `${fingerprint}.rev`), 'utf8');
    const revocation = join(home, 'revocation.asc');
    await writeFile(revocation, certificate.replace(':-----BEGIN PGP PUBLIC KEY BLOCK-----', '-----BEGIN PGP PUBLIC KEY BLOCK-----'));
    run('gpg', ['--homedir', home, '--batch', '--import', revocation]);
  }
  const publicKey = run('gpg', ['--homedir', home, '--armor', '--export', fingerprint]);
  const privateKey = run('gpg', [...args, '--armor', '--export-secret-keys', fingerprint], { input: passphrase });
  run('gpgconf', ['--homedir', home, '--kill', 'gpg-agent']);
  return { home, identity: { fingerprint, publicKey }, privateKey, passphrase };
}

async function survivors(marker) {
  const found = [];
  for (const entry of (await readdir('/proc')).filter(name => /^[0-9]+$/.test(name))) {
    const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '');
    if (cmdline.includes(marker)) found.push(cmdline.replaceAll('\0', ' '));
  }
  return found;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'propr-verify-key-test-'));
  t.after(async () => {
    for (const name of await readdir(root)) {
      spawnSync('gpgconf', ['--homedir', join(root, name), '--kill', 'gpg-agent'], { stdio: 'ignore' });
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('stored key pair verification signs and independently verifies the fixed challenge', { skip }, async t => {
  const root = await fixture(t);
  const owner = await key(root, 'owner');
  const digests = await verifySigningKey({ identity: owner.identity, pinnedPublicKey: owner.identity.publicKey,
    privateKey: owner.privateKey, passphrase: owner.passphrase });
  assert.equal(digests.challengeSha256, sha256(VERIFY_KEY_CHALLENGE));
  assert.match(digests.signatureSha256, /^[a-f0-9]{64}$/);
  // Owned temporary homes and agents are gone; nothing references the scoped roots.
  assert.deepEqual(await survivors('propr-verify-key-'), []);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('propr-verify-key-') && !root.endsWith(name)), []);
  const receipt = verifyKeyReceipt({ repository: 'integry/propr', workflowRunId: '12345', controlRevision: 'a'.repeat(40),
    sourceRevision: 'b'.repeat(40), fingerprint: owner.identity.fingerprint, ...digests });
  assert.equal(receipt.operation, 'verify-key');
  assert.equal(receipt.workflowRunId, '12345');
  assert.equal(receipt.controlRevision, 'a'.repeat(40));
  assert.equal(receipt.fingerprint, owner.identity.fingerprint);
  assert.equal(receipt.digestAlgorithm, 'SHA256');
  assert.ok(Object.values(receipt.checks).every(value => value === true));
  const serialized = JSON.stringify(receipt);
  assert.ok(serialized.length < 2048);
  assert.doesNotMatch(serialized, /PRIVATE KEY|PUBLIC KEY|SIGNATURE-----|disposable-owner-passphrase/);
});

test('wrong passphrase, private key, public key, expiry or revocation fail without a result', { skip }, async t => {
  const root = await fixture(t);
  const owner = await key(root, 'owner');
  const other = await key(root, 'other');
  const expired = await key(root, 'expired', { expired: true });
  const revoked = await key(root, 'revoked', { revoked: true });
  const attempt = overrides => verifySigningKey({ identity: owner.identity, pinnedPublicKey: owner.identity.publicKey,
    privateKey: owner.privateKey, passphrase: owner.passphrase, ...overrides });
  const cases = [
    [{ passphrase: 'wrong-disposable-passphrase' }, /tool failed: gpg$/],
    [{ passphrase: other.passphrase }, /tool failed: gpg$/],
    [{ privateKey: other.privateKey, passphrase: other.passphrase }, /Metadata private key mismatch/],
    // A second key in the stored block is not an exact primary selection.
    [{ privateKey: `${owner.privateKey}${other.privateKey}` }, /Metadata private key mismatch/],
    [{ identity: { fingerprint: owner.identity.fingerprint, publicKey: other.identity.publicKey } }, /pinned, usable RSA/],
    // The environment public export matches but the reviewed pinned export does not.
    [{ pinnedPublicKey: other.identity.publicKey }, /pinned, usable RSA/],
    [{ pinnedPublicKey: owner.privateKey }, /exact uppercase OpenPGP fingerprint/],
    [{ identity: { ...owner.identity, fingerprint: other.identity.fingerprint } }, /pinned, usable RSA/],
    [{ identity: expired.identity, pinnedPublicKey: expired.identity.publicKey, privateKey: expired.privateKey, passphrase: expired.passphrase }, /pinned, usable RSA/],
    [{ identity: revoked.identity, pinnedPublicKey: revoked.identity.publicKey, privateKey: revoked.privateKey, passphrase: revoked.passphrase }, /pinned, usable RSA/],
    [{ privateKey: owner.identity.publicKey }, /Invalid protected signing credentials/],
    [{ privateKey: undefined }, /Invalid protected signing credentials/],
    [{ passphrase: '' }, /Invalid protected signing credentials/],
    [{ passphrase: `${owner.passphrase}\n` }, /Invalid protected signing credentials/],
  ];
  for (const [overrides, expected] of cases) {
    await assert.rejects(attempt(overrides), error => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /passphrase-|PRIVATE KEY/);
      return true;
    });
  }
  assert.deepEqual(await survivors('propr-verify-key-'), []);
  assert.deepEqual((await readdir(tmpdir())).filter(name => /^propr-verify-key-(?!test-)/.test(name)), []);
});

test('bad, missing, non-SHA256, wrong-key or altered challenge signatures fail verification', { skip }, async t => {
  const root = await fixture(t);
  const owner = await key(root, 'owner');
  const other = await key(root, 'other');
  const directory = join(root, 'challenge');
  await mkdir(directory, { mode: 0o700 });
  const { challenge, signature } = await signChallenge({ directory, identity: owner.identity,
    privateKey: owner.privateKey, passphrase: owner.passphrase });
  await verifyChallenge({ challenge, signature, identity: owner.identity });
  const armored = await readFile(signature, 'utf8');
  const variant = async (name, bytes) => { const path = join(directory, name); await writeFile(path, bytes); return path; };
  const lines = armored.split('\n');
  const body = lines.findIndex(line => line === '') + 2;
  lines[body] = lines[body].replace(/^(.)/, character => character === 'A' ? 'B' : 'A');
  const sign = (home, passphrase, extra) => run('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback',
    '--passphrase-fd', '0', '--armor', '--detach-sign', ...extra, '--output', '-', challenge], { input: passphrase });
  const sha1 = sign(owner.home, owner.passphrase, ['--digest-algo', 'SHA1']);
  const wrongKey = sign(other.home, other.passphrase, ['--digest-algo', 'SHA256']);
  run('gpgconf', ['--homedir', owner.home, '--kill', 'gpg-agent']);
  run('gpgconf', ['--homedir', other.home, '--kill', 'gpg-agent']);
  for (const candidate of [await variant('tampered.asc', lines.join('\n')), await variant('empty.asc', ''),
    join(directory, 'missing.asc'), await variant('sha1.asc', sha1), await variant('other.asc', wrongKey),
    await variant('truncated.asc', armored.slice(0, armored.length / 2))]) {
    await assert.rejects(verifyChallenge({ challenge, signature: candidate, identity: owner.identity }),
      /Metadata signature is not from|Noncanonical armored signature|tool failed: gpg$|ENOENT/);
  }
  // SHA1 is well formed and from the right key, so it must fail the SHA256 status check itself.
  await assert.rejects(verifyChallenge({ challenge, signature: join(directory, 'sha1.asc'), identity: owner.identity }),
    /Metadata signature is not from the exact valid pinned primary identity/);
  // Missing public key for the signer is a gpg verification failure, never success.
  await assert.rejects(verifyChallenge({ challenge, signature, identity: other.identity }), /tool failed: gpg$/);
  await writeFile(challenge, `${VERIFY_KEY_CHALLENGE}altered\n`);
  await assert.rejects(verifyChallenge({ challenge, signature, identity: owner.identity }), /challenge was altered/);
});

test('receipt is bound to exact run, control revision and full fingerprint inputs', () => {
  const valid = { repository: 'integry/propr', workflowRunId: '12345', controlRevision: 'a'.repeat(40),
    sourceRevision: 'b'.repeat(40), fingerprint: OWNER_FINGERPRINT, challengeSha256: sha256(VERIFY_KEY_CHALLENGE),
    signatureSha256: 'c'.repeat(64) };
  assert.equal(verifyKeyReceipt(valid).fingerprint, OWNER_FINGERPRINT);
  for (const change of [{ workflowRunId: '0' }, { workflowRunId: '12a' }, { workflowRunId: undefined },
    { controlRevision: 'A'.repeat(40) }, { controlRevision: 'a'.repeat(12) }, { sourceRevision: 'main' },
    { fingerprint: OWNER_FINGERPRINT.slice(-16) }, { fingerprint: OWNER_FINGERPRINT.toLowerCase() },
    { challengeSha256: 'c'.repeat(64) }, { signatureSha256: undefined }, { repository: 'propr' }]) {
    assert.throws(() => verifyKeyReceipt({ ...valid, ...change }), /Invalid signing-key verification receipt/);
  }
});

test('CLI enforces the strict production pin, scrubs secrets and writes no receipt on failure', { skip }, async t => {
  const root = await fixture(t);
  const disposable = await key(root, 'disposable');
  const ownerExport = await readFile(PINNED_PUBLIC_EXPORT, 'utf8');
  assert.equal(PINNED_PUBLIC_EXPORT, join(repositoryRoot, 'docs/static/keys/propr-desktop-release.asc'));
  // A recording gpg proves subprocesses receive neither secret value in env or argv.
  const fakeBin = join(root, 'fake-bin');
  const record = join(root, 'gpg-record');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'gpg'), `#!/bin/sh\n{ env; printf '%s\\n' "$@"; } >> '${record}'\nexit 1\n`);
  await chmod(join(fakeBin, 'gpg'), 0o755);
  const args = ['verify-key', '--repository', 'integry/propr', '--workflow-run-id', '12345',
    '--control-revision', 'a'.repeat(40), '--source-revision', 'b'.repeat(40)];
  let index = 0;
  const cli = ({ fingerprint, publicKey, privateKey = disposable.privateKey, passphrase = disposable.passphrase,
    path = process.env.PATH, extra = [] }) => {
    const output = join(root, `receipt-${index++}.json`);
    const env = { PATH: path, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '', HOME: root,
      PROPR_DESKTOP_RPM_PRIVATE_KEY: privateKey, PROPR_DESKTOP_RPM_PASSPHRASE: passphrase,
      PROPR_DESKTOP_RPM_PUBLIC_KEY: publicKey };
    if (fingerprint !== undefined) env.PROPR_DESKTOP_RPM_FINGERPRINT = fingerprint;
    const result = spawnSync(process.execPath, [script, ...args, '--output', output, ...extra], { env, encoding: 'utf8', timeout: 120_000 });
    return { ...result, output };
  };
  const cases = [
    [{ fingerprint: disposable.identity.fingerprint, publicKey: disposable.identity.publicKey }, /differs from owner pin/],
    [{ fingerprint: OWNER_FINGERPRINT.toLowerCase(), publicKey: ownerExport }, /differs from owner pin/],
    [{ fingerprint: OWNER_FINGERPRINT.slice(-16), publicKey: ownerExport }, /differs from owner pin/],
    [{ fingerprint: undefined, publicKey: ownerExport }, /differs from owner pin/],
    [{ fingerprint: OWNER_FINGERPRINT, publicKey: disposable.identity.publicKey }, /pinned, usable RSA/],
    // The real pinned public export with a disposable private key is a pair mismatch.
    [{ fingerprint: OWNER_FINGERPRINT, publicKey: ownerExport }, /Metadata private key mismatch/],
    [{ fingerprint: OWNER_FINGERPRINT, publicKey: ownerExport, path: `${fakeBin}:${process.env.PATH}` }, /tool failed: gpg$/],
    [{ fingerprint: OWNER_FINGERPRINT, publicKey: ownerExport, extra: ['--unsigned-run-id', '1'] }, /Expected verify-key/],
  ];
  for (const [options, expected] of cases) {
    const result = cli(options);
    assert.equal(result.status, 1);
    assert.match(result.stderr.trim(), new RegExp(`^Signing-key verification failed: .*${expected.source}`));
    assert.equal(result.stdout, '');
    for (const output of [result.stderr, result.stdout]) {
      assert.doesNotMatch(output, /PRIVATE KEY|disposable-disposable-passphrase/);
    }
    await assert.rejects(access(result.output));
  }
  const recorded = await readFile(record, 'utf8');
  assert.match(recorded, /--import/);
  assert.doesNotMatch(recorded, /PROPR_DESKTOP_RPM_PRIVATE_KEY|PROPR_DESKTOP_RPM_PASSPHRASE|PRIVATE KEY|disposable-disposable-passphrase/);
  assert.deepEqual(await survivors('propr-verify-key-'), []);
});

test('cleanup must remove owned homes and stop owned agents before success', { skip: linuxOnly }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'propr-verify-key-cleanup-'));
  const homes = join(root, 'homes');
  await mkdir(homes);
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const owned = (ignoreTerm = false) => {
    const child = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`,
      join(homes, 'propr-rpm-key-agent')], { stdio: 'ignore' });
    children.push(child);
    return new Promise(started => child.once('spawn', started));
  };
  await confirmCleanup(root, homes);
  // A terminable owned agent is stopped; an unrelated process is never signalled.
  await owned();
  await confirmCleanup(root, homes);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
  await mkdir(join(homes, 'propr-rpm-key-left'));
  await assert.rejects(confirmCleanup(root, homes), /left a temporary GnuPG home/);
  await rm(join(homes, 'propr-rpm-key-left'), { recursive: true });
  await owned(true);
  await new Promise(ready => setTimeout(ready, 200));
  await assert.rejects(confirmCleanup(root, homes), /left a temporary GnuPG process running/);
});
