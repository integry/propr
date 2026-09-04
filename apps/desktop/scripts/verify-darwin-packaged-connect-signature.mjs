#!/usr/bin/env node

import { execFile as nodeExecFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DARWIN_SIGNING_DIAGNOSTICS,
  DarwinSigningDiagnosticError,
  darwinSigningDiagnosticLine,
} from './sign-darwin-packaged-connect.mjs';

const execFile = promisify(nodeExecFile);
const REQUIRED_IDENTIFIER = 'dev.propr.desktop';
const SHA1_PATTERN = /^[A-F0-9]{40}$/u;
const VERIFICATION_TIMEOUT_MS = 20_000;
const VERIFICATION_MAX_BUFFER = 256 * 1024;

const runVerificationCommand = (executable, arguments_) => execFile(executable, arguments_, {
  encoding: 'utf8',
  maxBuffer: VERIFICATION_MAX_BUFFER,
  timeout: VERIFICATION_TIMEOUT_MS,
  killSignal: 'SIGKILL',
});

const normalizeLines = value => value.replace(/\r\n?/gu, '\n').split('\n');

export const assertDarwinSigningEvidence = ({
  expectedCertificateSha1,
  certificates,
  signatureDetails,
  designatedRequirement,
  previousDesignatedRequirement,
}) => {
  const expectedSha1 = expectedCertificateSha1.toUpperCase();
  if (!SHA1_PATTERN.test(expectedSha1)) throw new Error('invalid-certificate-fingerprint');

  const certificateFingerprints = normalizeLines(certificates)
    .map(line => /^\s*SHA-1 hash:\s*([A-Fa-f0-9]{40})\s*$/u.exec(line)?.[1]?.toUpperCase())
    .filter(Boolean);
  if (certificateFingerprints.length !== 1 || certificateFingerprints[0] !== expectedSha1) {
    throw new DarwinSigningDiagnosticError(DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain);
  }

  const details = normalizeLines(signatureDetails);
  if (details.some(line => line === 'Signature=adhoc')
    || !details.some(line => line.startsWith('Authority=') && line.length > 'Authority='.length)
    || !details.includes(`Identifier=${REQUIRED_IDENTIFIER}`)) {
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

const inspectDarwinSigningEvidence = async ({ application, keychain }) => {
  const certificatePromise = runVerificationCommand('/usr/bin/security', [
    'find-certificate', '-a', '-Z', keychain,
  ]).catch(error => {
    throw new DarwinSigningDiagnosticError(
      DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain,
      error,
    );
  });
  const [certificateResult, signatureResult, requirementResult] = await Promise.all([
    certificatePromise,
    runVerificationCommand('/usr/bin/codesign', ['-d', '--verbose=4', application]),
    runVerificationCommand('/usr/bin/codesign', ['-d', '-r-', application]),
  ]);
  await runVerificationCommand('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', application,
  ]);
  return {
    certificates: `${certificateResult.stdout}\n${certificateResult.stderr}`,
    signatureDetails: `${signatureResult.stdout}\n${signatureResult.stderr}`,
    designatedRequirement: `${requirementResult.stdout}\n${requirementResult.stderr}`,
  };
};

export const verifyDarwinPackagedConnectSignature = async ({
  mode,
  application,
  keychain,
  expectedCertificateSha1,
  proofPath,
}) => {
  if (mode !== 'establish' && mode !== 'stable') throw new Error('invalid-verification-mode');
  const previousDesignatedRequirement = mode === 'stable'
    ? await readFile(proofPath, 'utf8')
    : undefined;
  const evidence = await inspectDarwinSigningEvidence({ application, keychain });
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
  const [mode, application, keychain, expectedCertificateSha1, proofPath] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin'
      || !mode || !application || !keychain || !expectedCertificateSha1 || !proofPath) {
      throw new Error('invalid-invocation');
    }
    await verifyDarwinPackagedConnectSignature({
      mode, application, keychain, expectedCertificateSha1, proofPath,
    });
  } catch (error) {
    process.stderr.write(darwinSigningDiagnosticLine(error));
    process.exitCode = 1;
  }
}
