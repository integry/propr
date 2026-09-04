#!/usr/bin/env node

import { lstat, open, readdir } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedProcess } from './run-bounded-darwin-command.mjs';

const CERTIFICATE_SHA1 = /^[A-F0-9]{40}$/u;
const CERTIFICATE_LINE = /^\s*SHA-1 hash:\s*([A-Fa-f0-9]{40})\s*$/gmu;
const PACKAGED_CONNECT_NATIVE_ARTIFACTS = /\/Resources\/app\.asar\.unpacked\/\.vite\/native\/prebuilds\//u;
const CODESIGN_TIMEOUT_MS = 30_000;
const CODESIGN_MAX_OUTPUT_BYTES = 256 * 1024;
const MACH_O_MAGICS = new Set([
  0xFEEDFACE, 0xFEEDFACF, 0xCEFAEDFE, 0xCFFAEDFE,
  0xCAFEBABE, 0xBEBAFECA, 0xCAFEBABF, 0xBFBAFECA,
]);

export const DARWIN_SIGNING_DIAGNOSTICS = Object.freeze({
  missingIdentityOrChain: 'MISSING_IDENTITY_OR_CHAIN',
  trustRejection: 'TRUST_REJECTION',
  requirementsFailure: 'REQUIREMENTS_FAILURE',
  codesignFailure: 'CODESIGN_FAILURE',
});

export class DarwinSigningDiagnosticError extends Error {
  constructor(diagnostic, cause) {
    super(`darwin-signing-${diagnostic.toLowerCase()}`, { cause });
    this.name = 'DarwinSigningDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

const failureText = error => [
  error?.message,
  error?.stdout,
  error?.stderr,
  error?.result?.stdout,
  error?.result?.stderr,
  error?.cause?.message,
].filter(value => typeof value === 'string').join('\n');

export const classifyDarwinSigningFailure = error => {
  if (error instanceof DarwinSigningDiagnosticError) return error.diagnostic;
  const details = failureText(error);
  if (/CSSMERR_TP_NOT_TRUSTED|errSecNotTrusted|certificate (?:is )?not trusted|trust evaluation/iu.test(details)) {
    return DARWIN_SIGNING_DIAGNOSTICS.trustRejection;
  }
  if (/unable to build chain|incomplete certificate chain|no identity found|identity[^\n]*not found|specified item could not be found in the keychain/iu.test(details)) {
    return DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain;
  }
  if (/designated requirement|invalid requirement|code requirement|requirement compilation/iu.test(details)) {
    return DARWIN_SIGNING_DIAGNOSTICS.requirementsFailure;
  }
  return DARWIN_SIGNING_DIAGNOSTICS.codesignFailure;
};

export const darwinSigningDiagnosticLine = error => (
  `DARWIN_PACKAGED_CONNECT_DIAGNOSTIC:${classifyDarwinSigningFailure(error)}\n`
);

const signingRank = filePath => {
  const depth = filePath.split(sep).length;
  return depth * 2 + (/\.app\/Contents\/MacOS\/[^/]+$/u.test(filePath) ? 0 : 1);
};

const runSigningCommand = (runCommand, executable, arguments_) => runCommand({
  executable,
  arguments: arguments_,
  timeoutMs: CODESIGN_TIMEOUT_MS,
  // Settle the nested command group before the outer signing wrapper's five-second escalation.
  terminationGraceMs: 1_000,
  maxOutputBytes: CODESIGN_MAX_OUTPUT_BYTES,
  forwardOutput: false,
});

const assertExactImportedCertificate = (output, certificateSha1) => {
  const fingerprints = [...output.matchAll(CERTIFICATE_LINE)]
    .map(match => match[1].toUpperCase());
  if (fingerprints.length !== 1 || fingerprints[0] !== certificateSha1) {
    throw new DarwinSigningDiagnosticError(
      DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain,
    );
  }
};

const isMachO = async filePath => {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    await handle.close();
  }
};

export const discoverDarwinSignablePaths = async root => {
  const discovered = [];
  const visit = async directory => {
    const entries = await readdir(directory);
    entries.sort();
    for (const entry of entries) {
      const filePath = join(directory, entry);
      const stats = await lstat(filePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await visit(filePath);
        if (extname(filePath) === '.app' || extname(filePath) === '.framework') {
          discovered.push(filePath);
        }
      } else if (stats.isFile() && await isMachO(filePath)) {
        discovered.push(filePath);
      }
    }
  };
  await visit(root);
  return discovered;
};

export const signDarwinPackagedConnectApplication = async ({
  application,
  keychain,
  certificateSha1,
  discover = discoverDarwinSignablePaths,
  runCommand = runBoundedProcess,
}) => {
  if (!application.endsWith('.app') || !keychain.endsWith('.keychain-db')
    || !CERTIFICATE_SHA1.test(certificateSha1)) {
    throw new Error('invalid-acceptance-signing-input');
  }
  const certificateResult = await runSigningCommand(runCommand, '/usr/bin/security', [
    'find-certificate', '-a', '-Z', keychain,
  ]).catch(error => {
    throw new DarwinSigningDiagnosticError(
      DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain,
      error,
    );
  });
  assertExactImportedCertificate(
    `${certificateResult.stdout}\n${certificateResult.stderr}`,
    certificateSha1,
  );

  const designatedRequirement = `designated => identifier "dev.propr.desktop" and certificate leaf = H"${certificateSha1}"`;
  const discovered = (await discover(join(application, 'Contents')))
    .filter(filePath => !PACKAGED_CONNECT_NATIVE_ARTIFACTS.test(filePath));
  const targets = [...discovered, application]
    .sort((left, right) => signingRank(right) - signingRank(left));
  const targetsByRank = new Map();
  for (const target of targets) {
    const rank = signingRank(target);
    targetsByRank.set(rank, [...(targetsByRank.get(rank) ?? []), target]);
  }

  for (const targetGroup of targetsByRank.values()) {
    const isApplication = targetGroup.length === 1 && targetGroup[0] === application;
    const arguments_ = [
      '--sign', certificateSha1,
      '--force',
      '--keychain', keychain,
      '--timestamp=none',
      '--preserve-metadata=identifier,entitlements,flags',
      ...(isApplication ? [`-r=${designatedRequirement}`] : []),
      ...targetGroup,
    ];
    await runSigningCommand(runCommand, '/usr/bin/codesign', arguments_);
  }
  await runSigningCommand(runCommand, '/usr/bin/codesign', [
    '--verify', '--deep', '--strict', application,
  ]);
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [application, keychain, certificateSha1] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin' || !application || !keychain || !certificateSha1) {
      throw new Error('invalid-invocation');
    }
    await signDarwinPackagedConnectApplication({ application, keychain, certificateSha1 });
  } catch (error) {
    process.stderr.write(darwinSigningDiagnosticLine(error));
    process.exitCode = 1;
  }
}
