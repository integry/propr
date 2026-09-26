import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverDarwinSignablePaths } from './sign-darwin-packaged-connect.mjs';
import { runBoundedProcess } from './run-bounded-darwin-command.mjs';

const IDENTIFIER = 'dev.propr.desktop';
const nativeDirectory = application => join(application, 'Contents', 'Resources',
  'app.asar.unpacked', '.vite', 'native', 'prebuilds', 'darwin-arm64');
const nativeArtifacts = application => ['directory-operations.node', 'connect-authority-broker']
  .map(name => join(nativeDirectory(application), name));

const codesign = (runCommand, arguments_) => runCommand({
  executable: '/usr/bin/codesign',
  arguments: arguments_,
  timeoutMs: 30_000,
  terminationGraceMs: 1_000,
  maxOutputBytes: 256 * 1024,
  forwardOutput: false,
});

const verifyCode = (runCommand, target, deep = false) => codesign(runCommand, [
  '--verify', '--all-architectures', '--strict', '--verbose=2',
  ...(deep ? ['--deep'] : []), target,
]);

// Code in Resources can be sealed as data, so --deep alone does not prove
// that each unpacked native executable has a valid code signature.
export const verifyDarwinLocalPackage = async ({
  application,
  discover = discoverDarwinSignablePaths,
  runCommand = runBoundedProcess,
}) => {
  const targets = await discover(join(application, 'Contents'));
  for (const target of new Set([...nativeArtifacts(application), ...targets])) {
    await verifyCode(runCommand, target);
  }
  await verifyCode(runCommand, application, true);
  const details = await codesign(runCommand, ['--display', '--verbose=4', application]);
  const output = `${details.stdout}\n${details.stderr}`;
  if (!/^Signature=adhoc\s*$/mu.test(output)
    || !new RegExp(`^Identifier=${IDENTIFIER.replaceAll('.', '\\.')}\\s*$`, 'mu').test(output)) {
    throw new Error('Local ARM64 package must have an ad-hoc signature for dev.propr.desktop');
  }
};

export const signDarwinLocalPackage = async ({
  application,
  discover = discoverDarwinSignablePaths,
  runCommand = runBoundedProcess,
}) => {
  // These linker-signed ARM64 prebuilds are hash-pinned by the CLI. Preserve
  // their bytes and fail before signing anything if either signature is invalid.
  const immutableNative = new Set(nativeArtifacts(application));
  for (const target of immutableNative) await verifyCode(runCommand, target);
  // Discovery is post-order: Mach-O files before their helper/framework bundle,
  // nested bundles before parents. Sign the outer application last, never --deep.
  const targets = await discover(join(application, 'Contents'));
  for (const target of [...targets.filter(path => !immutableNative.has(path)), application]) {
    await codesign(runCommand, [
      '--sign', '-', '--force', '--timestamp=none',
      '--preserve-metadata=entitlements,flags,runtime',
      ...(target === application ? ['--identifier', IDENTIFIER] : []),
      target,
    ]);
  }
  await verifyDarwinLocalPackage({ application, discover, runCommand });
};

export const finalizeDarwinLocalPackages = async ({
  platform, arch, outputPaths, signingIdentity,
}, sign = signDarwinLocalPackage) => {
  // Bounded to the unsigned Apple Silicon local-test package. Certificate-signed
  // releases keep the packager's signing/notarization path and are never re-signed.
  if (platform !== 'darwin' || arch !== 'arm64' || signingIdentity) return;
  for (const outputPath of outputPaths) {
    await sign({ application: join(outputPath, 'propr-desktop.app') });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin' || process.argv.length !== 3) {
    throw new Error('Expected one local ARM64 application pathname on macOS');
  }
  await verifyDarwinLocalPackage({ application: resolve(process.argv[2]) });
  process.stdout.write('Local ARM64 bundle and nested signatures verified\n');
}
