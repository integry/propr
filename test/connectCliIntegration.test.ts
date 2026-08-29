import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getOrCreatePublicInstanceIdentity } from '../packages/cli/src/connectIdentity.js';

const CLI = join(process.cwd(), 'packages', 'cli', 'dist', 'index.js');
const FETCH_FIXTURE = join(process.cwd(), 'test', 'fixtures', 'connectFetchMock.mjs');
const IDENTITY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'https://t-abc123.propr.dev';

function makeRoot(parent: string, name: string, endpoint = ENDPOINT): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'data'), 0o700);
  writeFileSync(join(root, '.env'), [
    'PROPR_STACK=authorized',
    'PROPR_INSTANCE_ID=abc123',
    `PROPR_UI_PUBLIC_API_URL=${endpoint}`,
    'PROPR_UI_TUNNEL_ENABLED=true',
    'PROPR_UI_TUNNEL_TOKEN=relay-token-in-root-SENTINEL',
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  return root;
}

function installFakeDocker(parent: string): string {
  const bin = join(parent, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const docker = join(bin, 'docker');
  writeFileSync(docker, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const behaviorPath = path.join(__dirname, 'docker-behavior');
const behavior = fs.existsSync(behaviorPath) ? fs.readFileSync(behaviorPath, 'utf8') : 'ready';
const replacementPath = path.join(__dirname, 'replace-root');
if (fs.existsSync(replacementPath)) {
  const root = fs.readFileSync(replacementPath, 'utf8');
  const detached = root + '.detached';
  fs.renameSync(root, detached);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(path.join(root, 'data'), 0o700);
  fs.writeFileSync(path.join(root, '.env'), 'REPLACEMENT_BYTES_SENTINEL=never-read\\n', { mode: 0o600 });
}
process.stderr.write('docker-private-output-SENTINEL\\n');
if (behavior === 'nonzero') process.exit(9);
if (behavior === 'timeout') setInterval(() => {}, 60_000);
if (behavior === 'signal') process.kill(process.pid, 'SIGTERM');
if (behavior === 'malformed') process.stdout.write('authorized-tunnel running malformed-output-SENTINEL\\n');
else if (behavior === 'truncated') process.stdout.write('x'.repeat(70 * 1024));
else if (behavior === 'absent') process.stdout.write('');
else if (behavior === 'stopped') process.stdout.write('authorized-tunnel\\texited\\tExited (0) 1 second ago\\t\\n');
else process.stdout.write('authorized-tunnel\\trunning\\tUp 1 second\\t\\n');
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  return bin;
}

interface InvocationOptions {
  cli?: string;
  dockerBehavior?: 'ready' | 'absent' | 'stopped' | 'nonzero' | 'timeout' | 'signal' | 'malformed' | 'truncated';
  replaceRoot?: boolean;
  windowsSemantics?: boolean;
  arguments?: string[];
}

function invoke(
  root: string,
  mode: string,
  bin: string,
  privateParent: string,
  options: InvocationOptions = {},
): { status: number | null; stdout: string; stderr: string; document: Record<string, unknown> } {
  const credentialPath = join(privateParent, 'credential-path-SENTINEL');
  const behaviorPath = join(bin, 'docker-behavior');
  const replacementPath = join(bin, 'replace-root');
  if (options.dockerBehavior) writeFileSync(behaviorPath, options.dockerBehavior, { mode: 0o600 });
  if (options.replaceRoot) writeFileSync(replacementPath, root, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    '--import',
    FETCH_FIXTURE,
    options.cli ?? CLI,
    ...(options.arguments ?? ['connect', 'status', '--json', '--root', root]),
  ], {
    shell: false,
    cwd: join(privateParent, 'hostile-cwd'),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: bin,
      HOME: join(privateParent, 'home-private-SENTINEL'),
      PROPR_TEST_DISCOVERY_MODE: mode,
      PROPR_TEST_PUBLIC_IDENTITY: IDENTITY,
      PROPR_TEST_PLATFORM: options.windowsSemantics ? 'win32' : '',
      PROPR_STACK: 'ambient-stack-SENTINEL',
      PROPR_NETWORK: 'ambient-network-SENTINEL',
      PROPR_ROOT: join(privateParent, 'ambient-root-SENTINEL'),
      PROPR_INSTANCE_ID: 'ambient-instance-SENTINEL',
      PROPR_UI_PUBLIC_API_URL: 'https://t-ambient.propr.dev',
      PROPR_UI_TUNNEL_ENABLED: 'false',
      PROPR_UI_TUNNEL_TOKEN: 'ambient-tunnel-token-SENTINEL',
      API_PUBLIC_URL: 'https://t-ambient-api.propr.dev',
      API_PORT: '4999',
      UI_PORT: '5999',
      DOCS_PORT: '6999',
      HOST_DATA_DIR: join(privateParent, 'ambient-data-SENTINEL'),
      HOST_LOGS_DIR: join(privateParent, 'ambient-logs-SENTINEL'),
      HOST_REPOS_DIR: join(privateParent, 'ambient-repos-SENTINEL'),
      PROPR_CONNECTOR_TOKEN: 'connector-token-SENTINEL',
      PROPR_RELAY_TOKEN: 'relay-token-SENTINEL',
      GITHUB_TOKEN: 'github-token-SENTINEL',
      GH_PRIVATE_KEY_PATH: credentialPath,
      UNTRUSTED_RAW_URL: 'https://userinfo:secret@raw-url-SENTINEL.invalid/path',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rmSync(behaviorPath, { force: true });
  rmSync(replacementPath, { force: true });
  assert.equal(result.signal, null);
  assert.ok(
    result.stdout.length > 0 && result.stdout.length < 2048,
    `status=${result.status} stderr=${result.stderr}`,
  );
  assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
  const document = JSON.parse(result.stdout) as Record<string, unknown>;
  const expectedStderr = document.status === 'ready'
    ? ''
    : `ProPR Connect discovery: ${document.status}.\n`;
  assert.equal(result.stderr, expectedStderr);
  assert.ok(result.stderr.length < 128);
  for (const sentinel of [
    'connector-token-SENTINEL',
    'relay-token-SENTINEL',
    'github-token-SENTINEL',
    credentialPath,
    privateParent,
    'docker-private-output-SENTINEL',
    'raw-url-SENTINEL',
    'REPLACEMENT_BYTES_SENTINEL',
    'transport-SENTINEL',
    'ambient-stack-SENTINEL',
    'ambient-instance-SENTINEL',
    'INTERPOLATION_SECRET_PATH_SENTINEL',
  ]) {
    assert.equal(result.stdout.includes(sentinel), false, `stdout leaked ${sentinel}`);
    assert.equal(result.stderr.includes(sentinel), false, `stderr leaked ${sentinel}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, document };
}

test('the built CLI emits one bounded secret-free JSON document for every exit class', () => {
  const parent = mkdtempSync(join(tmpdir(), 'propr-built-connect-cli-'));
  chmodSync(parent, 0o700);
  const bin = installFakeDocker(parent);
  mkdirSync(join(parent, 'home-private-SENTINEL'), { mode: 0o700 });
  mkdirSync(join(parent, 'hostile-cwd'), { mode: 0o700 });
  writeFileSync(join(parent, 'hostile-cwd', '.env'), [
    'PROPR_STACK=cwd-stack-SENTINEL',
    'PROPR_UI_PUBLIC_API_URL=https://t-cwd-SENTINEL.propr.dev',
    'HOST_DATA_DIR=${INTERPOLATION_SECRET_PATH_SENTINEL}',
  ].join('\n'), { mode: 0o600 });
  try {
    const readyRoot = makeRoot(parent, 'ready-private-root-SENTINEL');
    assert.equal(getOrCreatePublicInstanceIdentity(join(readyRoot, 'data'), () => IDENTITY), IDENTITY);
    const ready = invoke(readyRoot, 'ready', bin, parent);
    assert.equal(ready.status, 0, JSON.stringify(ready.document));
    assert.equal(ready.document.status, 'ready');
    assert.equal(ready.document.canonicalEndpoint, ENDPOINT);

    const equalsRoot = invoke(readyRoot, 'ready', bin, parent, {
      arguments: ['--project', 'owner/repo', 'connect', 'status', `--root=${readyRoot}`, '--json'],
    });
    assert.equal(equalsRoot.status, 0);
    assert.equal(equalsRoot.document.canonicalEndpoint, ENDPOINT);

    for (const dockerBehavior of ['absent', 'stopped'] as const) {
      const notReady = invoke(readyRoot, 'ready', bin, parent, { dockerBehavior });
      assert.equal(notReady.status, 2, dockerBehavior);
      assert.equal(notReady.document.status, 'notReady', dockerBehavior);
      assert.deepEqual(notReady.document.reasonCodes, ['SIDECAR_NOT_RUNNING'], dockerBehavior);
    }

    for (const [name, failureBin, dockerBehavior] of [
      ['ENOENT', join(parent, 'missing-docker-bin'), undefined],
      ['daemon nonzero', bin, 'nonzero'],
      ['timeout', bin, 'timeout'],
      ['signal', bin, 'signal'],
      ['malformed output', bin, 'malformed'],
      ['truncated output', bin, 'truncated'],
    ] as const) {
      mkdirSync(failureBin, { recursive: true, mode: 0o700 });
      const failure = invoke(readyRoot, 'ready', failureBin, parent, { dockerBehavior });
      assert.equal(failure.status, 1, name);
      assert.equal(failure.document.status, 'internalFailure', name);
      assert.deepEqual(failure.document.reasonCodes, ['INTERNAL_FAILURE'], name);
    }

    const unreachable = invoke(readyRoot, 'unreachable', bin, parent);
    assert.equal(unreachable.status, 2);
    assert.deepEqual(unreachable.document.reasonCodes, ['API_UNREACHABLE']);

    for (const mode of ['unsupported', 'invalid', 'invalid-utf8']) {
      const incompatible = invoke(readyRoot, mode, bin, parent);
      assert.equal(incompatible.status, 3, mode);
      assert.equal(incompatible.document.status, 'incompatible');
    }

    const invalidEndpointRoot = makeRoot(parent, 'invalid-endpoint-root', `${ENDPOINT}/path`);
    assert.equal(getOrCreatePublicInstanceIdentity(join(invalidEndpointRoot, 'data'), () => IDENTITY), IDENTITY);
    const invalidEndpoint = invoke(invalidEndpointRoot, 'ready', bin, parent);
    assert.equal(invalidEndpoint.status, 4);
    assert.deepEqual(invalidEndpoint.document.reasonCodes, ['INVALID_ENDPOINT']);

    const missingRoot = invoke(join(parent, 'missing-private-root'), 'ready', bin, parent);
    assert.equal(missingRoot.status, 4, JSON.stringify(missingRoot.document));
    assert.deepEqual(missingRoot.document.reasonCodes, ['INVALID_ROOT']);

    const timeout = invoke(readyRoot, 'timeout', bin, parent);
    assert.equal(timeout.status, 5);
    assert.equal(timeout.document.status, 'timeout');

    const replacedRoot = makeRoot(parent, 'replaced-private-root');
    assert.equal(getOrCreatePublicInstanceIdentity(join(replacedRoot, 'data'), () => IDENTITY), IDENTITY);
    const replaced = invoke(replacedRoot, 'ready', bin, parent, { replaceRoot: true });
    assert.equal(replaced.status, 4);
    assert.deepEqual(replaced.document.reasonCodes, ['INVALID_ROOT']);

    const copiedPackage = join(parent, 'copied-built-cli');
    cpSync(join(process.cwd(), 'packages', 'cli'), copiedPackage, { recursive: true });
    symlinkSync(join(process.cwd(), 'node_modules'), join(parent, 'node_modules'), 'dir');
    rmSync(join(copiedPackage, 'dist', 'orchestrator', 'manifest.json'));
    const internal = invoke(
      readyRoot,
      'ready',
      bin,
      parent,
      { cli: join(copiedPackage, 'dist', 'index.js') },
    );
    assert.equal(internal.status, 1);
    assert.equal(internal.document.status, 'internalFailure');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the built CLI rejects malformed roots under Unix and fail-closed Windows semantics', () => {
  const parent = mkdtempSync(join(tmpdir(), 'propr-built-connect-root-'));
  chmodSync(parent, 0o700);
  const bin = installFakeDocker(parent);
  mkdirSync(join(parent, 'home-private-SENTINEL'), { mode: 0o700 });
  mkdirSync(join(parent, 'hostile-cwd'), { mode: 0o700 });
  writeFileSync(join(parent, 'hostile-cwd', '.env'), 'PROPR_STACK=cwd-stack-SENTINEL\n', { mode: 0o600 });
  try {
    const root = makeRoot(parent, 'real-root');
    const alias = join(parent, 'root-alias');
    symlinkSync(root, alias, 'dir');
    const symlink = invoke(alias, 'ready', bin, parent);
    assert.equal(symlink.status, 4);
    assert.deepEqual(symlink.document.reasonCodes, ['INVALID_ROOT']);

    chmodSync(join(root, 'data'), 0o777);
    const unsafe = invoke(root, 'ready', bin, parent);
    assert.equal(unsafe.status, 4);
    assert.deepEqual(unsafe.document.reasonCodes, ['INVALID_ROOT']);

    chmodSync(join(root, 'data'), 0o700);
    const windows = invoke(root, 'ready', bin, parent, { windowsSemantics: true });
    assert.equal(windows.status, 4);
    assert.deepEqual(windows.document.reasonCodes, ['INVALID_ROOT']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
