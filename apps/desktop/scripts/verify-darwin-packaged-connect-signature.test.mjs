import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, rm, symlink, writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { rootCertificates } from 'node:tls';
import {
  classifyDarwinSigningFailure,
  darwinSigningDiagnosticLine,
} from './sign-darwin-packaged-connect.mjs';
import {
  DARWIN_VERIFICATION_DIAGNOSTICS,
  assertDarwinSigningEvidence,
  inspectDarwinSigningEvidence,
  verifyDarwinPackagedConnectSignature,
} from './verify-darwin-packaged-connect-signature.mjs';

const REQUIRED_IDENTIFIER = 'dev.propr.desktop';
const application = '/private/tmp/propr-desktop.app';
const otherFingerprint = 'B'.repeat(40);
const requirementExpressionFor = certificateSha1 => (
  `identifier "${REQUIRED_IDENTIFIER}" and certificate leaf = H"${certificateSha1}"`
);
const requirementFor = certificateSha1 => (
  `designated => ${requirementExpressionFor(certificateSha1)}`
);
const fingerprintFor = certificate => createHash('sha1')
  .update(certificate.raw)
  .digest('hex')
  .toUpperCase();

const parsedRootCertificates = rootCertificates.map(certificate => new X509Certificate(certificate));
const selfSignedCertificate = parsedRootCertificates
  .find(certificate => certificate.checkIssued(certificate));
assert.ok(selfSignedCertificate, 'Node must provide a self-signed certificate test fixture');
const selfSignedFingerprint = fingerprintFor(selfSignedCertificate);
const mismatchedCertificate = parsedRootCertificates
  .find(certificate => fingerprintFor(certificate) !== selfSignedFingerprint);
assert.ok(mismatchedCertificate, 'Node must provide a mismatched certificate test fixture');

const validEvidence = (overrides = {}) => ({
  expectedCertificateSha1: selfSignedFingerprint,
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    `Identifier=${REQUIRED_IDENTIFIER}`,
    'Signature size=1024',
  ].join('\n'),
  designatedRequirement: `${requirementFor(selfSignedFingerprint)}\n`,
  ...overrides,
});

