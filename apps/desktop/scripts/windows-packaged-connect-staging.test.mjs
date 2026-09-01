import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPackagedWindowsPeArchitecture,
  assertWindowsStagedPackagePreflightResult,
  classifyWindowsArtifactFailure,
  describeWindowsArtifactFailure,
  packagedConnectArtifactSensitiveNeedles,
  parseWindowsStagedPackageContract,
  validateWindowsStagedPackage,
  WINDOWS_ARTIFACT_FAILURE_CATEGORIES,
  WINDOWS_ARTIFACT_FAILURE_PHASES,
  WINDOWS_ARTIFACT_FAILURE_SUBPHASES,
  WindowsArtifactFailure,
} from './windows-packaged-connect-staging.mjs';
import { windowsPowerShell51Path } from './windows-fixture-acl.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;
const orchestratorPath = fileURLToPath(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url));
const taskkillPath = String.raw`C:\Windows\System32\taskkill.exe`;

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

const processExists = processId => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const waitForProcessExit = async (processId, timeoutMilliseconds = 5_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processExists(processId);
};

const startNativeNodeTree = async () => {
  const rootSource = String.raw`
const { spawn } = require('node:child_process');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});
process.stdout.write(String(descendant.pid) + '\n');
setInterval(() => {}, 1000);
`;
  const root = spawn(process.execPath, ['-e', rootSource], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const descendantProcessId = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('native process tree did not start')), 5_000);
    root.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    root.stdout.on('data', chunk => {
      output += chunk.toString('ascii');
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      const value = output.slice(0, newline).trim();
      if (!/^[1-9][0-9]{0,9}$/u.test(value)) reject(new Error('native descendant pid was invalid'));
      else resolve(Number(value));
    });
  });
  return { root, descendantProcessId };
};

