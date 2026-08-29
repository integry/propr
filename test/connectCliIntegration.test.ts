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
import { delimiter, join } from 'node:path';
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
    'PROPR_STACK=propr',
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
  writeFileSync(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.env.PROPR_TEST_REPLACE_ROOT) {
  const root = process.env.PROPR_TEST_REPLACE_ROOT;
  const detached = root + '.detached';
  fs.renameSync(root, detached);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.chmodSync(path.join(root, 'data'), 0o700);
  fs.writeFileSync(path.join(root, '.env'), 'REPLACEMENT_BYTES_SENTINEL=never-read\\n', { mode: 0o600 });
}
process.stderr.write('docker-private-output-SENTINEL\\n');
if (process.env.PROPR_TEST_DOCKER_FAILURE === '1') process.exit(9);
process.stdout.write('propr-tunnel\\trunning\\tUp 1 second\\t\\n');
`, { mode: 0o700 });
  chmodSync(docker, 0o700);
  return bin;
}

interface InvocationOptions {
  cli?: string;
  dockerFailure?: boolean;
  replaceRoot?: boolean;
  windowsSemantics?: boolean;
}

function invoke(
  root: string,
  mode: string,
  bin: string,
  privateParent: string,
  options: InvocationOptions = {},
): { status: number | null; stdout: string; stderr: string; document: Record<string, unknown> } {
  const credentialPath = join(privateParent, 'credential-path-SENTINEL');
  const result = spawnSync(process.execPath, [
    '--import',
    FETCH_FIXTURE,
    options.cli ?? CLI,
    'connect',
    'status',
    '--json',
    '--root',
    root,
  ], {
    shell: false,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      HOME: join(privateParent, 'home-private-SENTINEL'),
      PROPR_TEST_DISCOVERY_MODE: mode,
      PROPR_TEST_PUBLIC_IDENTITY: IDENTITY,
      PROPR_TEST_DOCKER_FAILURE: options.dockerFailure ? '1' : '0',
      PROPR_TEST_REPLACE_ROOT: options.replaceRoot ? root : '',
      PROPR_TEST_PLATFORM: options.windowsSemantics ? 'win32' : '',
      PROPR_CONNECTOR_TOKEN: 'connector-token-SENTINEL',
      PROPR_RELAY_TOKEN: 'relay-token-SENTINEL',
      GITHUB_TOKEN: 'github-token-SENTINEL',
      GH_PRIVATE_KEY_PATH: credentialPath,
      UNTRUSTED_RAW_URL: 'https://userinfo:secret@raw-url-SENTINEL.invalid/path',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  try {
    const readyRoot = makeRoot(parent, 'ready-private-root-SENTINEL');
    assert.equal(getOrCreatePublicInstanceIdentity(join(readyRoot, 'data'), () => IDENTITY), IDENTITY);
    const ready = invoke(readyRoot, 'ready', bin, parent);
    assert.equal(ready.status, 0);
    assert.equal(ready.document.status, 'ready');

    const dockerFailure = invoke(readyRoot, 'ready', bin, parent, { dockerFailure: true });
    assert.equal(dockerFailure.status, 2);
    assert.equal(dockerFailure.document.status, 'notReady');

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
