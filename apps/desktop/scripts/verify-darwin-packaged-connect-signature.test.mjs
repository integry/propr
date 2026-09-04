import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const selfSignedCertificate = rootCertificates
  .map(certificate => new X509Certificate(certificate))
  .find(certificate => certificate.checkIssued(certificate));
assert.ok(selfSignedCertificate, 'Node must provide a self-signed certificate test fixture');
const selfSignedFingerprint = createHash('sha1')
  .update(selfSignedCertificate.raw)
  .digest('hex')
  .toUpperCase();

const validEvidence = (overrides = {}) => ({
  expectedCertificateSha1: selfSignedFingerprint,
  signatureDetails: [
    'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
    `Identifier=${REQUIRED_IDENTIFIER}`,
    'Signature size=1024',
  ].join('\n'),
  designatedRequirement: requirementFor(selfSignedFingerprint),
  ...overrides,
});

const createCodesignSimulator = (overrides = {}) => {
  const fixture = {
    signed: true,
    adHoc: false,
    identifier: REQUIRED_IDENTIFIER,
    leaf: selfSignedFingerprint,
    designatedRequirement: requirementFor(selfSignedFingerprint),
    strictValid: true,
    ...overrides,
  };
  const calls = [];
  const runCommand = async options => {
    calls.push(options);
    const arguments_ = options.arguments;
    if (arguments_.includes('--verbose=4')) {
      if (!fixture.signed) throw new Error(`unsigned secret ${application}`);
      return {
        stdout: '',
        stderr: [
          `Identifier=${fixture.identifier}`,
          fixture.adHoc ? 'Signature=adhoc' : 'Signature size=1024',
        ].join('\n'),
      };
    }
    if (arguments_.includes('--test-requirement')) {
      if (!fixture.signed || fixture.adHoc
        || fixture.identifier !== REQUIRED_IDENTIFIER
        || fixture.leaf !== selfSignedFingerprint) {
        throw new Error(`requirement mismatch ${fixture.leaf} ${application}`);
      }
      return { stdout: '', stderr: '' };
    }
    if (arguments_.includes('-r-')) {
      if (!fixture.signed) throw new Error(`missing requirement ${application}`);
      return { stdout: '', stderr: `${fixture.designatedRequirement}\n` };
    }
    if (arguments_.includes('--strict')) {
      if (!fixture.strictValid) throw new Error(`strict failure ${application}`);
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected simulated codesign invocation');
  };
  return { calls, runCommand };
};

const withProofPath = async callback => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-requirement-proof-'));
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

describe('Darwin packaged Connect acceptance signature proof', () => {
  test('uses exact bounded argv for native requirement evaluation and separate evidence checks', async () => {
    const simulator = createCodesignSimulator();
    const evidence = await inspectDarwinSigningEvidence({
      application,
      expectedCertificateSha1: selfSignedFingerprint,
      runCommand: simulator.runCommand,
    });

    assert.equal(
      assertDarwinSigningEvidence({
        expectedCertificateSha1: selfSignedFingerprint,
        ...evidence,
      }),
      requirementFor(selfSignedFingerprint),
    );
    assert.deepEqual(simulator.calls.map(call => call.arguments), [
      ['--display', '--verbose=4', application],
      [
        '--verify',
        '--test-requirement',
        `=${requirementExpressionFor(selfSignedFingerprint)}`,
        application,
      ],
      ['-d', '-r-', application],
      ['--verify', '--deep', '--strict', application],
    ]);
    for (const call of simulator.calls) {
      assert.equal(call.executable, '/usr/bin/codesign');
      assert.equal(call.timeoutMs, 20_000);
      assert.equal(call.terminationGraceMs, 1_000);
      assert.equal(call.maxOutputBytes, 256 * 1024);
      assert.equal(call.forwardOutput, false);
    }
  });

  test('accepts a valid self-signed leaf and the exact stable embedded requirement', async () => {
    await withProofPath(async proofPath => {
      const displayedRequirement = requirementFor(selfSignedFingerprint.toLowerCase());
      await verifyDarwinPackagedConnectSignature({
        mode: 'establish',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        runCommand: createCodesignSimulator({
          designatedRequirement: displayedRequirement,
        }).runCommand,
      });
      assert.equal(
        await readFile(proofPath, 'utf8'),
        `${displayedRequirement}\n`,
      );
      await verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        runCommand: createCodesignSimulator({
          designatedRequirement: displayedRequirement,
        }).runCommand,
      });
    });
  });

  test('native expected-requirement evaluation rejects ad-hoc, wrong-leaf, and wrong-identifier code', async () => {
    for (const fixture of [
      { adHoc: true },
      { leaf: otherFingerprint },
      { identifier: 'dev.other.desktop' },
    ]) {
      await assert.rejects(inspectDarwinSigningEvidence({
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        runCommand: createCodesignSimulator(fixture).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.expectedRequirementFailure));
    }
  });

  test('unsigned code fails at signature display with a fixed secret-safe subcode', async () => {
    await assert.rejects(inspectDarwinSigningEvidence({
      application,
      expectedCertificateSha1: selfSignedFingerprint,
      runCommand: createCodesignSimulator({ signed: false }).runCommand,
    }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure));
  });

  test('wraps every native verifier operation in its distinct fixed subcode', async () => {
    const diagnostics = [
      DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.expectedRequirementFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.embeddedRequirementFailure,
      DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure,
    ];
    for (const [failureIndex, diagnostic] of diagnostics.entries()) {
      let invocation = 0;
      const simulator = createCodesignSimulator();
      await assert.rejects(inspectDarwinSigningEvidence({
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        runCommand: async options => {
          if (invocation++ === failureIndex) {
            throw new Error(`private failure ${application} ${selfSignedFingerprint}`);
          }
          return simulator.runCommand(options);
        },
      }), isDiagnostic(diagnostic));
    }
  });

  test('rejects missing or ambiguous display and embedded-requirement evidence', () => {
    for (const evidence of [
      validEvidence({ signatureDetails: 'Signature size=1024' }),
      validEvidence({
        signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nIdentifier=${REQUIRED_IDENTIFIER}`,
      }),
      validEvidence({ designatedRequirement: '' }),
      validEvidence({
        designatedRequirement: [
          requirementFor(selfSignedFingerprint),
          requirementFor(selfSignedFingerprint),
        ].join('\n'),
      }),
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(evidence),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
      );
    }
  });

  test('rejects ad-hoc evidence even if a mocked native evaluator reports success', () => {
    assert.throws(
      () => assertDarwinSigningEvidence(validEvidence({
        signatureDetails: `Identifier=${REQUIRED_IDENTIFIER}\nSignature=adhoc`,
      })),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
    );
  });

  test('requires byte-exact embedded designated-requirement stability after reprobe', async () => {
    await withProofPath(async proofPath => {
      await writeFile(proofPath, `${requirementFor(otherFingerprint)}\n`, { mode: 0o600 });
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: selfSignedFingerprint,
        proofPath,
        runCommand: createCodesignSimulator().runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure));
    });
  });

  test('rejects a mismatched embedded requirement even after native expected evaluation passes', () => {
    assert.throws(
      () => assertDarwinSigningEvidence(validEvidence({
        designatedRequirement: requirementFor(otherFingerprint),
      })),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
    );
  });
});
