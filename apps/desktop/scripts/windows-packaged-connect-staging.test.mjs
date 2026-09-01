import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertPackagedWindowsPeArchitecture,
  classifyWindowsArtifactFailure,
  describeWindowsArtifactFailure,
  packagedConnectArtifactSensitiveNeedles,
  parseWindowsStagedPackageContract,
  validateWindowsStagedPackage,
  WINDOWS_ARTIFACT_FAILURE_CATEGORIES,
  WINDOWS_ARTIFACT_FAILURE_PHASES,
  WindowsArtifactFailure,
} from './windows-packaged-connect-staging.mjs';

const parent = String.raw`C:\runner-temp\propr-connect-packaged-stage`;
const leaf = 'propr-connect-package-0123456789abcdef0123456789abcdef';
const environment = {
  RUNNER_TEMP: String.raw`C:\runner-temp`,
  PROPR_DESKTOP_CONNECT_STAGING_PARENT: parent,
  PROPR_DESKTOP_CONNECT_STAGING_LEAF: leaf,
};
const regularFile = {
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const regularDirectory = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};

const peFixture = architecture => {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(architecture === 'arm64' ? 0xaa64 : 0x8664, 0x84);
  return bytes;
};

const validationOptions = overrides => ({
  environment,
  expectedArchitecture: 'arm64',
  inspectPath: async path => path.endsWith('.exe') || path.endsWith('.asar')
    ? regularFile
    : regularDirectory,
  canonicalize: async (kind, path) => ({ path }),
  readHeader: async () => peFixture('arm64'),
  preflight: async () => {},
  ...overrides,
});

