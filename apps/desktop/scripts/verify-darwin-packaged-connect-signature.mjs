#!/usr/bin/env node

import { X509Certificate } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './run-bounded-darwin-command.mjs';
import {
  DARWIN_SIGNING_DIAGNOSTICS,
  DarwinSigningDiagnosticError,
  darwinSigningDiagnosticLine,
} from './sign-darwin-packaged-connect.mjs';

const REQUIRED_IDENTIFIER = 'dev.propr.desktop';
const SHA1_PATTERN = /^[A-F0-9]{40}$/u;
const VERIFICATION_TIMEOUT_MS = 20_000;
const VERIFICATION_TERMINATION_GRACE_MS = 1_000;
const VERIFICATION_MAX_OUTPUT_BYTES = 256 * 1024;

const runVerificationCommand = (runCommand, executable, arguments_) => runCommand({
  executable,
  arguments: arguments_,
  timeoutMs: VERIFICATION_TIMEOUT_MS,
  terminationGraceMs: VERIFICATION_TERMINATION_GRACE_MS,
  maxOutputBytes: VERIFICATION_MAX_OUTPUT_BYTES,
  forwardOutput: false,
});

const normalizeLines = value => value.replace(/\r\n?/gu, '\n').split('\n');

const missingCertificateEvidence = cause => new DarwinSigningDiagnosticError(
  DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain,
  cause,
);

export const readExtractedCertificateFingerprints = async ({
  certificateDirectory,
  certificatePrefix,
}) => {
  try {
    const prefixName = basename(certificatePrefix);
    const expectedCertificateName = `${prefixName}0`;
    const expectedCertificatePath = join(certificateDirectory, expectedCertificateName);
    const entries = (await readdir(certificateDirectory, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(prefixName));
    if (entries.length !== 1
      || entries[0].name !== expectedCertificateName
      || !entries[0].isFile()) {
      throw missingCertificateEvidence();
    }

    const certificateFile = await lstat(expectedCertificatePath);
    if (!certificateFile.isFile()) throw missingCertificateEvidence();
    const certificateBytes = await readFile(expectedCertificatePath);
    const leafCertificate = new X509Certificate(certificateBytes);
    return [leafCertificate.fingerprint.replaceAll(':', '').toUpperCase()];
  } catch (error) {
    if (error instanceof DarwinSigningDiagnosticError) throw error;
    throw missingCertificateEvidence(error);
  }
};

export const assertDarwinSigningEvidence = ({
  expectedCertificateSha1,
  certificateFingerprints,
  signatureDetails,
  designatedRequirement,
  previousDesignatedRequirement,
}) => {
  const expectedSha1 = expectedCertificateSha1.toUpperCase();
  if (!SHA1_PATTERN.test(expectedSha1)) throw new Error('invalid-certificate-fingerprint');

  const details = normalizeLines(signatureDetails).map(line => line.trim());
  if (details.includes('Signature=adhoc')) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.codesignFailure);
  }
  if (!Array.isArray(certificateFingerprints)
    || certificateFingerprints.length !== 1
    || certificateFingerprints[0] !== expectedSha1) {
    throw missingCertificateEvidence();
  }
  if (!details.includes(`Identifier=${REQUIRED_IDENTIFIER}`)) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.codesignFailure);
  }

  const requirements = normalizeLines(designatedRequirement)
    .filter(line => line.startsWith('designated =>'));
  if (requirements.length !== 1
    || !requirements[0].includes(`identifier "${REQUIRED_IDENTIFIER}"`)
    || !requirements[0].toUpperCase().includes(`CERTIFICATE LEAF = H"${expectedSha1}"`)) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.requirementsFailure);
  }
  if (previousDesignatedRequirement !== undefined
    && requirements[0] !== previousDesignatedRequirement.trim()) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.requirementsFailure);
  }
  return requirements[0];
};

export const inspectDarwinSigningEvidence = async ({
  mode,
  application,
  certificateDirectory,
  runCommand = runBoundedProcess,
}) => {
  const certificatePrefix = join(
    certificateDirectory,
    `codesign-${mode}-certificate-`,
  );
  const signatureResult = await runVerificationCommand(runCommand, '/usr/bin/codesign', [
    '--display', '--verbose=4', '--extract-certificates', certificatePrefix, application,
  ]);
  const signatureDetails = `${signatureResult.stdout}\n${signatureResult.stderr}`;
  if (normalizeLines(signatureDetails).some(line => line.trim() === 'Signature=adhoc')) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.codesignFailure);
  }

  const certificateFingerprints = await readExtractedCertificateFingerprints({
    certificateDirectory,
    certificatePrefix,
  });
  const requirementResult = await runVerificationCommand(
    runCommand,
    '/usr/bin/codesign',
    ['-d', '-r-', application],
  );
  await runVerificationCommand(runCommand, '/usr/bin/codesign', [
    '--verify', '--deep', '--strict', application,
  ]);
  return {
    certificateFingerprints,
    signatureDetails,
    designatedRequirement: `${requirementResult.stdout}\n${requirementResult.stderr}`,
  };
};

export const verifyDarwinPackagedConnectSignature = async ({
  mode,
  application,
  expectedCertificateSha1,
  proofPath,
}) => {
  if (mode !== 'establish' && mode !== 'stable') throw new Error('invalid-verification-mode');
  const previousDesignatedRequirement = mode === 'stable'
    ? await readFile(proofPath, 'utf8')
    : undefined;
  const evidence = await inspectDarwinSigningEvidence({
    mode,
    application,
    certificateDirectory: dirname(proofPath),
  });
  const requirement = assertDarwinSigningEvidence({
    expectedCertificateSha1,
    previousDesignatedRequirement,
    ...evidence,
  });
  if (mode === 'establish') {
    await writeFile(proofPath, `${requirement}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [mode, application, expectedCertificateSha1, proofPath] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin'
      || !mode || !application || !expectedCertificateSha1 || !proofPath) {
      throw new Error('invalid-invocation');
    }
    await verifyDarwinPackagedConnectSignature({
      mode, application, expectedCertificateSha1, proofPath,
    });
  } catch (error) {
    process.stderr.write(darwinSigningDiagnosticLine(error));
    process.exitCode = 1;
  }
}
