import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
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
const keychain = '/private/tmp/propr-smoke.keychain-db';
const fingerprint = 'A'.repeat(40);
const otherFingerprint = 'B'.repeat(40);
const requirementExpressionFor = certificateSha1 => (
  `identifier "${REQUIRED_IDENTIFIER}" and certificate leaf = H"${certificateSha1}"`
);
const requirementFor = certificateSha1 => (
  `designated => ${requirementExpressionFor(certificateSha1)}`
);

const validEvidence = (overrides = {}) => ({
  expectedCertificateSha1: fingerprint,
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    `Identifier=${REQUIRED_IDENTIFIER}`,
    'Signature size=1024',
  ].join('\n'),
  designatedRequirement: `${requirementFor(fingerprint)}\n`,
  ...overrides,
});

const createVerifierSimulator = (overrides = {}) => {
  const fixture = {
    signed: true,
    certificateFingerprints: [fingerprint],
    identifier: REQUIRED_IDENTIFIER,
    signatureLine: 'Signature size=1024',
    designatedRequirement: `${requirementFor(fingerprint)}\n`,
    strictValid: true,
    ...overrides,
  };
  const calls = [];
  const runCommand = async options => {
    calls.push(options);
    const arguments_ = options.arguments;
    if (options.executable === '/usr/bin/security') {
      assert.deepEqual(arguments_, ['find-certificate', '-a', '-Z', keychain]);
      return {
        stdout: fixture.certificateFingerprints
          .map(value => `SHA-1 hash: ${value}`)
          .join('\n'),
        stderr: '',
      };
    }
    if (arguments_[0] === '-d' && arguments_[1] === '--verbose=4') {
      if (!fixture.signed) throw new Error(`unsigned secret ${application}`);
      return {
        stdout: '',
        stderr: [
          `Identifier=${fixture.identifier}`,
          fixture.signatureLine,
        ].filter(value => value !== null).join('\n'),
      };
    }
    if (arguments_[0] === '-d' && arguments_[1] === '-r-') {
      return { stdout: '', stderr: fixture.designatedRequirement };
    }
    if (arguments_.includes('--strict')) {
      if (!fixture.strictValid) throw new Error(`strict failure ${application}`);
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected simulated verifier invocation');
  };
  return { calls, runCommand };
};

const withPrivateProofPath = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-signature-evidence-'));
  try {
    await callback(join(directory, 'designated-requirement.txt'));
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

const verifyEstablish = async (proofPath, fixture = {}) => {
  const simulator = createVerifierSimulator(fixture);
  await verifyDarwinPackagedConnectSignature({
    mode: 'establish',
    application,
    expectedCertificateSha1: fingerprint,
    proofPath,
    keychain,
    runCommand: simulator.runCommand,
  });
  return simulator;
};

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('uses the portable bounded certificate, display, requirement, and strict proof chain', async () => {
    const simulator = createVerifierSimulator();
    const evidence = await inspectDarwinSigningEvidence({
      application,
      keychain,
      expectedCertificateSha1: fingerprint,
      runCommand: simulator.runCommand,
    });

    assert.equal(
      assertDarwinSigningEvidence({ expectedCertificateSha1: fingerprint, ...evidence }),
      `${requirementFor(fingerprint)}\n`,
    );
    assert.deepEqual(simulator.calls.map(call => [call.executable, call.arguments]), [
      ['/usr/bin/security', ['find-certificate', '-a', '-Z', keychain]],
      ['/usr/bin/codesign', ['-d', '--verbose=4', application]],
      ['/usr/bin/codesign', ['-d', '-r-', application]],
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', application]],
    ]);
    assert.ok(!simulator.calls.some(call => call.arguments.some(argument => (
      argument === '-R'
      || argument.startsWith('-R=')
      || argument === '--extract-certificates'
    ))));
    for (const call of simulator.calls) {
      assert.equal(call.timeoutMs, 20_000);
      assert.equal(call.terminationGraceMs, 1_000);
      assert.equal(call.maxOutputBytes, 256 * 1024);
      assert.equal(call.forwardOutput, false);
    }
  });

  test('accepts exactly the generated keychain fingerprint and byte-identical requirements', async () => {
    await withPrivateProofPath(async proofPath => {
      const displayedRequirement = `${requirementFor(fingerprint.toLowerCase())}\n`;
      await verifyEstablish(proofPath, { designatedRequirement: displayedRequirement });
      assert.equal(await readFile(proofPath, 'utf8'), displayedRequirement);
      await verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: fingerprint,
        proofPath,
        keychain,
        runCommand: createVerifierSimulator({
          designatedRequirement: displayedRequirement,
        }).runCommand,
      });
    });
  });

  test('rejects duplicate and wrong keychain fingerprints', async () => {
    for (const certificateFingerprints of [
      [fingerprint, fingerprint],
      [fingerprint, otherFingerprint],
      [otherFingerprint],
    ]) {
      await withPrivateProofPath(async proofPath => {
        await assert.rejects(
          verifyEstablish(proofPath, { certificateFingerprints }),
          isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
        );
      });
    }
  });

  test('rejects ad-hoc, zero-size, and missing signature evidence', async () => {
    for (const signatureLine of ['Signature=adhoc', 'Signature size=0', null]) {
      await withPrivateProofPath(async proofPath => {
        await assert.rejects(
          verifyEstablish(proofPath, { signatureLine }),
          isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
        );
      });
    }
  });

  test('rejects the wrong identifier and wrong embedded leaf', async () => {
    for (const fixture of [
      { identifier: 'dev.other.desktop' },
      { designatedRequirement: `${requirementFor(otherFingerprint)}\n` },
    ]) {
      await withPrivateProofPath(async proofPath => {
        await assert.rejects(
          verifyEstablish(proofPath, fixture),
          isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
        );
      });
    }
  });

  test('requires byte-exact embedded designated-requirement stability after reprobe', async () => {
    await withPrivateProofPath(async proofPath => {
      await verifyEstablish(proofPath);
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: fingerprint,
        proofPath,
        keychain,
        runCommand: createVerifierSimulator({
          designatedRequirement: `${requirementFor(fingerprint.toLowerCase())}\n`,
        }).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
    });
  });

  test('strict verification failure has its fixed secret-safe subcode', async () => {
    await withPrivateProofPath(async proofPath => {
      await assert.rejects(
        verifyEstablish(proofPath, { strictValid: false }),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure),
      );
    });
  });

  test('wraps every native verifier operation in its distinct fixed subcode', async () => {
    const diagnostics = [
      DARWIN_VERIFICATION_DIAGNOSTICS.certificateLookupFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.embeddedRequirementFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure,
    ];
    for (const [failureIndex, diagnostic] of diagnostics.entries()) {
      let invocation = 0;
      const simulator = createVerifierSimulator();
      await assert.rejects(inspectDarwinSigningEvidence({
        application,
        keychain,
        expectedCertificateSha1: fingerprint,
        runCommand: async options => {
          if (invocation++ === failureIndex) {
            throw new Error(`private failure ${application} ${fingerprint}`);
          }
          return simulator.runCommand(options);
        },
      }), isDiagnostic(diagnostic));
    }
  });

  test('unsigned code fails at signature display with a fixed secret-safe subcode', async () => {
    await assert.rejects(inspectDarwinSigningEvidence({
      application,
      keychain,
      expectedCertificateSha1: fingerprint,
      runCommand: createVerifierSimulator({ signed: false }).runCommand,
    }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure));
  });

  test('rejects missing, ambiguous, or non-exact display and requirement evidence', () => {
    for (const evidence of [
      validEvidence({ signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}` }),
      validEvidence({ signatureDetails: 'Signature size=1024' }),
      validEvidence({
        signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nIdentifier=${REQUIRED_IDENTIFIER}\nSignature size=1024`,
      }),
      validEvidence({ signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=01` }),
      validEvidence({ designatedRequirement: '' }),
      validEvidence({ designatedRequirement: `${requirementFor(fingerprint)}\r\n` }),
      validEvidence({ designatedRequirement: `${requirementFor(fingerprint)}\nextra\n` }),
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(evidence),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
      );
    }
  });
});
