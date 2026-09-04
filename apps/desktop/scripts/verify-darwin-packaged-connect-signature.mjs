#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './run-bounded-darwin-command.mjs';
import {
  DarwinSigningDiagnosticError,
  darwinSigningDiagnosticLine,
} from './sign-darwin-packaged-connect.mjs';

const REQUIRED_IDENTIFIER = 'dev.propr.desktop';
const SHA1_PATTERN = /^[A-F0-9]{40}$/u;
const CERTIFICATE_LINE = /^\s*SHA-1 hash:\s*([A-Fa-f0-9]{40})\s*$/gmu;
const ADHOC_SIGNATURE_LINE = /^\s*signature\s*=\s*adhoc\s*$/iu;
const IDENTIFIER_LINE = /^\s*identifier\s*=\s*(.*?)\s*$/iu;
const DESIGNATED_REQUIREMENT_PREFIX = /^designated\s*=>/iu;
const DESIGNATED_REQUIREMENT_GRAMMAR = /^designated\s*=>\s*identifier\s+"([^"]+)"\s+and\s+certificate\s+leaf\s*=\s*H\s*"([A-F0-9]{40})"$/iu;
const VERIFICATION_TIMEOUT_MS = 20_000;
const VERIFICATION_TERMINATION_GRACE_MS = 1_000;
const VERIFICATION_MAX_OUTPUT_BYTES = 256 * 1024;

export const DARWIN_VERIFICATION_DIAGNOSTICS = Object.freeze({
  certificateLookupFailure: 'CERTIFICATE_LOOKUP_FAILURE',
  signatureDisplayFailure: 'SIGNATURE_DISPLAY_FAILURE',
  embeddedRequirementFailure: 'EMBEDDED_REQUIREMENT_FAILURE',
  strictVerifyFailure: 'STRICT_VERIFY_FAILURE',
  keychainEvidenceFailure: 'KEYCHAIN_EVIDENCE_FAILURE',
  adhocSignatureFailure: 'ADHOC_SIGNATURE_FAILURE',
  identifierMetadataFailure: 'IDENTIFIER_METADATA_FAILURE',
  requirementEvidenceFailure: 'REQUIREMENT_EVIDENCE_FAILURE',
  evidenceAssertionFailure: 'EVIDENCE_ASSERTION_FAILURE',
});

const verificationFailure = (diagnostic, cause) => new DarwinSigningDiagnosticError(
  diagnostic,
  cause,
);

const runVerificationCommand = async (runCommand, executable, arguments_, diagnostic) => {
  try {
    return await runCommand({
      executable,
      arguments: arguments_,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      terminationGraceMs: VERIFICATION_TERMINATION_GRACE_MS,
      maxOutputBytes: VERIFICATION_MAX_OUTPUT_BYTES,
      forwardOutput: false,
    });
  } catch (cause) {
    throw verificationFailure(diagnostic, cause);
  }
};

const normalizeLines = value => value.replace(/\r\n?/gu, '\n').split('\n');

const expectedRequirementsFor = expectedCertificateSha1 => {
  try {
    const expectedSha1 = expectedCertificateSha1;
    if (!SHA1_PATTERN.test(expectedSha1)) throw new Error('invalid-certificate-fingerprint');
    const expression = `identifier "${REQUIRED_IDENTIFIER}" and certificate leaf = H"${expectedSha1}"`;
    return {
      expectedSha1,
      expression,
    };
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
      cause,
    );
  }
};

const assertExactKeychainCertificate = (certificateDetails, expectedCertificateSha1) => {
  const { expectedSha1 } = expectedRequirementsFor(expectedCertificateSha1);
  try {
    const fingerprints = [...certificateDetails.matchAll(CERTIFICATE_LINE)]
      .map(match => match[1].toUpperCase());
    if (fingerprints.length !== 1 || fingerprints[0] !== expectedSha1) {
      throw new Error('invalid-keychain-certificate-evidence');
    }
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.keychainEvidenceFailure,
      cause,
    );
  }
};

const assertNotAdhocSignature = signatureDetails => {
  try {
    if (normalizeLines(signatureDetails).some(line => ADHOC_SIGNATURE_LINE.test(line))) {
      throw new Error('ad-hoc-signature-evidence');
    }
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.adhocSignatureFailure,
      cause,
    );
  }
};

const assertIdentifierMetadata = signatureDetails => {
  try {
    const identifiers = normalizeLines(signatureDetails)
      .map(line => line.match(IDENTIFIER_LINE))
      .filter(match => match !== null)
      .map(match => match[1]);
    if (identifiers.length !== 1 || identifiers[0] !== REQUIRED_IDENTIFIER) {
      throw new Error('invalid-identifier-display-evidence');
    }
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.identifierMetadataFailure,
      cause,
    );
  }
};

