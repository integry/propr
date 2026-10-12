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
