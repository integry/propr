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
    identifierLine: `Identifier=${REQUIRED_IDENTIFIER}`,
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
          'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
          fixture.identifierLine,
          'Format=app bundle with Mach-O universal (x86_64 arm64)',
          fixture.signatureLine,
          'Info.plist entries=25',
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

  test('accepts exactly the generated keychain fingerprint and stable normalized requirements', async () => {
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
          isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.keychainEvidenceFailure),
        );
      });
    }
  });

  test('rejects explicit ad-hoc signature metadata with spacing and case variants', async () => {
    for (const signatureLine of [
      'Signature=adhoc',
      '  sIgNaTuRe  =  AdHoC  ',
    ]) {
      await withPrivateProofPath(async proofPath => {
        await assert.rejects(
          verifyEstablish(proofPath, { signatureLine }),
          isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.adhocSignatureFailure),
        );
      });
    }
  });

  test('rejects empty signature details', () => {
    assert.throws(
      () => assertDarwinSigningEvidence(validEvidence({ signatureDetails: '' })),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.identifierMetadataFailure),
    );
  });

  test('rejects missing, wrong, duplicate, and conflicting identifier metadata distinctly', () => {
    for (const signatureDetails of [
      'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
      'Signature size=1024',
      'Identifier=dev.other.desktop',
      'Identifier=DEV.PROPR.DESKTOP',
      `Identifier=${REQUIRED_IDENTIFIER}\nIdentifier=${REQUIRED_IDENTIFIER}`,
      `Identifier=${REQUIRED_IDENTIFIER}\nIDENTIFIER = dev.other.desktop`,
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(validEvidence({ signatureDetails })),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.identifierMetadataFailure),
      );
    }
  });

  test('rejects missing, zero, duplicate, and conflicting signature-size metadata distinctly', () => {
    for (const signatureDetails of [
      `Identifier=${REQUIRED_IDENTIFIER}`,
      `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=0`,
      `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=01`,
      `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=1024\nSignature size=1024`,
      `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=1024\nSIGNATURE SIZE = 2048`,
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(validEvidence({ signatureDetails })),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureMetadataFailure),
      );
    }
  });

  test('requires root identifier evidence during both initial and stable native inspections', async () => {
    await withPrivateProofPath(async proofPath => {
      await assert.rejects(
        verifyEstablish(proofPath, { identifierLine: null }),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.identifierMetadataFailure),
      );
      await verifyEstablish(proofPath);
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: fingerprint,
        proofPath,
        keychain,
        runCommand: createVerifierSimulator({ identifierLine: null }).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.identifierMetadataFailure));
    });
  });

  test('requires positive signature-size evidence during both native inspections', async () => {
    await withPrivateProofPath(async proofPath => {
      await assert.rejects(
        verifyEstablish(proofPath, { signatureLine: null }),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureMetadataFailure),
      );
      await verifyEstablish(proofPath);
      await assert.rejects(verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: fingerprint,
        proofPath,
        keychain,
        runCommand: createVerifierSimulator({ signatureLine: 'Signature size=0' }).runCommand,
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.signatureMetadataFailure));
    });
  });

  test('rejects the wrong embedded requirement leaf distinctly', async () => {
    await withPrivateProofPath(async proofPath => {
      await assert.rejects(
        verifyEstablish(proofPath, {
          designatedRequirement: `${requirementFor(otherFingerprint)}\n`,
        }),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure),
      );
    });
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
      }), isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure));
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

  test('accepts surrounding requirement metadata and CRLF, spacing, and keyword case variants', async () => {
    await withPrivateProofPath(async proofPath => {
      const selectedLine = [
        'DeSiGnAtEd   =>  IDENTIFIER   "dev.propr.desktop"  AnD',
        `CERTIFICATE  LEAF = h "${fingerprint.toLowerCase()}"`,
      ].join(' ');
      const requirementOutput = [
        'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
        'warning: using architecture arm64',
        `  ${selectedLine}  `,
        'Format=app bundle with Mach-O thin (arm64)',
      ].join('\r\n');
      await verifyEstablish(proofPath, { designatedRequirement: requirementOutput });
      assert.equal(await readFile(proofPath, 'utf8'), `${selectedLine}\n`);
      await verifyDarwinPackagedConnectSignature({
        mode: 'stable',
        application,
        expectedCertificateSha1: fingerprint,
        proofPath,
        keychain,
        runCommand: createVerifierSimulator({
          designatedRequirement: requirementOutput,
        }).runCommand,
      });
    });
  });

  test('accepts realistic verbose metadata with exactly one identifier and positive signature size', () => {
    for (const signatureDetails of [
      `Identifier=${REQUIRED_IDENTIFIER}\nSignature size=1024`,
      `Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop\nIdentifier=${REQUIRED_IDENTIFIER}\nSignature size=2048`,
      `Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop\r\n  IDENTIFIER = ${REQUIRED_IDENTIFIER}  \r\nFormat=app bundle with Mach-O thin (arm64)\r\n  SIGNATURE SIZE = 4096  `,
    ]) {
      assert.equal(
        assertDarwinSigningEvidence(validEvidence({ signatureDetails })),
        `${requirementFor(fingerprint)}\n`,
      );
    }
  });

  test('rejects duplicate designated lines, wrong identifiers and leaves, and extra clauses', () => {
    for (const designatedRequirement of [
      '',
      [requirementFor(fingerprint), requirementFor(fingerprint)].join('\n'),
      `${requirementFor(fingerprint)}\n${requirementFor(otherFingerprint)}\n`,
      `${requirementFor(fingerprint).replace(REQUIRED_IDENTIFIER, 'dev.other.desktop')}\n`,
      `${requirementFor(fingerprint).replace(REQUIRED_IDENTIFIER, 'DEV.PROPR.DESKTOP')}\n`,
      `${requirementFor(otherFingerprint)}\n`,
      `${requirementFor(fingerprint)} or anchor apple\n`,
      `${requirementFor(fingerprint)} and certificate 1 trusted\n`,
      `designated => (${requirementExpressionFor(fingerprint)})\n`,
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(validEvidence({ designatedRequirement })),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure),
      );
    }
  });

  test('ignores unrelated surrounding lines but requires exactly one designated line', () => {
    for (const designatedRequirement of [
      [
        'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
        'Format=app bundle with Mach-O universal (x86_64 arm64)',
      ].join('\n'),
      [
        'Executable=/private/tmp/propr-desktop.app/Contents/MacOS/propr-desktop',
        requirementFor(fingerprint),
        'Format=app bundle with Mach-O thin (x86_64)',
        requirementFor(fingerprint),
      ].join('\n'),
    ]) {
      assert.throws(
        () => assertDarwinSigningEvidence(validEvidence({ designatedRequirement })),
        isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure),
      );
    }
  });

  test('normalizes only surrounding line whitespace when comparing stable requirements', () => {
    const initial = validEvidence({
      designatedRequirement: `metadata\r\n  ${requirementFor(fingerprint)}  \r\nmore metadata\r\n`,
    });
    assert.equal(
      assertDarwinSigningEvidence(initial),
      `${requirementFor(fingerprint)}\n`,
    );
    assert.equal(
      assertDarwinSigningEvidence({
        ...initial,
        previousDesignatedRequirement: `${requirementFor(fingerprint)}\n`,
      }),
      `${requirementFor(fingerprint)}\n`,
    );
    assert.throws(
      () => assertDarwinSigningEvidence({
        ...initial,
        designatedRequirement: `${requirementFor(fingerprint).replace(' and ', '  and ')}\n`,
        previousDesignatedRequirement: `${requirementFor(fingerprint)}\n`,
      }),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure),
    );
  });

  test('retains EVIDENCE_ASSERTION_FAILURE for invalid verifier inputs', () => {
    assert.throws(
      () => assertDarwinSigningEvidence(validEvidence({
        expectedCertificateSha1: 'not-a-sha1',
      })),
      isDiagnostic(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure),
    );
  });
});
