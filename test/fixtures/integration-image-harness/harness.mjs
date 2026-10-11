// Shared fixture for the scripts/integration-test-images.sh regressions. The
// harness runs from a synthetic checkout with a synthetic .env and key, against
// fake docker, curl and npm binaries. No real credential or configuration file
// is read.
//
// The regression is split across several test files, one per runner unit. Each
// harness run is a long serial chain of short-lived processes, so its wall time
// scales with host contention: one contended nightly stretched a single case
// from 8s to 94s and the former single file past the 180s per-unit timeout.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fakeDockerClient, startFakeDockerDaemon } from './fake-docker.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');
const harnessScript = join(repoRoot, 'scripts/integration-test-images.sh');
export const rootHelper = join(repoRoot, 'scripts/lib/integration-test-root.sh');
export const unsupported = process.platform === 'win32';
// Root bypasses the permission bits used to emulate a container-owned subtree.
export const hostCannotRemovePrivateSubtree = !unsupported && process.getuid?.() !== 0;
const uid = unsupported ? 0 : process.getuid();
export const syntheticToken = 'ghs_SyntheticOnlyToken0000000000';
const syntheticKey = 'SYNTHETIC-NOT-A-REAL-KEY\n';
export const fakeDockerDaemon = unsupported ? undefined : await startFakeDockerDaemon();

export function bash(script, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', script, 'bash', ...args], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

export function makeWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'itest-harness-test-')));
  const workspace = {
    root,
    bin: join(root, 'bin'),
    state: join(root, 'docker-state'),
    tmp: join(root, 'tmp'),
    home: join(root, 'home'),
    checkout: join(root, 'checkout'),
  };
  for (const directory of [workspace.bin, workspace.state, workspace.tmp, workspace.home, join(workspace.checkout, 'scripts/lib')]) {
    mkdirSync(directory, { recursive: true });
  }
  copyFileSync(harnessScript, join(workspace.checkout, 'scripts/integration-test-images.sh'));
  copyFileSync(rootHelper, join(workspace.checkout, 'scripts/lib/integration-test-root.sh'));
  writeFileSync(join(workspace.checkout, 'synthetic-key.pem'), syntheticKey, { mode: 0o600 });
  writeFileSync(join(workspace.checkout, '.env'), [
    'GH_APP_ID=0',
    'GH_PRIVATE_KEY_PATH=./synthetic-key.pem',
    'SYNTHETIC_SECRET=synthetic-only-value',
    'SESSION_SECRET=overridden-by-the-harness',
    '',
  ].join('\n'), { mode: 0o600 });

  writeFileSync(join(workspace.bin, 'docker'), fakeDockerClient(fakeDockerDaemon.port), { mode: 0o755 });
  // curl records its argv and whether the bearer token arrived via stdin config.
  writeFileSync(join(workspace.bin, 'curl'), `#!/usr/bin/env bash
config=""
for arg in "$@"; do [ "$arg" = "-" ] && config="$(cat)"; done
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/curl-args"
if [ -n "$config" ]; then printf '%s\\n' "$config" >> "$FAKE_DOCKER_STATE/curl-config"; fi
case "$*" in
  *%{http_code}*) printf 200 ;;
  */health*) printf ok ;;
  *) printf '{}' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(workspace.bin, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_STATE/npm-calls"
if [ "\${FAKE_E2E_DENY_DOCKER:-}" = 1 ]; then : > "$FAKE_DOCKER_STATE/socket-denied"; fi
exit "\${FAKE_E2E_EXIT:-0}"
`, { mode: 0o755 });
  return workspace;
}

export function forceRemove(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      chmodSync(join(path, entry.name), 0o700);
      forceRemove(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

export const userBase = (workspace) => join(workspace.tmp, `propr-itest-${uid}`);
export const stackRoot = (workspace, stack = 'propr-itest') => join(userBase(workspace), stack);
export const modeOf = (path) => (lstatSync(path).mode & 0o777).toString(8);
export const readState = (workspace) => JSON.parse(readFileSync(join(workspace.state, 'state.json'), 'utf8'));
export const readObserved = (workspace) => JSON.parse(readFileSync(join(workspace.state, 'observed.json'), 'utf8'));
export const dockerCalls = (workspace) => {
  const path = join(workspace.state, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};
export const isMutation = ([command, subcommand]) => ['run', 'rm', 'stop'].includes(command)
  || (command === 'network' && ['rm', 'create'].includes(subcommand));
export const networkRemovals = (workspace) => dockerCalls(workspace).filter(([command, subcommand]) => command === 'network' && subcommand === 'rm');
export const markerToken = (workspace) => /^token=(.+)$/m.exec(readFileSync(join(stackRoot(workspace), '.propr-itest-owner'), 'utf8'))[1];

export function seedUnrelatedDocker(workspace, extra = {}) {
  const state = {
    containers: {
      'personal-propr-api': {
        Id: 'a'.repeat(64), Name: '/personal-propr-api',
        Config: { Labels: { 'propr.stack': 'personal-propr', 'propr.service': 'api' } }, Mounts: [],
      },
      ...extra.containers,
    },
    networks: { 'personal-propr-net': { Id: 'b'.repeat(64) }, ...extra.networks },
  };
  writeFileSync(join(workspace.state, 'state.json'), JSON.stringify(state));
}

export async function runHarness(workspace, env = {}) {
  const outside = join(workspace.root, 'outside-sentinel');
  if (!existsSync(outside)) {
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'keep.txt'), 'unrelated');
  }
  if (!existsSync(join(workspace.state, 'state.json'))) seedUnrelatedDocker(workspace);
  const result = await bash('umask 022; exec bash "$HARNESS"', [], {
    HARNESS: join(workspace.checkout, 'scripts/integration-test-images.sh'),
    PATH: `${workspace.bin}:${process.env.PATH}`,
    HOME: workspace.home,
    TMPDIR: workspace.tmp,
    FAKE_DOCKER_STATE: workspace.state,
    PROPR_E2E_TOKEN: syntheticToken,
    PROPR_E2E_SKIP_SLOW: '1',
    STACK: 'propr-itest',
    PROPR_E2E_KEEP_STACK: '',
    PROPR_E2E_REUSE_DATA: '',
    ...env,
  });
  // Unrelated host data and Docker resources always survive.
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal(readFileSync(join(workspace.checkout, 'synthetic-key.pem'), 'utf8'), syntheticKey);
  const state = readState(workspace);
  assert.ok(state.containers['personal-propr-api'], 'unrelated container survives');
  assert.ok(state.networks['personal-propr-net'], 'unrelated network survives');
  // The token never reaches output or a process argument list.
  assert.ok(!result.stdout.includes(syntheticToken) && !result.stderr.includes(syntheticToken));
  assert.ok(!JSON.stringify(dockerCalls(workspace)).includes(syntheticToken));
  const curlArgs = join(workspace.state, 'curl-args');
  if (existsSync(curlArgs)) assert.ok(!readFileSync(curlArgs, 'utf8').includes(syntheticToken));
  return result;
}

export function assertNoStackContainers(workspace) {
  const remaining = Object.keys(readState(workspace).containers).filter((name) => name.startsWith('propr-itest-'));
  assert.deepEqual(remaining, []);
  assert.ok(!readState(workspace).networks['propr-itest-net']);
}