const terminateTreeAfterTest = processId => {
  if (!Number.isSafeInteger(processId) || processId < 1 || !processExists(processId)) return;
  spawnSync(taskkillPath, ['/PID', String(processId), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
    timeout: 5_000,
  });
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
    const invalidSubphase = new WindowsArtifactFailure(
      'artifact-inaccessible',
      'ordinary-user-preflight',
      String.raw`C:\secret\account-name-S-1-5-21-123`,
    );
    assert.equal(invalidSubphase.subphase, undefined);
    assert.doesNotMatch(invalidSubphase.message, /[A-Z]:\\|S-1-5-|account-name/iu);
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
        new WindowsArtifactFailure(
          'artifact-type',
          'ordinary-user-preflight',
          'authority-contract',
        ),
        'application-spawn',
      ),
      {
        category: 'artifact-type',
        phase: 'ordinary-user-preflight',
        subphase: 'authority-contract',
      },
    );
    assert.deepEqual(
      describeWindowsArtifactFailure(new Error('--token secret'), 'application-spawn'),
      { category: 'spawn-failed', phase: 'application-spawn' },
    );
  });

  test('maps every preflight transport and exit result to fixed subphase evidence', () => {
    assert.deepEqual(WINDOWS_ARTIFACT_FAILURE_SUBPHASES, [
      'preflight-invocation',
      'descendant-enumeration',
      'executable-read',
      'unexpected-exit',
      'authority-contract',
    ]);
    const clean = status => ({
      status,
      error: undefined,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    assert.doesNotThrow(() => assertWindowsStagedPackagePreflightResult(clean(0)));

    for (const [status, category, subphase] of [
      [80, 'artifact-type', 'authority-contract'],
      [81, 'artifact-type', 'authority-contract'],
      [82, 'artifact-type', 'authority-contract'],
      [83, 'artifact-inaccessible', 'descendant-enumeration'],
      [84, 'artifact-type', 'authority-contract'],
      [85, 'artifact-inaccessible', 'executable-read'],
      [1, 'artifact-inaccessible', 'unexpected-exit'],
      [86, 'artifact-inaccessible', 'unexpected-exit'],
      [null, 'artifact-inaccessible', 'unexpected-exit'],
    ]) {
      assert.throws(
        () => assertWindowsStagedPackagePreflightResult(clean(status)),
        error => error instanceof WindowsArtifactFailure
          && error.category === category
          && error.phase === 'ordinary-user-preflight'
          && error.subphase === subphase,
      );
    }

    const invocationFailures = [
      { ...clean(null), error: new Error(String.raw`C:\secret\invoke.exe`) },
      { ...clean(null), signal: 'SIGTERM' },
      { ...clean(0), stdout: Buffer.from('raw stdout account-name') },
      { ...clean(0), stderr: Buffer.from('raw stderr S-1-5-21-123') },
      { ...clean(0), stdout: 'not-a-buffer' },
      { ...clean(0), stderr: 'not-a-buffer' },
    ];
    for (const result of invocationFailures) {
      assert.throws(
        () => assertWindowsStagedPackagePreflightResult(result),
        error => error instanceof WindowsArtifactFailure
          && error.category === 'artifact-inaccessible'
          && error.phase === 'ordinary-user-preflight'
          && error.subphase === 'preflight-invocation',
      );
    }
  });

  test('preflight diagnostics exclude path, SID, account name, stdout, and stderr evidence', () => {
    const clean = status => ({
      status,
      error: undefined,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const hostileResult = {
      status: 85,
      error: new Error(String.raw`C:\runner-temp\secret\propr-desktop.exe account-name S-1-5-21-123`),
      signal: null,
      stdout: Buffer.from('raw stdout account-name'),
      stderr: Buffer.from(String.raw`raw stderr C:\secret S-1-5-21-123`),
    };
    const diagnosticFor = result => {
      try {
        assertWindowsStagedPackagePreflightResult(result);
        assert.fail('the preflight result must fail');
      } catch (error) {
        return JSON.stringify({
          event: 'packaged_connect.artifact_failed',
          ...describeWindowsArtifactFailure(error, 'ordinary-user-preflight'),
        });
      }
    };
    const diagnostics = [
      diagnosticFor(hostileResult),
      diagnosticFor(clean(83)),
      diagnosticFor(clean(85)),
      diagnosticFor(clean(86)),
      diagnosticFor(clean(84)),
    ];
    assert.deepEqual(
      diagnostics.map(diagnostic => JSON.parse(diagnostic).subphase),
      [
        'preflight-invocation',
        'descendant-enumeration',
        'executable-read',
        'unexpected-exit',
        'authority-contract',
      ],
    );
    assert.doesNotMatch(
      diagnostics.join('\n'),
      /[A-Z]:\\|S-1-5-|account-name|raw stdout|raw stderr/iu,
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
  assert.match(orchestrator, /\$taskkillExecutable = 'C:\\Windows\\System32\\taskkill\.exe'/u);
  assert.match(
    orchestrator,
    /\$taskkillStart\.Arguments = \[String\]::Join\(' ', \[string\[\]\]@\('\/PID', \$processIdText, '\/T', '\/F'\)\)/u,
  );
  assert.match(orchestrator, /\$taskkillStart\.UseShellExecute = \$false/u);
  assert.match(orchestrator, /\$processIdText -cnotmatch '\^\[1-9\]\[0-9\]\{0,9\}\$'/u);
  assert.match(orchestrator, /\$taskkillProcess\.WaitForExit\(\$terminationTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /Task\]::WaitAll\([\s\S]*?\$streamCloseTimeoutMilliseconds/u);
  assert.doesNotMatch(orchestrator, /(?:cmd(?:\.exe)?|powershell(?:\.exe)?)['"]?\s+\/c[\s\S]*?taskkill/iu);
  assert.match(orchestrator, /WaitForExit\(\$cleanupTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /if\(!\$cleanupProcess\.WaitForExit[\s\S]*?\$cleanupProcess\.Kill\(\)[\s\S]*?WaitForExit\(\$terminationTimeoutMilliseconds\)/u);
  assert.match(orchestrator, /Remove-Item -LiteralPath \$root -Recurse/u);
  assert.doesNotMatch(orchestrator, /Remove-Item -LiteralPath \$parent -Recurse/u);
  assert.match(orchestrator, /\$createdAccount\.SID\.Value -cne \$testUserSid\.Value/u);
  assert.match(orchestrator, /\$administratorsSid\.Translate\(\[Security\.Principal\.NTAccount\]\)/u);
  assert.match(orchestrator, /\.psbase\.Invoke\('IsMember', \$ordinaryUserEntry\.Path\)/u);
  assert.doesNotMatch(orchestrator, /Get-LocalGroupMember/u);
  assert.doesNotMatch(orchestrator, /Get-Content|Write-(?:Host|Error|Verbose|Debug|Information)|GITHUB_WORKSPACE/u);
  assert.match(orchestrator, /\$primaryPhase -ceq 'ordinary-user-preflight'[\s\S]*?\$failureSubphases -ccontains \$primarySubphase/u);
  assert.match(orchestrator, /\$subphaseEvidence = ":subphase=\$primarySubphase"/u);
  assert.match(orchestrator, /PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=\$primaryFailure`:phase=\$primaryPhase\$subphaseEvidence`:cleanup=\$cleanupSecondary/u);

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

test('the bounded cleanup source requires proven child exit and bounded stream closure', async () => {
  const orchestrator = await readFile(new URL('./run-packaged-windows-connect-smoke.ps1', import.meta.url), 'utf8');
  const boundedCleanup = orchestrator.slice(
    orchestrator.indexOf('function Invoke-BoundedCleanup'),
    orchestrator.indexOf('$authenticatedRunnerTemp = $null'),
  );
  assert.match(boundedCleanup, /\$cleanupProcess=\[Diagnostics\.Process\]::new\(\)/u);
  assert.match(
    boundedCleanup,
    /if\(!\$cleanupProcess\.WaitForExit\(\$cleanupTimeoutMilliseconds\)\)\{[\s\S]*?\$cleanupProcess\.Kill\(\)[\s\S]*?if\(!\$cleanupProcess\.WaitForExit\(\$terminationTimeoutMilliseconds\)\)\{return 'failed'\}[\s\S]*?Task\]::WaitAll[\s\S]*?return 'timeout'/u,
  );
  assert.match(boundedCleanup, /\$cleanupOutputClose=\$cleanupProcess\.StandardOutput\.BaseStream\.CopyToAsync/u);
  assert.match(boundedCleanup, /\$cleanupErrorClose=\$cleanupProcess\.StandardError\.BaseStream\.CopyToAsync/u);
});

windowsTest('the native timeout path terminates an actual child and descendant tree', async context => {
  const { root, descendantProcessId } = await startNativeNodeTree();
  context.after(() => terminateTreeAfterTest(root.pid));
  context.after(() => terminateTreeAfterTest(descendantProcessId));
  assert.equal(processExists(root.pid), true);
  assert.equal(processExists(descendantProcessId), true);

  const result = spawnSync(windowsPowerShell51Path(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    orchestratorPath,
    '-Architecture',
    process.arch,
    '-LifecycleTestMode',
    'terminate-tree',
    '-LifecycleTestProcessId',
    String(root.pid),
  ], {
    shell: false,
    windowsHide: true,
    timeout: 15_000,
  });

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString('utf8').trim(),
    'PROPR_WINDOWS_PACKAGED_CONNECT_LIFECYCLE_TEST:tree-terminated');
  assert.equal(result.stderr.length, 0);
  assert.equal(await waitForProcessExit(root.pid), true, 'the native harness root must terminate');
  assert.equal(await waitForProcessExit(descendantProcessId), true,
    'the native harness descendant must terminate');
});

windowsTest('a real never-settling cleanup is bounded, terminated, and remains secondary', () => {
  const startedAt = Date.now();
  const result = spawnSync(windowsPowerShell51Path(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    orchestratorPath,
    '-Architecture',
    process.arch,
    '-LifecycleTestMode',
    'cleanup-timeout',
  ], {
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  const elapsedMilliseconds = Date.now() - startedAt;

  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.length, 0);
  assert.equal(
    result.stderr.toString('utf8').trim(),
    'PROPR_WINDOWS_PACKAGED_CONNECT:failed:category=artifact-type:phase=staged-tree:cleanup=cleanup-timeout',
  );
  assert.ok(elapsedMilliseconds >= 750, 'the injected cleanup must reach its deadline');
  assert.ok(elapsedMilliseconds < 8_000, 'the cleanup deadline and termination must remain bounded');
});
