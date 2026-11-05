import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

// The image and SQLite startup smokes bind-mount a private data root into
// containers that run as root on a rootful engine.  The API creates a
// root-owned 0700 data/web-push there, which a host `rm -rf` cannot traverse.
// These regressions drive the real harness scripts against a fake engine that
// leaves exactly such a child; the shared helper's refusal boundary is covered
// by apps/desktop/scripts/smoke-local-runtime.test.mjs.
const fakeDocker = resolve('test/fixtures/image-smoke-cleanup/fake-docker.mjs');
const logsHelper = resolve('scripts/lib/smoke-container-logs.sh');
const unsupported = process.platform === 'win32';
// Root bypasses the permission bits used to emulate a container-owned subtree.
const hostCannotRemovePrivateSubtree = !unsupported && process.getuid?.() !== 0;

function run(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function makeWorkspace(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'image-smoke-cleanup-test-')));
  const bin = join(root, 'bin');
  const state = join(root, 'docker-state');
  const base = join(root, 'tmp');
  for (const directory of [bin, state, base]) mkdirSync(directory);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec "${process.execPath}" "${fakeDocker}" "$@"\n`, { mode: 0o755 });
  t.after(() => forceRemove(root));
  return { root, bin, state, base };
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

function dockerCalls(workspace) {
  const path = join(workspace.state, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

const harnesses = [
  {
    name: 'SQLite startup smoke',
    script: 'scripts/smoke-test-sqlite-startup.sh',
    prefix: 'propr-sqlite-startup-smoke.',
    label: /^com\.propr\.sqlite-startup-smoke=sqlite-smoke-local-\d+-\d+$/,
    stepFailure: /synthetic launcher start failure/,
    cleanupFailure: /SQLite smoke cleanup did not remove/,
  },
  {
    name: 'image smoke',
    script: 'scripts/smoke-test-images.sh',
    prefix: 'propr-image-smoke.',
    label: /^com\.propr\.smoke\.stack=propr-smoke-cleanup-regression$/,
    stepFailure: /synthetic app image check failure/,
    cleanupFailure: /image smoke cleanup did not remove every owned resource/,
  },
];

describe('image smoke harness cleanup of root-owned data', { skip: unsupported }, () => {
  for (const harness of harnesses) {
    function runHarness(workspace, env = {}) {
      return run('bash', [harness.script], {
        PATH: `${workspace.bin}:${process.env.PATH}`,
        FAKE_DOCKER_STATE: workspace.state,
        FAKE_SMOKE_BASE: workspace.base,
        FAKE_APP_TAG: 'propr-smoke-test/app:cleanup',
        APP_TAG: 'propr-smoke-test/app:cleanup',
        LAUNCHER_TAG: 'propr-smoke-test/launcher:cleanup',
        STACK: 'propr-smoke-cleanup-regression',
        EXPECTED_VERSION: '0.0.0-cleanup',
        RUNNER_TEMP: workspace.base,
        GITHUB_RUN_ID: '',
        ...env,
      });
    }

    test(`${harness.name} removes a protected root-owned child and keeps the step failure`, async (t) => {
      const workspace = makeWorkspace(t);
      const unrelated = join(workspace.root, 'unrelated');
      mkdirSync(unrelated);
      writeFileSync(join(unrelated, 'keep.txt'), 'keep');

      const result = await runHarness(workspace);

      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, harness.stepFailure);
      assert.doesNotMatch(result.stderr, /cleanup did not remove|refusing|remains/);
      assert.deepEqual(readdirSync(workspace.base), [], 'the private data root is removed');
      assert.equal(readFileSync(join(unrelated, 'keep.txt'), 'utf8'), 'keep');

      const cleanups = dockerCalls(workspace).filter((args) => args[0] === 'run' && args.includes('--mount'));
      assert.equal(cleanups.length, hostCannotRemovePrivateSubtree ? 1 : 0);
      if (hostCannotRemovePrivateSubtree) {
        const [cleanup] = cleanups;
        const mount = cleanup[cleanup.indexOf('--mount') + 1];
        assert.match(mount, new RegExp(`^type=bind,source=${workspace.base}/${harness.prefix.replace('.', '\\.')}[A-Za-z0-9]{6},target=/smoke-root$`));
        assert.match(cleanup[cleanup.indexOf('--label') + 1], harness.label);
        for (const [flag, value] of [
          ['--network', 'none'], ['--user', '0:0'], ['--cap-drop', 'ALL'], ['--cap-add', 'DAC_OVERRIDE'], ['--entrypoint', 'find'],
        ]) {
          assert.equal(cleanup[cleanup.indexOf(flag) + 1], value, flag);
        }
        assert.deepEqual(cleanup.slice(-6), ['propr-smoke-test/app:cleanup', '/smoke-root', '-xdev', '-mindepth', '1', '-delete']);
      }
    });

    test(`${harness.name} reports generated data it could not remove`, { skip: !hostCannotRemovePrivateSubtree }, async (t) => {
      const workspace = makeWorkspace(t);

      const result = await runHarness(workspace, { FAKE_DOCKER_CLEANUP: 'fail' });

      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, harness.stepFailure);
      assert.match(result.stderr, /generated smoke data remains at /);
      assert.match(result.stderr, harness.cleanupFailure);
      assert.equal(readdirSync(workspace.base).filter((name) => name.startsWith(harness.prefix)).length, 1);
    });
  }
});

describe('container log assertions under pipefail', { skip: unsupported }, () => {
  // Docker keeps writing after the match; with a pipe it dies of SIGPIPE once
  // the reader has gone, as the real CLI does.  Far more than a pipe buffer
  // follows the match so the early reader exit is deterministic.
  function workspace(t) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'smoke-container-logs-test-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'docker'), [
      '#!/bin/sh',
      '[ "$1" = logs ] || exit 2',
      '[ "${FAKE_LOGS_FAIL:-}" = 1 ] && { echo "Error: No such container" >&2; exit 1; }',
      'echo "  ! startup failed (Database migration phase failed: Error: corrupt) — rolling back"',
      'head -c 4194304 /dev/zero | tr "\\0" "x"',
      'echo',
    ].join('\n'), { mode: 0o755 });
    return { PATH: `${root}:${process.env.PATH}` };
  }

  test('a streamed docker logs | grep -q pipeline is the false negative being fixed', async (t) => {
    const result = await run('bash', ['-c',
      'set -euo pipefail; if docker logs c 2>&1 | grep -Fq "Database migration phase failed"; then echo found; else echo missed; fi'],
    workspace(t));
    assert.equal(result.stdout.trim(), 'missed', 'control: the reproduction must exercise SIGPIPE');
  });

  test('container_logs_contain finds a match followed by more output', async (t) => {
    const env = { ...workspace(t), LOGS_HELPER: logsHelper };
    const check = (text, extra = {}) => run('bash', ['-c',
      'set -euo pipefail; source "$LOGS_HELPER"; if container_logs_contain c "$1"; then echo found; else echo missed; fi', 'bash', text],
    { ...env, ...extra });

    assert.equal((await check('Database migration phase failed')).stdout.trim(), 'found');
    assert.equal((await check('not in the log')).stdout.trim(), 'missed');
    assert.equal((await check('Database migration phase failed', { FAKE_LOGS_FAIL: '1' })).stdout.trim(), 'missed');
  });
});

describe('image smoke harness sources', () => {
  for (const harness of harnesses) {
    test(`${harness.name} removes its data root only through the bounded helper`, () => {
      const source = readFileSync(harness.script, 'utf8');
      assert.match(source, /source "\$REPO_ROOT\/apps\/desktop\/scripts\/smoke-local-runtime-cleanup\.sh"/);
      assert.ok(source.includes(`mktemp -d "$SMOKE_TMP_BASE/${harness.prefix}XXXXXX"`));
      assert.match(source, /remove_smoke_root "\$\w+" "\$SMOKE_TMP_BASE" "\$\w+_IDENTITY" "\$APP_TAG" /);
      assert.doesNotMatch(source, /^\s*rm -rf/m, 'no host rm -rf of the data root');
      assert.doesNotMatch(source, /docker logs [^\n|]*\|\s*grep -\w*q/, 'no streamed grep -q under pipefail');
    });
  }
});
