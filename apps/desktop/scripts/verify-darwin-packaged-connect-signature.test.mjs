import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { rootCertificates } from 'node:tls';
import {
  DARWIN_SIGNING_DIAGNOSTICS,
  classifyDarwinSigningFailure,
} from './sign-darwin-packaged-connect.mjs';
import {
  assertDarwinSigningEvidence,
  inspectDarwinSigningEvidence,
  readExtractedCertificateFingerprints,
} from './verify-darwin-packaged-connect-signature.mjs';

const fingerprint = 'A'.repeat(40);
const requirementFor = certificateSha1 => (
  `designated => identifier "dev.propr.desktop" and certificate leaf = H"${certificateSha1}"`
);
const validEvidence = (certificateSha1 = fingerprint) => ({
  expectedCertificateSha1: certificateSha1,
  certificateFingerprints: [certificateSha1],
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    'Identifier=dev.propr.desktop',
  ].join('\n'),
  designatedRequirement: requirementFor(certificateSha1),
});

const selfSignedCertificate = rootCertificates
  .map(certificate => new X509Certificate(certificate))
  .find(certificate => certificate.checkIssued(certificate));
assert.ok(selfSignedCertificate, 'Node must provide a self-signed certificate test fixture');
const selfSignedFingerprint = createHash('sha1')
  .update(selfSignedCertificate.raw)
  .digest('hex')
  .toUpperCase();

const withCertificateDirectory = async callback => {
  const certificateDirectory = await mkdtemp(join(tmpdir(), 'propr-codesign-evidence-'));
  const certificatePrefix = join(certificateDirectory, 'codesign-establish-certificate-');
  try {
    await callback({ certificateDirectory, certificatePrefix });
  } finally {
    await rm(certificateDirectory, { recursive: true, force: true });
  }
};

const isDiagnostic = diagnostic => error => (
  classifyDarwinSigningFailure(error) === diagnostic
);

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('uses bounded codesign extraction, requirement, and strict deep verification commands', async () => {
    await withCertificateDirectory(async ({ certificateDirectory }) => {
      const calls = [];
      const application = '/private/tmp/propr-desktop.app';
      const evidence = await inspectDarwinSigningEvidence({
        mode: 'establish',
        application,
        certificateDirectory,
        runCommand: async options => {
          calls.push(options);
          const extractionArgument = options.arguments
            .find(argument => argument.startsWith('--extract-certificates='));
          if (extractionArgument) {
            const certificatePrefix = extractionArgument.slice('--extract-certificates='.length);
            await writeFile(`${certificatePrefix}0`, selfSignedCertificate.raw);
            return { stdout: '', stderr: 'Identifier=dev.propr.desktop\n' };
          }
          if (options.arguments.includes('-r-')) {
            return { stdout: '', stderr: `${requirementFor(selfSignedFingerprint)}\n` };
          }
          return { stdout: '', stderr: '' };
        },
      });

      assert.equal(assertDarwinSigningEvidence({
        expectedCertificateSha1: selfSignedFingerprint,
        ...evidence,
      }), requirementFor(selfSignedFingerprint));
      assert.deepEqual(calls.map(call => call.arguments), [
        [
          '--display', '--verbose=4',
          `--extract-certificates=${join(certificateDirectory, 'codesign-establish-certificate-')}`,
          application,
        ],
        ['-d', '-r-', application],
        ['--verify', '--deep', '--strict', application],
      ]);
      for (const call of calls) {
        assert.equal(call.executable, '/usr/bin/codesign');
        assert.equal(call.timeoutMs, 20_000);
        assert.equal(call.terminationGraceMs, 1_000);
        assert.equal(call.maxOutputBytes, 256 * 1024);
        assert.equal(call.forwardOutput, false);
      }
    });
  });

  test('accepts exactly one matching self-signed certificate without Authority output', async () => {
    await withCertificateDirectory(async ({ certificateDirectory, certificatePrefix }) => {
      await writeFile(`${certificatePrefix}0`, selfSignedCertificate.raw);
      const certificateFingerprints = await readExtractedCertificateFingerprints({
        certificateDirectory,
        certificatePrefix,
      });
      assert.deepEqual(certificateFingerprints, [selfSignedFingerprint]);

      const evidence = {
        ...validEvidence(selfSignedFingerprint),
        certificateFingerprints,
      };
      const requirement = requirementFor(selfSignedFingerprint);
      assert.equal(assertDarwinSigningEvidence(evidence), requirement);
      assert.equal(assertDarwinSigningEvidence({
        ...evidence,
        previousDesignatedRequirement: `${requirement}\n`,
      }), requirement);
    });
  });

  test('fails closed when extracted certificate evidence is missing', async () => {
    await withCertificateDirectory(async ({ certificateDirectory, certificatePrefix }) => {
      await assert.rejects(readExtractedCertificateFingerprints({
        certificateDirectory,
        certificatePrefix,
      }), isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain));
    });
    assert.throws(
      () => assertDarwinSigningEvidence({
        ...validEvidence(), certificateFingerprints: [],
      }),
      isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain),
    );
  });

  test('fails closed when extracted certificate evidence is ambiguous', async () => {
    await withCertificateDirectory(async ({ certificateDirectory, certificatePrefix }) => {
      await Promise.all([
        writeFile(`${certificatePrefix}0`, selfSignedCertificate.raw),
        writeFile(`${certificatePrefix}1`, selfSignedCertificate.raw),
      ]);
      await assert.rejects(readExtractedCertificateFingerprints({
        certificateDirectory,
        certificatePrefix,
      }), isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain));
    });
    assert.throws(
      () => assertDarwinSigningEvidence({
        ...validEvidence(), certificateFingerprints: [fingerprint, 'B'.repeat(40)],
      }),
      isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain),
    );
  });

  test('fails closed when the extracted leaf fingerprint is mismatched', () => {
    assert.throws(
      () => assertDarwinSigningEvidence({
        ...validEvidence(), certificateFingerprints: ['B'.repeat(40)],
      }),
      isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain),
    );
  });

  test('rejects an ad-hoc signature even when the other evidence matches', () => {
    assert.throws(
      () => assertDarwinSigningEvidence({
        ...validEvidence(), signatureDetails: 'Identifier=dev.propr.desktop\nSignature=adhoc',
      }),
      isDiagnostic(DARWIN_SIGNING_DIAGNOSTICS.codesignFailure),
    );
  });

  test('rejects identifiers and requirements not pinned to the generated certificate', () => {
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(), signatureDetails: 'Identifier=dev.other.desktop',
    }));
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(),
      designatedRequirement: 'designated => identifier "dev.propr.desktop" and anchor trusted',
    }));
  });

  test('rejects any signing identity change after the pair and reprobe launches', () => {
    assert.throws(() => assertDarwinSigningEvidence({
      ...validEvidence(),
      previousDesignatedRequirement: `${requirementFor('B'.repeat(40))}\n`,
    }));
  });
});