const assertDesignatedRequirement = (
  designatedRequirement,
  expectedSha1,
  previousDesignatedRequirement,
) => {
  try {
    const designatedLines = normalizeLines(designatedRequirement)
      .map(line => line.trim())
      .filter(line => DESIGNATED_REQUIREMENT_PREFIX.test(line));
    if (designatedLines.length !== 1) {
      throw new Error('ambiguous-embedded-requirement-evidence');
    }
    const requirementMatch = designatedLines[0].match(DESIGNATED_REQUIREMENT_GRAMMAR);
    if (!requirementMatch
      || requirementMatch[1] !== REQUIRED_IDENTIFIER
      || requirementMatch[2].toUpperCase() !== expectedSha1) {
      throw new Error('invalid-embedded-requirement-evidence');
    }
    const normalizedRequirement = `${designatedLines[0]}\n`;
    if (previousDesignatedRequirement !== undefined
      && previousDesignatedRequirement !== normalizedRequirement) {
      throw new Error('unstable-embedded-requirement-evidence');
    }
    return normalizedRequirement;
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.requirementEvidenceFailure,
      cause,
    );
  }
};

export const assertDarwinSigningEvidence = ({
  expectedCertificateSha1,
  signatureDetails,
  designatedRequirement,
  previousDesignatedRequirement,
}) => {
  const expected = expectedRequirementsFor(expectedCertificateSha1);
  assertNotAdhocSignature(signatureDetails);
  assertIdentifierMetadata(signatureDetails);
  return assertDesignatedRequirement(
    designatedRequirement,
    expected.expectedSha1,
    previousDesignatedRequirement,
  );
};

export const inspectDarwinSigningEvidence = async ({
  application,
  keychain,
  expectedCertificateSha1,
  runCommand = runBoundedProcess,
}) => {
  expectedRequirementsFor(expectedCertificateSha1);
  const certificateResult = await runVerificationCommand(
    runCommand,
    '/usr/bin/security',
    ['find-certificate', '-a', '-Z', keychain],
    DARWIN_VERIFICATION_DIAGNOSTICS.certificateLookupFailure,
  );
  assertExactKeychainCertificate(
    `${certificateResult.stdout}\n${certificateResult.stderr}`,
    expectedCertificateSha1,
  );
  const signatureResult = await runVerificationCommand(
    runCommand,
    '/usr/bin/codesign',
    ['-d', '--verbose=4', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure,
  );
  const requirementResult = await runVerificationCommand(
    runCommand,
    '/usr/bin/codesign',
    ['-d', '-r-', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.embeddedRequirementFailure,
  );
  await runVerificationCommand(
    runCommand,
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure,
  );
  try {
    return {
      signatureDetails: `${signatureResult.stdout}\n${signatureResult.stderr}`,
      designatedRequirement: `${requirementResult.stdout}\n${requirementResult.stderr}`,
    };
  } catch (cause) {
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
      cause,
    );
  }
};

export const verifyDarwinPackagedConnectSignature = async ({
  mode,
  application,
  expectedCertificateSha1,
  proofPath,
  keychain,
  runCommand = runBoundedProcess,
}) => {
  if (mode !== 'establish' && mode !== 'stable') {
    throw verificationFailure(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure);
  }
  if (!keychain || !keychain.endsWith('.keychain-db')) {
    throw verificationFailure(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure);
  }
  let previousDesignatedRequirement;
  if (mode === 'stable') {
    try {
      previousDesignatedRequirement = await readFile(proofPath, 'utf8');
    } catch (cause) {
      throw verificationFailure(
        DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
        cause,
      );
    }
  }
  const evidence = await inspectDarwinSigningEvidence({
    application,
    keychain,
    expectedCertificateSha1,
    runCommand,
  });
  const requirement = assertDarwinSigningEvidence({
    expectedCertificateSha1,
    previousDesignatedRequirement,
    ...evidence,
  });
  if (mode === 'establish') {
    try {
      await writeFile(proofPath, requirement, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
    } catch (cause) {
      throw verificationFailure(
        DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
        cause,
      );
    }
  }
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [
    mode, application, expectedCertificateSha1, proofPath, keychain,
  ] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin'
      || !mode || !application || !expectedCertificateSha1 || !proofPath
      || !keychain) {
      throw verificationFailure(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure);
    }
    await verifyDarwinPackagedConnectSignature({
      mode, application, expectedCertificateSha1, proofPath, keychain,
    });
  } catch (error) {
    process.stderr.write(darwinSigningDiagnosticLine(error));
    process.exitCode = 1;
  }
}
