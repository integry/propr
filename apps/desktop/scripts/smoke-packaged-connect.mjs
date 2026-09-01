import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { encodedWindowsFixtureAcl } from './windows-fixture-acl.mjs';

if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
  throw new Error('Packaged Connect discovery smoke requires Darwin, Linux, or Windows');
}
if (process.arch !== 'x64' && process.arch !== 'arm64') {
  throw new Error('Packaged Connect discovery smoke requires x64 or arm64');
}

const artifactRoot = resolve('out', `propr-desktop-${process.platform}-${process.arch}`);
const binaryPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop')
  : join(artifactRoot, process.platform === 'linux' ? 'propr-desktop' : 'propr-desktop.exe');
const resourcesPath = process.platform === 'darwin'
  ? join(artifactRoot, 'propr-desktop.app', 'Contents', 'Resources')
  : join(artifactRoot, 'resources');
const unpackedNative = join(resourcesPath, 'app.asar.unpacked', '.vite', 'native', 'prebuilds');
const readyEvent = 'desktop.renderer.connect_discovery.ready';
const endpoint = 'https://t-packaged123.propr.dev';
const identity = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secrets = [
  'tunnel-secret-SENTINEL', 'connector-secret-SENTINEL',
  'relay-secret-SENTINEL', 'github-secret-SENTINEL',
];
const nativeHashes = {
  darwin: {
    arm64: {
      'connect-authority-broker': '75fda2624bf093555e726b968401321fef61ea7ae0479f4c1892be0dfc6554c0',
      'directory-operations.node': '88f07c0c7a4371f4fb227a4691009d09517de582ba49297d28d03ac94e586615',
    },
    x64: {
      'connect-authority-broker': 'e5a49be0db85655b9ff1d0614de9d61defd41a0a1b2eff8f11571407f10d809b',
      'directory-operations.node': '62183c0f4083cb8c98e09e2d2c688f8f81703e12b0f22320c335b51e927eaf53',
    },
  },
  linux: {
    arm64: {
      'directory-operations.node': '916679f413251c4b23c51167987a874bbbdd9d96991882bfac9093e0ea5fa051',
    },
    x64: {
      'directory-operations.node': '7199378f1c7b443a05c596eae7c66f9a77cc01b4a493c07748df0df1083950f6',
    },
  },
};
const CHILD_CAPTURE_MAX_BYTES = 64 * 1024;
const CHILD_DIAGNOSTIC_MAX_RECORDS = 20;
const childDiagnosticEvents = new Set([
  'desktop.app.ready',
  'desktop.app.start_failed',
  'desktop.log.write_failed',
  'desktop.main_process.uncaught_exception',
  'desktop.renderer.connect_discovery.ready',
  'desktop.renderer.connect_discovery.phase',
  'desktop.renderer.connect_discovery.status',
  'desktop.renderer.gone',
  'desktop.renderer.ready',
]);
const childDiagnosticCodes = new Set([
  'CONNECT_STATUS_INCOMPATIBLE',
  'CONNECT_STATUS_INTERNAL_FAILURE',
  'CONNECT_STATUS_INVALID_CONFIG',
  'CONNECT_STATUS_NOT_READY',
  'CONNECT_STATUS_READY',
  'CONNECT_STATUS_TIMEOUT',
  'DETAIL_REDACTED',
  'LOG_WRITE_FAILED',
  'OPERATION_FAILED',
  'UNCAUGHT_EXCEPTION',
]);
const childDiagnosticPhases = new Set([
  'config-read',
  'addon-integrity-type',
  'addon-load',
  'descriptor-operation',
  'authority-inspection',
  'status-resolution',
]);
const childDiagnosticPhaseCodes = new Set(['STARTED', 'PASSED', 'FAILED']);
const childDiagnosticSubsteps = new Set(['directory-open', 'addon-open', 'fstat-type']);
const childDiagnosticCategories = new Set([
  'access-denied',
  'invalid-argument',
  'io-failure',
  'missing-entry',
  'not-directory',
  'symlink-refused',
  'type-mismatch',
  'unexpected',
]);

const childRecords = output => output.split(/\r?\n/).flatMap(line => {
  try {
    const record = JSON.parse(line.slice(line.indexOf('{')));
    return record && typeof record === 'object' && !Array.isArray(record) ? [record] : [];
  } catch { return []; }
});

