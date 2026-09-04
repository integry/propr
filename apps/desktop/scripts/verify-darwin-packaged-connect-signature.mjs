#!/usr/bin/env node

import { createHash, X509Certificate } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './run-bounded-darwin-command.mjs';
import {
  DarwinSigningDiagnosticError,
  darwinSigningDiagnosticLine,
} from './sign-darwin-packaged-connect.mjs';

const REQUIRED_IDENTIFIER = 'dev.propr.desktop';
const SHA1_PATTERN = /^[A-F0-9]{40}$/u;
const VERIFICATION_TIMEOUT_MS = 20_000;
const VERIFICATION_TERMINATION_GRACE_MS = 1_000;
const VERIFICATION_MAX_OUTPUT_BYTES = 256 * 1024;

export const DARWIN_VERIFICATION_DIAGNOSTICS = Object.freeze({
  signatureDisplayFailure: 'SIGNATURE_DISPLAY_FAILURE',
  certificateExtractionFailure: 'CERTIFICATE_EXTRACTION_FAILURE',
  expectedRequirementFailure: 'EXPECTED_REQUIREMENT_FAILURE',
  embeddedRequirementFailure: 'EMBEDDED_REQUIREMENT_FAILURE',
  strictVerifyFailure: 'STRICT_VERIFY_FAILURE',
  evidenceAssertionFailure: 'EVIDENCE_ASSERTION_FAILURE',
});

const verificationFailure = (diagnostic, cause) => new DarwinSigningDiagnosticError(
  diagnostic,
  cause,
);

const runVerificationCommand = async (runCommand, arguments_, diagnostic) => {
  try {
    return await runCommand({
      executable: '/usr/bin/codesign',
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

const assertExtractedCertificate = async ({
  certificatePrefix,
  expectedCertificateSha1,
}) => {
  try {
    const { expectedSha1 } = expectedRequirementsFor(expectedCertificateSha1);
    const prefixName = basename(certificatePrefix);
    const prefixFiles = (await readdir(dirname(certificatePrefix)))
      .filter(entry => entry.startsWith(prefixName));
    if (prefixFiles.length !== 1 || prefixFiles[0] !== `${prefixName}0`) {
      throw new Error('invalid-extracted-certificate-count');
    }
    const leafPath = `${certificatePrefix}0`;
    const stats = await lstat(leafPath);
    if (!stats.isFile()) throw new Error('invalid-extracted-certificate-file');
    const leaf = new X509Certificate(await readFile(leafPath));
    const extractedSha1 = createHash('sha1').update(leaf.raw).digest('hex').toUpperCase();
    if (extractedSha1 !== expectedSha1) {
      throw new Error('unexpected-extracted-certificate');
    }
  } catch (cause) {
    if (cause instanceof DarwinSigningDiagnosticError
      && cause.diagnostic === DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure) {
      throw cause;
    }
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
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
  try {
    const expected = expectedRequirementsFor(expectedCertificateSha1);
    const details = normalizeLines(signatureDetails).map(line => line.trim());
    const identifiers = details.filter(line => line.startsWith('Identifier='));
    const signatures = details.filter(line => line.startsWith('Signature'));
    if (signatures.length !== 1
      || !/^Signature size=\d+$/u.test(signatures[0])
      || identifiers.length !== 1
      || identifiers[0] !== `Identifier=${REQUIRED_IDENTIFIER}`) {
      throw new Error('invalid-signature-display-evidence');
    }

    const requirementMatch = designatedRequirement.match(
      /^designated => identifier "dev\.propr\.desktop" and certificate leaf = H"([A-Fa-f0-9]{40})"\n$/u,
    );
    if (!requirementMatch || requirementMatch[1].toUpperCase() !== expected.expectedSha1) {
      throw new Error('invalid-embedded-requirement-evidence');
    }
    if (previousDesignatedRequirement !== undefined
      && previousDesignatedRequirement !== designatedRequirement) {
      throw new Error('unstable-embedded-requirement-evidence');
    }
    return designatedRequirement;
  } catch (cause) {
    if (cause instanceof DarwinSigningDiagnosticError
      && cause.diagnostic === DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure) {
      throw cause;
    }
    throw verificationFailure(
      DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure,
      cause,
    );
  }
};

export const inspectDarwinSigningEvidence = async ({
  application,
  expectedCertificateSha1,
  certificatePrefix,
  runCommand = runBoundedProcess,
}) => {
  expectedRequirementsFor(expectedCertificateSha1);
  const signatureResult = await runVerificationCommand(
    runCommand,
    ['-d', '--verbose=4', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.signatureDisplayFailure,
  );
  await runVerificationCommand(
    runCommand,
    ['-d', '--extract-certificates', certificatePrefix, application],
    DARWIN_VERIFICATION_DIAGNOSTICS.certificateExtractionFailure,
  );
  await assertExtractedCertificate({ certificatePrefix, expectedCertificateSha1 });
  const requirementResult = await runVerificationCommand(
    runCommand,
    ['-d', '-r-', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.embeddedRequirementFailure,
  );
  await runVerificationCommand(
    runCommand,
    ['--verify', '--deep', '--strict', application],
    DARWIN_VERIFICATION_DIAGNOSTICS.strictVerifyFailure,
  );
  try {
    return {
      signatureDetails: `${signatureResult.stdout}${signatureResult.stderr}`,
      designatedRequirement: `${requirementResult.stdout}${requirementResult.stderr}`,
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
  certificatePrefix,
  runCommand = runBoundedProcess,
}) => {
  if (mode !== 'establish' && mode !== 'stable') {
    throw verificationFailure(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure);
  }
  if (!certificatePrefix
    || resolve(dirname(certificatePrefix)) !== resolve(dirname(proofPath))) {
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
    expectedCertificateSha1,
    certificatePrefix,
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
    mode, application, expectedCertificateSha1, proofPath, certificatePrefix,
  ] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin'
      || !mode || !application || !expectedCertificateSha1 || !proofPath
      || !certificatePrefix) {
      throw verificationFailure(DARWIN_VERIFICATION_DIAGNOSTICS.evidenceAssertionFailure);
    }
    await verifyDarwinPackagedConnectSignature({
      mode, application, expectedCertificateSha1, proofPath, certificatePrefix,
    });
  } catch (error) {
    process.stderr.write(darwinSigningDiagnosticLine(error));
    process.exitCode = 1;
  }
}