describe('packaged Windows Connect staging contract', () => {
  test('accepts only the exact generated leaf below the fixed canonical staging parent', () => {
    const contract = parseWindowsStagedPackageContract(environment);
    assert.equal(contract.parent, parent);
    assert.equal(contract.root, win32.join(parent, leaf));
    assert.equal(contract.executable, win32.join(parent, leaf, 'propr-desktop.exe'));

    for (const invalid of [
      {},
      { PROPR_DESKTOP_CONNECT_STAGED_ROOT: contract.root },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`C:\runner-temp\other` },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: `${parent}\\` },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`C:\runner-temp\x\..\propr-connect-packaged-stage` },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`\\server\share\propr-connect-packaged-stage` },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: '../package' },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: 'propr-connect-package-ABCDEF0123456789abcdef0123456789' },
      { ...environment, PROPR_DESKTOP_CONNECT_STAGING_LEAF: 'propr-connect-package-0123' },
    ]) {
      assert.throws(
        () => parseWindowsStagedPackageContract(invalid),
        error => error instanceof WindowsArtifactFailure
          && error.category === 'artifact-type'
          && error.phase === 'staged-contract',
      );
    }
  });

  test('rejects missing, inaccessible, reparse, wrong-type, and noncanonical entries before preflight', async () => {
    let preflightCalls = 0;
    const assertCategory = async (inspectPath, canonicalize, category) => {
      await assert.rejects(
        validateWindowsStagedPackage(validationOptions({
          inspectPath,
          canonicalize: canonicalize ?? (async (kind, path) => ({ path })),
          preflight: async () => { preflightCalls += 1; },
        })),
        error => error instanceof WindowsArtifactFailure && error.category === category,
      );
    };
    await assertCategory(async () => { const error = new Error('sensitive path'); error.code = 'ENOENT'; throw error; }, null, 'artifact-missing');
    await assertCategory(async () => { const error = new Error('sensitive path'); error.code = 'EACCES'; throw error; }, null, 'artifact-inaccessible');
    await assertCategory(async () => ({ ...regularDirectory, isSymbolicLink: () => true }), null, 'artifact-type');
    await assertCategory(async () => regularFile, null, 'artifact-type');
    await assertCategory(
      async path => path.endsWith('.exe') || path.endsWith('.asar') ? regularFile : regularDirectory,
      async (kind, path) => ({ path: `${path}-alias` }),
      'artifact-type',
    );
    assert.equal(preflightCalls, 0, 'a rejected package must fail before the access preflight');
  });

  test('proves target PE architecture and ordinary-user access before returning the executable', async () => {
    let preflightCalls = 0;
    const result = await validateWindowsStagedPackage(validationOptions({
      preflight: async paths => {
        preflightCalls += 1;
        assert.equal(paths.executable, win32.join(parent, leaf, 'propr-desktop.exe'));
      },
    }));
    assert.equal(result.root, win32.join(parent, leaf));
    assert.equal(preflightCalls, 1);

    await assert.rejects(
      validateWindowsStagedPackage(validationOptions({ readHeader: async () => peFixture('x64') })),
      error => error instanceof WindowsArtifactFailure && error.category === 'architecture-mismatch',
    );
    await assert.rejects(
      validateWindowsStagedPackage(validationOptions({
        preflight: async () => { throw new Error('C:\\sensitive\\package'); },
      })),
      error => error instanceof WindowsArtifactFailure && error.category === 'artifact-inaccessible',
    );
  });

  test('keeps PE type and architecture failures distinct', () => {
    assert.doesNotThrow(() => assertPackagedWindowsPeArchitecture(peFixture('arm64'), 'arm64'));
    assert.throws(
      () => assertPackagedWindowsPeArchitecture(Buffer.from('not a PE'), 'arm64'),
      error => error.category === 'artifact-type',
    );
    assert.throws(
      () => assertPackagedWindowsPeArchitecture(peFixture('x64'), 'arm64'),
      error => error.category === 'architecture-mismatch',
    );
  });

  test('maps hostile exceptions to a fixed path-free allowlist', () => {
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_CATEGORIES, [
      'artifact-missing',
      'artifact-inaccessible',
      'artifact-type',
      'architecture-mismatch',
      'spawn-failed',
    ]);
    const hostile = new Error(String.raw`spawn C:\secret\propr-desktop.exe ENOENT --token=secret`);
    hostile.code = 'ENOENT';
    assert.equal(classifyWindowsArtifactFailure(hostile), 'artifact-missing');
    assert.equal(classifyWindowsArtifactFailure(new Error('username SID environment stack')), 'spawn-failed');
    for (const category of WINDOWS_ARTIFACT_FAILURE_CATEGORIES) {
      const failure = new WindowsArtifactFailure(category, 'staged-tree');
      assert.equal(classifyWindowsArtifactFailure(failure), category);
      assert.doesNotMatch(failure.message, /[A-Z]:\\|S-1-5-|--|username|environment|stack/iu);
    }
  });

  test('classifies fixed phases without collapsing pre-spawn failures into spawn', () => {
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_PHASES, [
      'staged-contract',
      'staged-tree',
      'staged-architecture',
      'ordinary-user-preflight',
      'fixture-setup',
      'package-authority',
      'application-spawn',
      'application-runtime',
      'result-verify',
    ]);
    assert.deepEqual(
      describeWindowsArtifactFailure(new Error(String.raw`C:\secret\account`), 'fixture-setup'),
      { category: 'artifact-inaccessible', phase: 'fixture-setup' },
    );
    assert.deepEqual(
      describeWindowsArtifactFailure(
        new WindowsArtifactFailure('artifact-type', 'ordinary-user-preflight'),
        'application-spawn',
      ),
      { category: 'artifact-type', phase: 'ordinary-user-preflight' },
    );
    assert.deepEqual(
      describeWindowsArtifactFailure(new Error('--token secret'), 'application-spawn'),
      { category: 'spawn-failed', phase: 'application-spawn' },
    );
  });

  test('scopes staged-root and executable leak needles to Windows', () => {
    const options = {
      artifactRoot: String.raw`C:\runner-temp\stage\leaf`,
      binaryPath: String.raw`C:\runner-temp\stage\leaf\propr-desktop.exe`,
      environment: {
        PROPR_DESKTOP_CONNECT_STAGING_PARENT: String.raw`C:\runner-temp\stage`,
        PROPR_DESKTOP_CONNECT_STAGING_LEAF: 'leaf',
      },
    };
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'darwin', ...options }), []);
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'linux', ...options }), []);
    assert.deepEqual(packagedConnectArtifactSensitiveNeedles({ platform: 'win32', ...options }), [
      options.artifactRoot,
      options.binaryPath,
      options.environment.PROPR_DESKTOP_CONNECT_STAGING_PARENT,
      options.environment.PROPR_DESKTOP_CONNECT_STAGING_LEAF,
    ]);
  });
});