const boundedChildDiagnostics = records => records.flatMap(record => {
  if (!record || typeof record !== 'object' || !childDiagnosticEvents.has(record.event)) return [];
  const nestedCode = record.error && typeof record.error === 'object' ? record.error.code : undefined;
  const candidateCode = typeof record.code === 'string' ? record.code : nestedCode;
  const phase = typeof record.phase === 'string' ? record.phase : undefined;
  const substep = typeof record.substep === 'string' ? record.substep : undefined;
  const category = typeof record.category === 'string' ? record.category : undefined;
  return [{
    event: record.event,
    ...(childDiagnosticPhases.has(phase) && childDiagnosticPhaseCodes.has(candidateCode)
      ? {
          phase,
          code: candidateCode,
          ...(candidateCode === 'FAILED' && childDiagnosticSubsteps.has(substep) ? { substep } : {}),
          ...(candidateCode === 'FAILED' && childDiagnosticCategories.has(category) ? { category } : {}),
        }
      : childDiagnosticCodes.has(candidateCode)
        ? { code: candidateCode }
        : {}),
  }];
}).slice(0, CHILD_DIAGNOSTIC_MAX_RECORDS);

const authorityMechanism = () => {
  if (process.platform === 'darwin') return 'packaged-broker';
  if (process.platform === 'linux') return 'in-process-native-addon';
  return 'inherited-standard-handle';
};

