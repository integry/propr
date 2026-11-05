import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SIGNED_RPM_ACCEPTANCE_CHECKS, validateSignedRpmAcceptanceEvidence } from './signed-rpm-acceptance-evidence.mjs';
const expected = { sourceRevision: 'a'.repeat(40), rpmSha256: 'b'.repeat(64), signingRunId: '123', fingerprint: 'C'.repeat(40) };
const passed = () => ({ ...expected, schemaVersion: 1, status: 'passed', target: 'linux-x64-rpm-opensuse',
  checks: Object.fromEntries(SIGNED_RPM_ACCEPTANCE_CHECKS.map(key => [key, true])) });

test('publication accepts complete exact source, signed bytes, key and signing-run identity', () => {
  assert.equal(validateSignedRpmAcceptanceEvidence(passed(), expected).status, 'passed');
});

test('publication fails closed on missing, failed, foreign, oversized-schema and partial evidence', () => {
  const invalid = [undefined, null, {}, { ...passed(), status: 'failed' }, { ...passed(), target: 'linux-arm64-rpm-opensuse' },
    { ...passed(), token: 'must-not-be-in-evidence' }, { ...passed(), checks: {} }, { ...passed(), schemaVersion: 2 }];
  for (const key of Object.keys(expected)) invalid.push({ ...passed(), [key]: '0' });
  for (const key of SIGNED_RPM_ACCEPTANCE_CHECKS) {
    invalid.push({ ...passed(), checks: { ...passed().checks, [key]: false } });
    const missing = passed(); delete missing.checks[key]; invalid.push(missing);
  }
  for (const evidence of invalid) assert.throws(() => validateSignedRpmAcceptanceEvidence(evidence, expected), /acceptance evidence/);
});

