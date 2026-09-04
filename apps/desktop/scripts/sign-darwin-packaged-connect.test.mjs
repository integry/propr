import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  DARWIN_SIGNING_DIAGNOSTICS,
  classifyDarwinSigningFailure,
  darwinSigningDiagnosticLine,
  discoverDarwinSignablePaths,
  signDarwinPackagedConnectApplication,
} from './sign-darwin-packaged-connect.mjs';

const fingerprint = 'A'.repeat(40);
const application = '/tmp/propr-desktop.app';
const keychain = '/tmp/propr-smoke.keychain-db';
const nativeArtifact = `${application}/Contents/Resources/app.asar.unpacked/.vite/native/prebuilds/darwin-arm64/directory-operations.node`;

describe('Darwin packaged Connect direct signing', () => {
  test('discovers Mach-O files and nested code bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-darwin-signables-'));
    try {
      const helper = join(root, 'Helper.app');
      const executable = join(helper, 'Contents', 'MacOS', 'Helper');
      const framework = join(root, 'Library.framework');
      await mkdir(join(helper, 'Contents', 'MacOS'), { recursive: true });
      await mkdir(framework);
      await writeFile(executable, Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x00]));
      await writeFile(join(root, 'data.bin'), Buffer.from('not executable code'));
      assert.deepEqual(await discoverDarwinSignablePaths(root), [
        executable,
        helper,
        framework,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('selects the exact certificate and signs inside-out with fixed noninteractive options', async () => {
    const calls = [];
    const framework = `${application}/Contents/Frameworks/Electron Framework.framework`;
    const helper = `${application}/Contents/Frameworks/propr Helper.app`;
    const helperExecutable = `${helper}/Contents/MacOS/propr Helper`;
    const mainExecutable = `${application}/Contents/MacOS/propr-desktop`;
    await signDarwinPackagedConnectApplication({
      application,
      keychain,
      certificateSha1: fingerprint,
      discover: async () => [mainExecutable, framework, helper, helperExecutable, nativeArtifact],
      runCommand: async options => {
        calls.push(options);
        if (options.executable === '/usr/bin/security') {
          return { stdout: `SHA-1 hash: ${fingerprint}\n`, stderr: '' };
        }
        return { stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(calls[0].arguments, ['find-certificate', '-a', '-Z', keychain]);
    const signingCalls = calls.filter(call => call.arguments[0] === '--sign');
    const signedTargets = signingCalls.flatMap(call => call.arguments.filter(argument => (
      argument.startsWith(application)
    )));
    assert.equal(signedTargets.includes(nativeArtifact), false);
    assert.equal(signedTargets.at(-1), application);
    assert.ok(signedTargets.indexOf(helperExecutable) < signedTargets.indexOf(helper));
    assert.ok(signedTargets.indexOf(helper) < signedTargets.indexOf(mainExecutable));
    for (const call of signingCalls) {
      assert.equal(call.executable, '/usr/bin/codesign');
      assert.deepEqual(call.arguments.slice(0, 7), [
        '--sign', fingerprint,
        '--force',
        '--keychain', keychain,
        '--timestamp=none',
        '--preserve-metadata=identifier,entitlements,flags',
      ]);
      assert.equal(call.forwardOutput, false);
      assert.equal(call.timeoutMs, 30_000);
      assert.equal(call.terminationGraceMs, 1_000);
    }
    assert.ok(signingCalls.at(-1).arguments.includes(
      `-r=designated => identifier "dev.propr.desktop" and certificate leaf = H"${fingerprint}"`,
    ));
    assert.deepEqual(calls.at(-1).arguments, [
      '--verify', '--deep', '--strict', application,
    ]);
  });

  test('fails before codesign when the imported certificate is absent or ambiguous', async () => {
    for (const stdout of [
      '',
      `SHA-1 hash: ${fingerprint}\nSHA-1 hash: ${'B'.repeat(40)}\n`,
    ]) {
      await assert.rejects(signDarwinPackagedConnectApplication({
        application,
        keychain,
        certificateSha1: fingerprint,
        discover: async () => [],
        runCommand: async () => ({ stdout, stderr: '' }),
      }), error => (
        classifyDarwinSigningFailure(error)
          === DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain
      ));
    }
  });

  test('emits only fixed classified diagnostics for sensitive native failures', () => {
    const secret = 'SECRET_PATH_PASSWORD_FINGERPRINT';
    const cases = [
      ['CSSMERR_TP_NOT_TRUSTED', DARWIN_SIGNING_DIAGNOSTICS.trustRejection],
      ['unable to build chain to self-signed root', DARWIN_SIGNING_DIAGNOSTICS.missingIdentityOrChain],
      ['invalid designated requirement', DARWIN_SIGNING_DIAGNOSTICS.requirementsFailure],
      ['codesign failed', DARWIN_SIGNING_DIAGNOSTICS.codesignFailure],
    ];
    for (const [stderr, diagnostic] of cases) {
      const line = darwinSigningDiagnosticLine({ stderr: `${stderr} ${secret}` });
      assert.equal(line, `DARWIN_PACKAGED_CONNECT_DIAGNOSTIC:${diagnostic}\n`);
      assert.doesNotMatch(line, new RegExp(secret, 'u'));
    }
  });
});