const assertCanonicalParents = async candidate => {
  let parent = dirname(candidate);
  while (true) {
    const named = await lstat(parent);
    if (!named.isDirectory() || named.isSymbolicLink() || await realpath(parent) !== parent) {
      throw new Error('Packaged native candidate has noncanonical parent ancestry');
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
};

const assertPackageAuthority = async () => {
  if (process.platform === 'win32') {
    try {
      await lstat(unpackedNative);
      throw new Error('Windows package unexpectedly contains an unused native authority helper');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  const selected = join(unpackedNative, `${process.platform}-${process.arch}`);
  for (const [name, expected] of Object.entries(nativeHashes[process.platform][process.arch])) {
    const candidate = join(selected, name);
    await assertCanonicalParents(candidate);
    const named = await lstat(candidate);
    if (!named.isFile()
      || named.isSymbolicLink()
      || (named.mode & 0o022) !== 0
      || (name === 'connect-authority-broker' && (named.mode & 0o111) === 0)) {
      throw new Error('Packaged native authority artifact failed type or mode verification');
    }
    const digest = createHash('sha256').update(await readFile(candidate)).digest('hex');
    if (digest !== expected) throw new Error('Packaged native authority artifact failed integrity verification');
  }
  const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
  try {
    await lstat(join(unpackedNative, `${process.platform}-${otherArch}`));
    throw new Error('Package contains unselected architecture authority artifacts');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const windowsFixtureFailure = (phase, category) => {
  const error = new Error(`Could not prepare the ordinary-user Windows authority fixture [phase=${phase} category=${category}]`);
  error.stack = error.message;
  throw error;
};

const protectWindowsEntries = entries => {
  const membership = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Out.Write(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))',
  ], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
  if (membership.error || membership.signal || membership.status !== 0 || membership.stderr) {
    windowsFixtureFailure('membership', 'process-failed');
  }
  if (membership.stdout !== 'False') windowsFixtureFailure('membership', 'administrator');
  for (const entry of entries) {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWindowsFixtureAcl,
    ], {
      shell: false,
      windowsHide: true,
      timeout: 30_000,
      env: {
        ...process.env,
        PROPR_FIXTURE_ACL_KIND: entry.kind,
        PROPR_FIXTURE_ACL_PATH: entry.path,
      },
    });
    if (result.error || result.signal) windowsFixtureFailure('powershell-invocation', 'process-failed');
    if (result.stdout.length !== 0) windowsFixtureFailure('powershell-invocation', 'powershell-stdout');
    if (result.stderr.length !== 0) windowsFixtureFailure('powershell-invocation', 'powershell-stderr');
    const failurePhase = new Map([
      [40, 'path-qualification'],
      [41, 'item-type'],
      [42, 'current-sid-lookup'],
      [43, 'sid-construction'],
      [44, 'get-acl'],
      [45, 'dacl-protection'],
      [46, 'rule-create'],
      [47, 'rule-apply'],
    ]).get(result.status);
    if (failurePhase) windowsFixtureFailure(failurePhase, 'operation-failed');
    if (result.status !== 0) windowsFixtureFailure('powershell-invocation', 'unexpected-exit');
  }
};

const canonicalTemp = await realpath(tmpdir());
const fixture = await mkdtemp(join(canonicalTemp, 'propr-desktop-connect-smoke-'));
const configRoot = join(fixture, 'config');
const stackRoot = join(fixture, 'stack-private-path-SENTINEL');
const dataRoot = join(stackRoot, 'data');
const identityPath = join(dataRoot, 'public-instance-identity.json');
const envPath = join(stackRoot, '.env');
const configPath = join(configRoot, 'config.json');
const userDataPath = join(fixture, 'desktop-user-data');

try {
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify({ stackRoot })}\n`, { mode: 0o600 });
  await writeFile(envPath, [
    'PROPR_STACK=packaged-connect-smoke',
    'PROPR_INSTANCE_ID=packaged123',
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    'PROPR_UI_TUNNEL_ENABLED=true',
    `PROPR_UI_TUNNEL_TOKEN=${secrets[0]}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(identityPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: identity })}\n`, { mode: 0o644 });
  if (process.platform !== 'win32') {
    await Promise.all([
      chmod(fixture, 0o700), chmod(configRoot, 0o700), chmod(stackRoot, 0o700),
      chmod(dataRoot, 0o700), chmod(userDataPath, 0o700), chmod(configPath, 0o600),
      chmod(envPath, 0o600), chmod(identityPath, 0o644),
    ]);
  } else {
    protectWindowsEntries([
      { path: stackRoot, kind: 'directory' },
      { path: dataRoot, kind: 'directory' },
      { path: envPath, kind: 'file' },
      { path: identityPath, kind: 'file' },
    ]);
  }
  await assertPackageAuthority();

  let output = '';
  const sensitiveNeedles = [
    ...secrets, fixture, configRoot, stackRoot, identity,
    'S-1-5-', 'volumeSerialNumber', 'fileId', 'authorityDiagnostic',
  ];
  const maximumNeedleLength = Math.max(...sensitiveNeedles.map(value => value.length));
  const capturedChunks = [];
  let capturedBytes = 0;
  let captureTruncated = false;
  let scanTail = '';
  let sensitiveOutputObserved = false;
  const child = spawn(binaryPath, ['--disable-gpu', `--user-data-dir=${userDataPath}`], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PROPR_DESKTOP_CONNECT_SMOKE_TEST: '1',
      PROPR_DESKTOP_CONNECT_SMOKE_CONFIG_ROOT: configRoot,
      PROPR_CONNECTOR_TOKEN: secrets[1],
      PROPR_RELAY_TOKEN: secrets[2],
      GITHUB_TOKEN: secrets[3],
    },
  });
  const capture = chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const text = bytes.toString('utf8');
    const scan = `${scanTail}${text}`;
    if (sensitiveNeedles.some(needle => scan.includes(needle))) sensitiveOutputObserved = true;
    scanTail = scan.slice(-(maximumNeedleLength - 1));
    const remaining = CHILD_CAPTURE_MAX_BYTES - capturedBytes;
    if (remaining > 0) {
      capturedChunks.push(bytes.subarray(0, remaining));
      capturedBytes += Math.min(bytes.byteLength, remaining);
    }
    if (bytes.byteLength > remaining) captureTruncated = true;
  };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error('Packaged Connect discovery smoke timed out'));
    }, 300_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout); resolveResult({ code, signal });
    });
  });
  output = Buffer.concat(capturedChunks, capturedBytes).toString('utf8');
  if (sensitiveOutputObserved || sensitiveNeedles.some(sentinel => output.includes(sentinel))) {
    throw new Error('Packaged Connect discovery output leaked secret, path, or native evidence');
  }
  const records = childRecords(output);
  if (result.code !== 0 || result.signal) {
    process.stderr.write(`${JSON.stringify({
      event: 'packaged_connect.child_failed',
      category: result.signal ? 'signal' : 'nonzero-exit',
      capture: captureTruncated ? 'truncated' : 'complete',
      records: boundedChildDiagnostics(records),
    })}\n`);
    throw new Error('Packaged Connect discovery app failed');
  }
  const proof = records.find(record => record.event === readyEvent);
  const expectedMechanism = authorityMechanism();
  if (!proof
    || proof.selectedPlatform !== process.platform
    || proof.selectedArch !== process.arch
    || proof.authorityMechanism !== expectedMechanism
    || proof.rendererSchemaValid !== true) throw new Error('Packaged Connect discovery proof was incomplete');
  if (relative(canonicalTemp, configRoot).startsWith('..')) throw new Error('Connect smoke config escaped its fixed root');
  process.stdout.write(`Packaged Connect discovery passed for ${process.platform}-${process.arch}: ${expectedMechanism}.\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
