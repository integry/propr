import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

// The preview smoke reuses the bounded desktop cleanup helper; its refusal
// boundary (symlink, replaced root, owner, mode, base and name shape) is covered
// by apps/desktop/scripts/smoke-local-runtime.test.mjs.  These tests cover the
// preview lifecycle around it and, when a rootful engine is available, the real
// removal of container-created root-owned data.
const smokeScript = resolve('scripts/smoke-test-preview-runtime-images.sh');
const cleanupHelper = resolve('apps/desktop/scripts/smoke-local-runtime-cleanup.sh');
const fakeDocker = resolve('apps/desktop/scripts/fixtures/runtime-smoke/fake-docker.mjs');
const revision = 'c'.repeat(40);
const compatibility = '2026-06-27';
const version = '9.9.9-preview-smoke';
const label = 'dev.propr.preview-runtime-smoke';
const unsupported = process.platform === 'win32';
// Root bypasses the permission bits used to emulate a container-owned subtree.
const hostCannotRemovePrivateSubtree = !unsupported && process.getuid?.() !== 0;

// Paths reach bash only through the environment, never as shell source.
function bash(script, args, env) {
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

function makeWorkspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'preview-smoke-test-')));
  const bin = join(root, 'bin');
  const state = join(root, 'docker-state');
  const tmp = join(root, 'tmp');
  for (const directory of [bin, state, tmp]) mkdirSync(directory);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`, { mode: 0o755 });
  return { root, bin, state, tmp };
}

function forceRemove(path) {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      chmodSync(join(path, entry.name), 0o700);
      forceRemove(join(path, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

function previewRoots(directory) {
  return readdirSync(directory).filter((name) => name.startsWith('propr-preview-runtime-smoke.'));
}

describe('preview runtime smoke cleanup lifecycle', { skip: unsupported }, () => {
  let server;
  let port;
  let apiCompatibility;

  before(async () => {
    server = createServer((request, response) => {
      const routes = {
        '/api/desktop/discovery': JSON.stringify({
          schemaVersion: 1, product: 'ProPR', apiCompatibility, uiCompatibility: compatibility,
          publicInstanceIdentity: '0f8fad5b-d9cb-469f-a165-70867728950e',
          desktopAuthentication: {
            protocolVersion: 2, browserPairing: true, instanceBearerTokens: true, socketIoBearerAuthentication: true,
          },
        }),
        '/api/compatibility': JSON.stringify({ version }),
        '/': '<!doctype html><script type="module" src="/assets/app.js"></script>',
        '/assets/app.js': 'export {};',
        '/config.js': `window.__PROPR_CONFIG__ = ${JSON.stringify({ apiBaseUrl: `http://127.0.0.1:${port}` })};`,
      };
      if (!(request.url in routes)) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.end(routes[request.url]);
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    port = server.address().port;
  });
  after(() => new Promise((resolvePromise) => server.close(resolvePromise)));

  async function runSmoke(workspace, env = {}) {
    // Unrelated state that must survive: another stack's container and network,
    // and another run's identically shaped temporary root.
    const unrelated = {
      containers: { 'personal-propr-api': { labels: { 'dev.propr.stack': 'personal' } } },
      networks: { 'personal-propr-network': { labels: {} } },
    };
    writeFileSync(join(workspace.state, 'state.json'), JSON.stringify(unrelated));
    const otherRun = join(workspace.tmp, 'propr-preview-runtime-smoke.Other1');
    mkdirSync(join(otherRun, 'data'), { recursive: true, mode: 0o700 });
    writeFileSync(join(otherRun, 'data', 'keep.txt'), 'other run');
    const result = await bash('exec bash "$SMOKE_TEST_SCRIPT"', [], {
      SMOKE_TEST_SCRIPT: smokeScript, PATH: `${workspace.bin}:${process.env.PATH}`,
      RUNNER_TEMP: workspace.tmp, TMPDIR: workspace.tmp, SOURCE_REVISION: revision, EXPECTED_VERSION: version,
      EXPECTED_COMPATIBILITY: compatibility, APP_IMAGE: `propr/app:${revision}`, UI_IMAGE: `propr/ui:${revision}`, FAKE_DOCKER_STATE: workspace.state,
      FAKE_API_PORT: String(port), ...env,
    });
    assert.equal(readFileSync(join(otherRun, 'data', 'keep.txt'), 'utf8'), 'other run');
    const state = JSON.parse(readFileSync(join(workspace.state, 'state.json'), 'utf8'));
    assert.deepEqual(state, unrelated, 'every owned container and network is removed; unrelated ones remain');
    return result;
  }

  function cleanupCalls(workspace) {
    return readFileSync(join(workspace.state, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((call) => call[0] === 'run' && call.includes('--mount'));
  }

  test('returns success only after removing container-owned private data', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    apiCompatibility = compatibility;
    const result = await runSmoke(workspace);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Preview runtime smoke passed for propr\/app:c{40} and propr\/ui:c{40}/);
    assert.deepEqual(previewRoots(workspace.tmp), ['propr-preview-runtime-smoke.Other1']);

    const cleanups = cleanupCalls(workspace);
    assert.equal(cleanups.length, hostCannotRemovePrivateSubtree ? 1 : 0);
    for (const cleanup of cleanups) {
      const mounts = cleanup.filter((_, index) => cleanup[index - 1] === '--mount');
      assert.equal(mounts.length, 1);
      assert.match(mounts[0], new RegExp(`^type=bind,source=${workspace.tmp}/propr-preview-runtime-smoke\\.[A-Za-z0-9]{6},target=/smoke-root$`));
      assert.ok(!cleanup.includes('-v') && !cleanup.includes('--privileged'));
      for (const flag of ['--read-only', '-xdev']) assert.ok(cleanup.includes(flag), flag);
      assert.equal(cleanup[cleanup.indexOf('--network') + 1], 'none');
      assert.equal(cleanup[cleanup.indexOf('--security-opt') + 1], 'no-new-privileges');
      assert.deepEqual(cleanup.filter((_, index) => cleanup[index - 1] === '--cap-add'), ['DAC_OVERRIDE']);
      assert.equal(cleanup[cleanup.indexOf('--cap-drop') + 1], 'ALL');
      assert.equal(cleanup[cleanup.indexOf('--label') + 1].startsWith(`${label}=propr-preview-runtime-smoke-`), true);
    }
  });

  test('keeps a failed smoke nonzero after cleaning up every owned resource', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    apiCompatibility = '2000-01-01';
    const result = await runSmoke(workspace);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not expose the complete desktop contract/);
    assert.doesNotMatch(result.stderr, /did not remove every owned resource/);
    assert.deepEqual(previewRoots(workspace.tmp), ['propr-preview-runtime-smoke.Other1']);
  });

  test('fails before starting any service when the app image cannot run sharp', async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    apiCompatibility = compatibility;
    const result = await runSmoke(workspace, { FAKE_DOCKER_SHARP: 'fail' });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Cannot find module 'sharp'/);
    assert.doesNotMatch(result.stdout, /Preview runtime smoke passed/);
    assert.doesNotMatch(result.stderr, /did not remove every owned resource/);
    const calls = readFileSync(join(workspace.state, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.some((call) => call[0] === 'network' && call[1] === 'create'), false);
    assert.deepEqual(previewRoots(workspace.tmp), ['propr-preview-runtime-smoke.Other1']);
  });

  test('fails a passing smoke when generated data cannot be removed', { skip: !hostCannotRemovePrivateSubtree }, async (t) => {
    const workspace = makeWorkspace();
    t.after(() => forceRemove(workspace.root));
    apiCompatibility = compatibility;
    const result = await runSmoke(workspace, { FAKE_DOCKER_CLEANUP: 'fail' });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Preview runtime smoke passed/);
    assert.match(result.stderr, /generated smoke data remains at/);
    assert.match(result.stderr, /Preview runtime smoke cleanup did not remove every owned resource/);
  });
});

// Opt-in proof against a real rootful engine: PREVIEW_SMOKE_CLEANUP_IMAGE names
// a local image providing `sh` and `find` (the preview workflow uses the freshly
// built app image).  Once opted in, an unsuitable host fails rather than skips.
const realImage = process.env.PREVIEW_SMOKE_CLEANUP_IMAGE;
function assertRootfulDockerHost() {
  assert.ok(!unsupported && process.getuid?.() !== 0, 'requires a non-root POSIX host user');
  const info = spawnSync('docker', ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8' });
  assert.equal(info.status, 0, `Docker is unavailable: ${info.stderr ?? info.error}`);
  assert.doesNotMatch(info.stdout, /rootless/, 'Docker engine must be rootful');
}

describe('preview runtime smoke cleanup on a rootful engine', { skip: !realImage && 'PREVIEW_SMOKE_CLEANUP_IMAGE is not set' }, () => {
  test('removes root-owned 0700 container data without touching an outside symlink target', async (t) => {
    assertRootfulDockerHost();
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'preview-smoke-rootful-')));
    // Removes whatever a failed assertion leaves behind, including root-owned data.
    t.after(() => {
      spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'rm',
        '--mount', `type=bind,source=${workspace},target=/w`, realImage, '-rf', '/w/tmp']);
      rmSync(workspace, { recursive: true, force: true });
    });
    const base = join(workspace, 'tmp');
    mkdirSync(base);
    const stack = `propr-preview-runtime-smoke-regression-${process.pid}`;
    const outside = join(workspace, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'keep.txt'), 'outside');
    const otherRun = join(base, 'propr-preview-runtime-smoke.Other1');
    mkdirSync(otherRun, { mode: 0o700 });
    writeFileSync(join(otherRun, 'keep.txt'), 'other run');

    const created = await bash(
      'set -euo pipefail; source "$SMOKE_TEST_HELPER"; root="$(mktemp -d "$SMOKE_TEST_BASE/propr-preview-runtime-smoke.XXXXXX")"; '
        + 'printf "%s\\n%s\\n" "$root" "$(smoke_root_identity "$root")"',
      [], { SMOKE_TEST_HELPER: cleanupHelper, SMOKE_TEST_BASE: base },
    );
    assert.equal(created.code, 0, created.stderr);
    const [root, identity] = created.stdout.trim().split('\n');
    // Links to the outside directory from both a host-owned and the root-owned
    // 0700 subtree; neither the host pass nor the fallback may follow them.
    mkdirSync(join(root, 'data'), { mode: 0o700 });
    symlinkSync(outside, join(root, 'data', 'outside-link'));

    const populated = spawnSync('docker', [
      'run', '--rm', '--label', `${label}=${stack}`, '--network', 'none', '--user', '0:0', '--entrypoint', 'sh',
      '--env', `OUTSIDE=${outside}`, '--mount', `type=bind,source=${join(root, 'data')},target=/data`, realImage,
      '-c', 'mkdir -m 700 /data/web-push && echo {} > /data/web-push/vapid.json && ln -s "$OUTSIDE" /data/web-push/outside-link',
    ], { encoding: 'utf8' });
    assert.equal(populated.status, 0, populated.stderr);
    const webPush = statSync(join(root, 'data', 'web-push'));
    assert.equal(webPush.uid, 0);
    assert.equal(webPush.mode & 0o777, 0o700);

    const removed = await bash(
      'set -euo pipefail; source "$SMOKE_TEST_HELPER"; remove_smoke_root "$SMOKE_TEST_ROOT" "$SMOKE_TEST_BASE" "$SMOKE_TEST_IDENTITY" "$@"',
      [realImage, label, stack],
      { SMOKE_TEST_HELPER: cleanupHelper, SMOKE_TEST_ROOT: root, SMOKE_TEST_BASE: base, SMOKE_TEST_IDENTITY: identity },
    );
    assert.equal(removed.code, 0, removed.stderr);
    assert.throws(() => lstatSync(root), { code: 'ENOENT' });
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside');
    assert.equal(readFileSync(join(otherRun, 'keep.txt'), 'utf8'), 'other run');
    const leftovers = spawnSync('docker', ['ps', '-aq', '--filter', `label=${label}=${stack}`], { encoding: 'utf8' });
    assert.equal(leftovers.status, 0, leftovers.stderr);
    assert.equal(leftovers.stdout.trim(), '');
  });
});