const createCodesignSimulator = (overrides = {}) => {
  const fixture = {
    signed: true,
    adHoc: false,
    identifier: REQUIRED_IDENTIFIER,
    certificate: selfSignedCertificate,
    leafFile: 'regular',
    additionalCertificate: false,
    designatedRequirement: `${requirementFor(selfSignedFingerprint)}\n`,
    strictValid: true,
    ...overrides,
  };
  const calls = [];
  const runCommand = async options => {
    calls.push(options);
    const arguments_ = options.arguments;
    if (arguments_[0] === '-d' && arguments_[1] === '--verbose=4') {
      if (!fixture.signed) throw new Error(`unsigned secret ${application}`);
      return {
        stdout: '',
        stderr: [
          `Identifier=${fixture.identifier}`,
          fixture.adHoc ? 'Signature=adhoc' : 'Signature size=1024',
        ].join('\n'),
      };
    }
    if (arguments_[0] === '-d' && arguments_[1] === '--extract-certificates') {
      const prefix = arguments_[2];
      if (fixture.leafFile === 'regular') {
        await writeFile(`${prefix}0`, fixture.certificate.raw);
      } else if (fixture.leafFile === 'directory') {
        await mkdir(`${prefix}0`);
      } else if (fixture.leafFile === 'symlink') {
        const target = join(dirname(prefix), 'certificate-target.der');
        await writeFile(target, fixture.certificate.raw);
        await symlink(target, `${prefix}0`);
      } else if (fixture.leafFile === 'malformed') {
        await writeFile(`${prefix}0`, 'not a certificate');
      }
      if (fixture.additionalCertificate) {
        await writeFile(`${prefix}1`, fixture.certificate.raw);
      }
      return { stdout: '', stderr: '' };
    }
    if (arguments_[0] === '-d' && arguments_[1] === '-r-') {
      if (!fixture.signed) throw new Error(`missing requirement ${application}`);
      return { stdout: '', stderr: fixture.designatedRequirement };
    }
    if (arguments_.includes('--strict')) {
      if (!fixture.strictValid) throw new Error(`strict failure ${application}`);
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected simulated codesign invocation');
  };
  return { calls, runCommand };
};

const withPrivateEvidencePaths = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-signature-evidence-'));
  try {
    await callback({
      proofPath: join(directory, 'designated-requirement.txt'),
      initialCertificatePrefix: join(directory, 'initial-certificate-'),
      stableCertificatePrefix: join(directory, 'stable-certificate-'),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const isDiagnostic = diagnostic => error => {
  assert.equal(classifyDarwinSigningFailure(error), diagnostic);
  assert.equal(
    darwinSigningDiagnosticLine(error),
    `DARWIN_PACKAGED_CONNECT_DIAGNOSTIC:${diagnostic}\n`,
  );
  assert.doesNotMatch(darwinSigningDiagnosticLine(error), /private|[A-F0-9]{40}/u);
  return true;
};

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('uses separate exact bounded argv for display, extraction, requirement, and strict checks', async () => {
    await withPrivateEvidencePaths(async ({ initialCertificatePrefix }) => {
      const simulator = createCodesignSimulator();
      const evidence = await inspectDarwinSigningEvidence({
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        certificatePrefix: initialCertificatePrefix,
        runCommand: simulator.runCommand,
      });

      assert.equal(
        assertDarwinSigningEvidence({
          expectedCertificateSha1: selfSignedFingerprint,
          ...evidence,
        }),
        `${requirementFor(selfSignedFingerprint)}\n`,
      );
      assert.deepEqual(simulator.calls.map(call => call.arguments), [
        ['-d', '--verbose=4', application],
        ['-d', '--extract-certificates', initialCertificatePrefix, application],
        ['-d', '-r-', application],
        ['--verify', '--deep', '--strict', application],
      ]);
      assert.ok(!simulator.calls.some(call => call.arguments.some(
        argument => argument === '-R' || argument.startsWith('-R='),
      )));
      for (const call of simulator.calls) {
        assert.equal(call.executable, '/usr/bin/codesign');
        assert.equal(call.timeoutMs, 20_000);
        assert.equal(call.terminationGraceMs, 1_000);
        assert.equal(call.maxOutputBytes, 256 * 1024);
        assert.equal(call.forwardOutput, false);
      }
    });
  });

  test('accepts exactly one parsed self-signed leaf and byte-identical requirements', async () => {
    await withPrivateEvidencePaths(async ({
      proofPath, initialCertificatePrefix, stableCertificatePrefix,
    }) => {
      const displayedRequirement = `${requirementFor(selfSignedFingerprint.toLowerCase())}\n`;
      await verifyDarwinPackagedConnectSignature({
        mode: 'establish',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        certificatePrefix: initialCertificatePrefix,
        runCommand: createCodesignSimulator({
          designatedRequirement: displayedRequirement,
        }).runCommand,
      });
      assert.equal(
        await readFile(proofPath, 'utf8'),
        displayedRequirement,
      );
      await verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        certificatePrefix: stableCertificatePrefix,
        runCommand: createCodesignSimulator({
          designatedRequirement: displayedRequirement,
        }).runCommand,
      });
    });
  });

  test('rejects a mismatched extracted leaf, ad-hoc code, and the wrong identifier', async () => {
    for (const fixture of [
      { certificate: mismatchedCertificate },
      { adHoc: true },
      { identifier: 'dev.other.desktop' },
    ]) {
      await withPrivateEvidencePaths(async ({ proofPath, initialCertificatePrefix }) => {
        await assert.rejects(verifyDarwinPackagedConnectSignature({
          mode: 'establish',
          application,
          expectedCertificateSha1: selfSignedFingerprint,
          proofPath,
          certificatePrefix: initialCertificatePrefix,
          runCommand: createCodesignSimulator(fixture).runCommand,
        }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
      });
    }
  });

  test('requires exactly prefix0 as a parsed regular file', async () => {
    for (const fixture of [
      { leafFile: 'missing' },
      { additionalCertificate: true },
      { leafFile: 'directory' },
      { leafFile: 'symlink' },
      { leafFile: 'malformed' },
    ]) {
      await withPrivateEvidencePaths(async ({ initialCertificatePrefix }) => {
        await assert.rejects(inspectDarwinSigningEvidence({
          application,
          expectedCertificateSha1: selfSignedFingerprint,
          certificatePrefix: initialCertificatePrefix,
          runCommand: createCodesignSimulator(fixture).runCommand,
        }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
      });
    }
  });

  test('unsigned code fails at signature display with a fixed secret-safe subcode', async () => {
    await withPrivateEvidencePaths(async ({ initialCertificatePrefix }) => {
      await assert.rejects(inspectDarwinSigningEvidence({
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        certificatePrefix: initialCertificatePrefix,
        runCommand: createCodesignSimulator({ signed: false }).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure));
    });
  });

  test('wraps every native verifier operation in its distinct fixed subcode', async () => {
    const diagnostics = [
      DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.certificateExtractionFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.embeddedRequirementFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure,
    ];
    for (const [failureIndex, diagnostic] of diagnostics.entries()) {
      await withPrivateEvidencePaths(async ({ initialCertificatePrefix }) => {
        let invocation = 0;
        const simulator = createCodesignSimulator();
        await assert.rejects(inspectDarwinSigningEvidence({
          application,
          expectedCertificateSha1: selfSignedFingerprint,
          certificatePrefix: initialCertificatePrefix,
          runCommand: async options => {
            if (invocation++ === failureIndex) {
              throw new Error(`private failure ${application} ${selfSignedFingerprint}`);
            }
            return simulator.runCommand(options);
          },
        }), isDiagnostic(diagnostic));
      });
    }
  });

  test('rejects missing or ambiguous display and non-exact requirement evidence', () => {
    for (const evidence of [
      validEvidence({ signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}` }),
      validEvidence({ signatureDetails: 'Signature size=1024' }),
      validEvidence({
        signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nIdentifier=${REQUIRED_IDENTIFIER}\nSignature size=1024`,
      }),
      validEvidence({ designatedRequirement: '' }),
      validEvidence({ designatedRequirement: `${requirementFor(selfSignedFingerprint)}\r\n` }),
      validEvidence({ designatedRequirement: `${requirementFor(selfSignedFingerprint)}\nextra\n` }),
      validEvidence({ designatedRequirement: `${requirementFor(otherFingerprint)}\n` }),
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(evidence),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
      );
    }
  });

  test('rejects ad-hoc evidence even if the other mocked operations report success', () => {
    assert.throws(
      () => assertDarwinSigningEvidence(validEvidence({
        signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nSignature=adhoc`,
      })),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
    );
  });

  test('requires byte-exact embedded designated-requirement stability after reprobe', async () => {
    await withPrivateEvidencePaths(async ({
      proofPath, initialCertificatePrefix, stableCertificatePrefix,
    }) => {
      await verifyDarwinPackagedConnectSignature({
        mode: 'establish',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        certificatePrefix: initialCertificatePrefix,
        runCommand: createCodesignSimulator().runCommand,
      });
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        certificatePrefix: stableCertificatePrefix,
        runCommand: createCodesignSimulator({
          designatedRequirement: `${requirementFor(selfSignedFingerprint.toLowerCase())}\n`,
        }).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
    });
  });

  test('requires extraction prefixes to share the private proof directory', async () => {
    await withPrivateEvidencePaths(async ({ proofPath }) => {
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'establish',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        certificatePrefix: join(tmpdir(), 'outside-certificate-'),
        runCommand: createCodesignSimulator().runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
    });
  });
});
