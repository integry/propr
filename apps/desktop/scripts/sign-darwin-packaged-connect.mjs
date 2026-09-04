#!/usr/bin/env node

import { sign } from '@electron/osx-sign';
import { fileURLToPath } from 'node:url';

const CERTIFICATE_SHA1 = /^[A-F0-9]{40}$/u;
const PACKAGED_CONNECT_NATIVE_ARTIFACTS = /\/Resources\/app\.asar\.unpacked\/\.vite\/native\/prebuilds\//u;

export const signDarwinPackagedConnectApplication = async ({
  application,
  keychain,
  certificateSha1,
}) => {
  if (!application.endsWith('.app') || !keychain.endsWith('.keychain-db')
    || !CERTIFICATE_SHA1.test(certificateSha1)) {
    throw new Error('invalid-acceptance-signing-input');
  }
  const designatedRequirement = `designated => identifier "dev.propr.desktop" and certificate leaf = H"${certificateSha1}"`;
  await sign({
    app: application,
    platform: 'darwin',
    identity: certificateSha1,
    keychain,
    // The identity is selected by its generated fingerprint. Avoid osx-sign's trust-dependent
    // `security find-identity` lookup: this disposable keychain is intentionally never trusted.
    identityValidation: false,
    // Preserve inside-out signing while avoiding one noninteractive codesign process per binary.
    batchCodesignCalls: true,
    preEmbedProvisioningProfile: false,
    preAutoEntitlements: false,
    strictVerify: true,
    // These native artifacts have committed byte hashes checked by the smoke.
    // They are sealed as bundle resources but must not be rewritten by codesign.
    ignore: [PACKAGED_CONNECT_NATIVE_ARTIFACTS],
    optionsForFile: filePath => ({
      timestamp: 'none',
      ...(filePath === application ? { requirements: `=${designatedRequirement}` } : {}),
    }),
  });
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [application, keychain, certificateSha1] = process.argv.slice(2);
  try {
    if (process.platform !== 'darwin' || !application || !keychain || !certificateSha1) {
      throw new Error('invalid-invocation');
    }
    await signDarwinPackagedConnectApplication({ application, keychain, certificateSha1 });
  } catch {
    process.stderr.write('Darwin packaged Connect application signing failed.\n');
    process.exitCode = 1;
  }
}