import { spawnSync } from 'node:child_process';
import { chmod, chown, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifySignedRpmEvidenceArtifact, readSignedRpmEvidenceZip } from './signed-rpm-acceptance-evidence.mjs';
const archive = (evidence, name = 'signed-rpm-acceptance.json') => {
  const result = spawnSync('python3', ['-c', 'import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED); z.writestr(sys.argv[1],sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())', name], { input: JSON.stringify(evidence) });
  assert.equal(result.status, 0);
  return result.stdout;
};
const authoritative = bytes => ({ id: 42, expired: false, workflow_run: { id: 123 }, name: 'propr-desktop-installed-signed-rpm-123',
  size_in_bytes: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
const verifyArtifact = (evidence, bytes, artifacts = [authoritative(bytes)]) => verifySignedRpmEvidenceArtifact({
  signingRunId: '123', evidence, json: async () => ({ artifacts }), request: async () => new Response(bytes),
});

test('acceptance artifact ZIP download uses the GitHub API Accept header', async () => {
  const evidence = passed();
  const bytes = archive(evidence);
  let downloads = 0;
  await verifySignedRpmEvidenceArtifact({
    signingRunId: '123', evidence,
    json: async path => {
      assert.equal(path, '/actions/runs/123/artifacts?per_page=100&page=1');
      return { artifacts: [authoritative(bytes)] };
    },
    request: async (path, options) => {
      assert.equal(path, '/actions/artifacts/42/zip');
      if (options?.headers?.Accept !== 'application/vnd.github+json') {
        throw new Error('GitHub API artifact ZIP download failed with HTTP 415: Unsupported Accept header');
      }
      downloads++;
      return new Response(bytes);
    },
  });
  assert.equal(downloads, 1);
});

test('publication verifies the retained signing-run archive rather than trusting local passed JSON', async () => {
  const evidence = passed();
  const bytes = archive(evidence);
  assert.deepEqual(await readSignedRpmEvidenceZip(bytes), evidence);
  await verifyArtifact(evidence, bytes);
  await assert.rejects(verifyArtifact(evidence, bytes, []), /authoritative/);
  await assert.rejects(verifyArtifact(evidence, bytes, [authoritative(bytes), authoritative(bytes)]), /authoritative/);
  await assert.rejects(verifyArtifact(evidence, bytes, [{ ...authoritative(bytes), expired: true }]), /authoritative/);
  await assert.rejects(verifyArtifact(evidence, bytes, [{ ...authoritative(bytes), workflow_run: { id: 999 } }]), /authoritative/);
  await assert.rejects(verifyArtifact(evidence, bytes, [{ ...authoritative(bytes), digest: `sha256:${'0'.repeat(64)}` }]), /digest mismatch/);
  await assert.rejects(verifyArtifact({ ...evidence, sourceRevision: 'd'.repeat(40) }, bytes), /differs from authoritative/);
  await assert.rejects(verifyArtifact(evidence, archive(evidence, '../signed-rpm-acceptance.json')), /archive/);
});

test('bounded archive decoder rejects truncated and excessive decompressed evidence', async () => {
  await assert.rejects(readSignedRpmEvidenceZip(archive(passed()).subarray(0, 40)), /archive/);
  await assert.rejects(readSignedRpmEvidenceZip(archive({ padding: 'x'.repeat(17000) })), /archive/);
});

const exportFunction = async () => {
  const source = await readFile(new URL('./test-signed-installed-rpm.sh', import.meta.url), 'utf8');
  return source.slice(source.indexOf('export_evidence() {'), source.indexOf('\ntest "$(uname -m)"'));
};

test('signed RPM runner passes its host identity and keeps evidence directories private', async () => {
  const runner = await readFile(new URL('./run-signed-installed-rpm-acceptance.mjs', import.meta.url), 'utf8');
  const harness = await readFile(new URL('./test-signed-installed-rpm.sh', import.meta.url), 'utf8');
  assert.match(runner, /PROPR_RPM_HOST_UID=\$\{process.getuid\(\)\}/);
  assert.match(runner, /PROPR_RPM_HOST_GID=\$\{process.getgid\(\)\}/);
  assert.match(runner, /mkdir\(join\(directory, 'evidence'\), \{ mode: 0o700 \}\)/);
  assert.match(runner, /mkdir\(resolve\(outputDirectory\), \{ mode: 0o700 \}\)/);
  assert.match(harness, /export_evidence \/tmp \/evidence/);
  assert.doesNotMatch(harness, /^\s*(?:chown[^\n]*\/evidence|cp -a\s)/m);
});

const exerciseExport = async ({ rootful = false, partial = false }) => {
  // The distinct host UID must be able to traverse the fixture's ancestors.
  // CI's TMPDIR can be private to root; keep the Linux rootful fixture directly
  // under /tmp without changing permissions on the runner's private directory.
  const directory = await mkdtemp(join(rootful ? '/tmp' : tmpdir(), 'signed-rpm-export-'));
  const source = join(directory, 'source');
  const destination = join(directory, 'evidence');
  const uid = rootful ? 1001 : process.getuid();
  const gid = rootful ? 1002 : process.getgid();
  try {
    await mkdir(source, { mode: 0o700 });
    await mkdir(destination, { mode: 0o700 });
    for (const name of ['desktop-acceptance-artifacts', 'pairing-evidence']) {
      await mkdir(join(source, name), { mode: 0o700 });
      await writeFile(join(source, name, 'private.json'), '{}\n', { mode: 0o600 });
      await writeFile(join(source, name, 'screenshot.png'), 'synthetic screenshot', { mode: 0o644 });
    }
    if (!partial) await writeFile(join(source, 'browser.json'), '{"browserApproval":true}\n', { mode: 0o600 });
    if (rootful) {
      await chmod(directory, 0o755);
      await chown(destination, uid, gid);
      for (const name of ['desktop-acceptance-artifacts', 'pairing-evidence']) {
        for (const entry of [name, `${name}/private.json`, `${name}/screenshot.png`]) {
          await chown(join(source, entry), 1000, 1000);
        }
      }
      if (!partial) await chown(join(source, 'browser.json'), 1000, 1000);
    }
    // Unprivileged runs exercise the real tar boundary. Only identity switching
    // is substituted; the rootful regression below exercises setpriv itself.
    const switchIdentity = rootful ? '' : `setpriv() {
      test "$1" = "--reuid=$PROPR_RPM_HOST_UID"
      test "$2" = "--regid=$PROPR_RPM_HOST_GID"
      test "$3" = --clear-groups
      shift 3
      "$@"
    }`;
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c',
      `${await exportFunction()}\n${switchIdentity}\nexport_evidence "$1" "$2"`, 'bash', source, destination], {
      env: { ...process.env, PROPR_RPM_HOST_UID: String(uid), PROPR_RPM_HOST_GID: String(gid) }, encoding: 'utf8',
    });
    if (partial) assert.notEqual(result.status, 0, 'missing browser evidence must fail export');
    else assert.equal(result.status, 0, result.stderr);
    for (const name of ['desktop-acceptance-artifacts', 'pairing-evidence']) {
      for (const entry of [name, `${name}/private.json`, `${name}/screenshot.png`]) {
        const info = await stat(join(destination, entry));
        assert.equal(info.uid, uid);
        assert.equal(info.gid, gid);
        assert.equal(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600);
      }
    }
    if (!partial) {
      const browser = await stat(join(destination, 'browser.json'));
      assert.equal(browser.uid, uid);
      assert.equal(browser.gid, gid);
      assert.equal(browser.mode & 0o777, 0o600);
    }
    // Read, retain and remove exports with host authority, including partial
    // directories left behind when the producer exits unsuccessfully.
    const consume = `const [directory, partial] = process.argv.slice(1);
      const { readFile, cp, rm } = await import('node:fs/promises');
      if (partial !== 'true') JSON.parse(await readFile(directory + '/evidence/browser.json', 'utf8'));
      await cp(directory + '/evidence/pairing-evidence', directory + '/retained', { recursive: true });
      await rm(directory + '/evidence', { recursive: true });
      await rm(directory + '/retained', { recursive: true });`;
    if (rootful) {
      // The host's temporary parent is also owned by the invoking host.
      await chown(directory, uid, gid);
      const consumed = spawnSync('setpriv', [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups',
        process.execPath, '--input-type=module', '-e', consume, directory, String(partial)], { encoding: 'utf8' });
      assert.equal(consumed.status, 0, consumed.stderr);
    } else {
      if (!partial) JSON.parse(await readFile(join(destination, 'browser.json'), 'utf8'));
      await cp(join(destination, 'pairing-evidence'), join(directory, 'retained'), { recursive: true });
      await rm(destination, { recursive: true });
      await rm(join(directory, 'retained'), { recursive: true });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
};

test('private evidence export is readable and removable after success and partial failure', {
  skip: process.platform !== 'linux' ? 'Requires the native Linux tar export boundary' : false,
}, async () => {
  await exerciseExport({});
  await exerciseExport({ partial: true });
});

test('rootful export returns UID-1000 private evidence to host UID 1001/GID 1002', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? 'Requires Linux root for distinct-UID export/read/cleanup' : false,
}, async () => {
  await exerciseExport({ rootful: true });
  await exerciseExport({ rootful: true, partial: true });
});