test('the workflow stages before alternate credentials and the harness preflights before application spawn', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/desktop-connect-discovery-guard.yml', import.meta.url), 'utf8');
  const orchestrator = await readFile(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url), 'utf8');
  const harness = await readFile(new URL('./smoke-packaged-connect.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /run-packaged-windows-connect-smoke\.ps1\s+-Architecture '\$\{\{ matrix\.arch \}\}'/u);
  assert.doesNotMatch(workflow, /Start-Process|Get-Content|New-LocalUser/u);

  const copy = orchestrator.indexOf('Copy-Item -LiteralPath $entry.FullName');
  const acl = orchestrator.indexOf('Set-StagedEntryAcl $item');
  const alternateLaunch = orchestrator.indexOf('$process = Start-Process');
  assert.ok(copy >= 0 && copy < acl && acl < alternateLaunch);
  assert.doesNotMatch(orchestrator.slice(alternateLaunch, alternateLaunch + 700), /\s-Wait(?:\s|`)/u);
  assert.match(orchestrator, /Assert-PeArchitecture \$sourceExecutable \$Architecture/u);
  assert.match(orchestrator, /Assert-PeArchitecture \$stagedExecutable \$Architecture/u);
  assert.match(orchestrator, /FileSystemRights\]::ReadAndExecute/u);
  assert.match(orchestrator, /FileSystemRights\]::FullControl/u);
  assert.match(orchestrator, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(orchestrator, /SetOwner\(\$Administrators\)/u);
  assert.match(orchestrator, /\[Diagnostics\.Process\]::new\(\)/u);
  assert.match(orchestrator, /WaitForExit\(\$cleanupTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /if\(!\$cleanupProcess\.WaitForExit[\s\S]*?\$cleanupProcess\.Kill\(\)/u);
  assert.match(orchestrator, /Remove-Item -LiteralPath \$root -Recurse/u);
  assert.doesNotMatch(orchestrator, /Remove-Item -LiteralPath \$parent -Recurse/u);
  assert.match(orchestrator, /\$createdAccount\.SID\.Value -cne \$testUserSid\.Value/u);
  assert.match(orchestrator, /\$administratorsSid\.Translate\(\[Security\.Principal\.NTAccount\]\)/u);
  assert.match(orchestrator, /\.psbase\.Invoke\('IsMember', \$ordinaryUserEntry\.Path\)/u);
  assert.doesNotMatch(orchestrator, /Get-LocalGroupMember/u);
  assert.doesNotMatch(orchestrator, /Get-Content|Write-(?:Host|Error|Verbose|Debug|Information)|GITHUB_WORKSPACE/u);
  assert.match(orchestrator, /PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=\$primaryFailure`:phase=\$primaryPhase`:cleanup=\$cleanupSecondary/u);

  const cleanupFinally = orchestrator.slice(orchestrator.lastIndexOf('} finally {'));
  assert.match(cleanupFinally, /\$cleanupResult = Invoke-BoundedCleanup/u);
  assert.doesNotMatch(cleanupFinally, /Get-ChildItem|GetAccessControl|Remove-Item|Test-Path|Remove-LocalUser/u);
  assert.match(cleanupFinally, /if \(\$null -eq \$primaryFailure -and \$cleanupSecondary -ne 'none'\)/u);
  assert.doesNotMatch(
    cleanupFinally.slice(0, cleanupFinally.indexOf("if ($null -eq $primaryFailure")),
    /\$primaryFailure\s*=/u,
    'a cleanup timeout must not replace an existing primary failure',
  );

  const preflight = harness.indexOf('const staged = await validateWindowsStagedPackage');
  const spawn = harness.indexOf("const child = spawn(binaryPath, ['--disable-gpu'");
  assert.ok(preflight >= 0 && preflight < spawn, 'ordinary-user package preflight must complete before spawn');
  assert.match(harness, /shell: false/u);
  assert.match(harness, /delete childEnvironment\.PROPR_DESKTOP_CONNECT_STAGING_PARENT/u);
  assert.match(harness, /delete childEnvironment\.PROPR_DESKTOP_CONNECT_STAGING_LEAF/u);
  assert.match(harness, /describeWindowsArtifactFailure\(error, packagedConnectPhase\)/u);
  assert.match(harness, /packagedConnectArtifactSensitiveNeedles\(\{\s*platform: process\.platform,\s*artifactRoot,\s*binaryPath,/u);
  assert.doesNotMatch(harness, /identity, artifactRoot, binaryPath,/u);
  assert.doesNotMatch(harness, /child\.once\('error', error/u);
});

test('a never-settling cleanup is terminated without replacing the primary failure', async () => {
  const orchestrator = await readFile(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url), 'utf8');
  const boundedCleanup = orchestrator.slice(
    orchestrator.indexOf('function Invoke-BoundedCleanup'),
    orchestrator.indexOf('$authenticatedRunnerTemp = $null'),
  );
  assert.match(boundedCleanup, /\$cleanupProcess=\[Diagnostics\.Process\]::new\(\)/u);
  assert.match(
    boundedCleanup,
    /if\(!\$cleanupProcess\.WaitForExit\(\$cleanupTimeoutMilliseconds\)\)\{[\s\S]*?\$cleanupProcess\.Kill\(\)[\s\S]*?return 'timeout'/u,
  );

  const outcome = orchestrator.slice(orchestrator.lastIndexOf('} finally {'));
  const cleanupEnd = outcome.indexOf("if ($null -eq $primaryFailure");
  assert.ok(cleanupEnd > 0);
  assert.doesNotMatch(outcome.slice(0, cleanupEnd), /\$primaryFailure\s*=/u);
  assert.match(outcome, /\$primaryFailure = 'artifact-inaccessible'\s*\$primaryPhase = 'cleanup'/u);
  assert.match(outcome, /\$cleanupSecondary = 'cleanup-timeout'/u);
});
