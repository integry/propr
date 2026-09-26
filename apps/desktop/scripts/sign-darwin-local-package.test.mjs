import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discoverDarwinSignablePaths } from './sign-darwin-packaged-connect.mjs';
import {
  finalizeDarwinLocalPackages,
  signDarwinLocalPackage,
  verifyDarwinLocalPackage,
} from './sign-darwin-local-package.mjs';

const application = '/tmp/ProPR local test/propr-desktop.app';
const nativeRoot = 'Contents/Resources/app.asar.unpacked/.vite/native/prebuilds/darwin-arm64';
const natives = ['directory-operations.node', 'connect-authority-broker']
  .map(name => join(application, nativeRoot, name));
const helper = join(application, 'Contents/Frameworks/propr-desktop Helper.app');
const helperExecutable = join(helper, 'Contents/MacOS/propr-desktop Helper');
const targets = [helperExecutable, helper, ...natives];
const discover = async () => targets;
const signature = { stdout: '', stderr: 'Identifier=dev.propr.desktop\nSignature=adhoc\n' };

test('signs inside-out after verifying pinned native code, preserving its bytes', async () => {
  const calls = [];
  await signDarwinLocalPackage({
    application, discover,
    runCommand: async options => { calls.push(options); return signature; },
  });
  assert.deepEqual(calls.slice(0, 2).map(call => call.arguments.at(-1)), natives);
  assert.ok(calls.slice(0, 2).every(call => call.arguments[0] === '--verify'));
  const signing = calls.filter(call => call.arguments[0] === '--sign');
  assert.deepEqual(signing.map(call => call.arguments.at(-1)), [helperExecutable, helper, application]);
  for (const call of signing) {
    assert.equal(call.arguments[1], '-');
    assert.ok(call.arguments.includes('--preserve-metadata=entitlements,flags,runtime'));
    assert.ok(!call.arguments.includes('--deep'));
  }
  assert.ok(signing.at(-1).arguments.includes('dev.propr.desktop'));
  assert.ok(calls.some(call => call.arguments.includes('--deep') && call.arguments[0] === '--verify'));
  for (const call of calls) {
    assert.equal(call.executable, '/usr/bin/codesign');
    assert.equal(call.timeoutMs, 30_000);
    assert.equal(call.maxOutputBytes, 256 * 1024);
  }
});

test('fails closed on native, helper, signing, and final verification failures', async () => {
  for (const [operation, target] of [
    ['--verify', natives[0]], ['--sign', helper],
    ['--verify', helperExecutable], ['--verify', application],
  ]) {
    let failed = false;
    await assert.rejects(signDarwinLocalPackage({
      application, discover,
      runCommand: async ({ arguments: args }) => {
        assert.equal(failed, false, 'must not continue after a failed codesign');
        if (args[0] === operation && args.at(-1) === target) {
          failed = true;
          throw new Error('invalid signature');
        }
        return signature;
      },
    }), /invalid signature/);
  }
});

test('verification requires both the final bundle identifier and ad-hoc signature', async () => {
  for (const stderr of ['', 'Identifier=com.github.Electron\nSignature=adhoc\n',
    'Identifier=dev.propr.desktop\nAuthority=Developer ID Application\n']) {
    await assert.rejects(verifyDarwinLocalPackage({
      application, discover, runCommand: async () => ({ stdout: '', stderr }),
    }), /must have an ad-hoc signature/);
  }
});

test('finalization is limited to unsigned Darwin ARM64 output and propagates failure', async () => {
  const calls = [];
  const sign = async options => calls.push(options);
  const options = { platform: 'darwin', arch: 'arm64', outputPaths: ['/tmp/package'] };
  for (const overrides of [
    { platform: 'linux' }, { platform: 'win32' }, { platform: 'mas' },
    { arch: 'x64' }, { signingIdentity: 'Developer ID Application: Example' },
  ]) await finalizeDarwinLocalPackages({ ...options, ...overrides }, sign);
  assert.deepEqual(calls, []);
  await finalizeDarwinLocalPackages(options, sign);
  assert.deepEqual(calls, [{ application: join('/tmp/package', 'propr-desktop.app') }]);
  await assert.rejects(finalizeDarwinLocalPackages(options, async () => {
    throw new Error('sign failed');
  }), /sign failed/);
});

test('discovery includes unpacked native code and visits framework versions once through real paths', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-local-sign-discovery-'));
  try {
    const framework = join(root, 'Electron Framework.framework');
    const version = join(framework, 'Versions/A');
    await mkdir(version, { recursive: true });
    const executable = join(version, 'Electron Framework');
    await writeFile(executable, Buffer.from([0xCF, 0xFA, 0xED, 0xFE]));
    await symlink('A', join(framework, 'Versions/Current'));
    await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
    const native = join(root, 'Resources/app.asar.unpacked/addon.node');
    await mkdir(join(root, 'Resources/app.asar.unpacked'), { recursive: true });
    await writeFile(native, Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]));
    assert.deepEqual(await discoverDarwinSignablePaths(root), [executable, framework, native]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// CI passes the package pathname explicitly so a missing build cannot silently
// skip the native check. This test never launches Electron or accesses Keychain.
const nativeApplication = process.env.PROPR_DESKTOP_TEST_LOCAL_SIGNATURE_APP;
test('native packaged bundle rejects plist/resource/helper/native tampering and can be sealed after final edits', {
  skip: !nativeApplication,
  timeout: 300_000,
}, async () => {
  assert.equal(process.platform, 'darwin');
  const root = await mkdtemp(join(tmpdir(), 'propr-local-sign-regression-'));
  const copy = join(root, 'propr-desktop.app');
  try {
    await cp(nativeApplication, copy, { recursive: true, verbatimSymlinks: true });
    await verifyDarwinLocalPackage({ application: copy });
    const artifacts = ['directory-operations.node', 'connect-authority-broker']
      .map(name => join(copy, nativeRoot, name));
    const originalNative = await Promise.all(artifacts.map(path => readFile(path)));
    const nested = await discoverDarwinSignablePaths(join(copy, 'Contents'));
    const helperBundle = nested.find(path => path.endsWith(' Helper.app'));
    assert.ok(helperBundle, 'packaged Electron helper must be present');
    for (const path of [
      join(copy, 'Contents/Info.plist'),
      join(copy, 'Contents/Resources/propr-tray.png'),
      join(helperBundle, 'Contents/Info.plist'),
      ...artifacts,
    ]) {
      const original = await readFile(path);
      try {
        // Whitespace preserves valid plist syntax but invalidates its signed hash.
        await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
        await assert.rejects(verifyDarwinLocalPackage({ application: copy }),
          `verification must reject changed ${path}`);
      } finally { await writeFile(path, original); }
    }
    const plist = join(copy, 'Contents/Info.plist');
    await writeFile(plist, Buffer.concat([await readFile(plist), Buffer.from('\n')]));
    await signDarwinLocalPackage({ application: copy });
    for (const [index, path] of artifacts.entries()) {
      assert.deepEqual(await readFile(path), originalNative[index], 'native hash pins must survive signing');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
