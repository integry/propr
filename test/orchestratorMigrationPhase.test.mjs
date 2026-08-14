import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveConfig,
  runMigrationPhaseAsync,
  startStack,
} from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));

function installFakeDocker() {
  const root = mkdtempSync(join(tmpdir(), 'propr-migration-phase-'));
  const dockerPath = join(root, 'docker');
  const logPath = join(root, 'docker.log');
  writeFileSync(dockerPath, `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_FAKE_LOG"

if [ "$1" = "images" ]; then
  echo "image-id"
  exit 0
fi

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  echo '["propr/app@sha256:local"]'
  exit 0
fi

case " $* " in
  *" node dist/src/migrate.js "*)
    if [ "$DOCKER_FAKE_MIGRATION_FAIL" = "1" ]; then
      echo "synthetic migration failure" >&2
      exit 17
    fi
    exit 0
    ;;
esac

# Empty docker ps output is sufficient for container-existence and status calls.
exit 0
`);
  chmodSync(dockerPath, 0o755);

  const previous = {
    path: process.env.PATH,
    log: process.env.DOCKER_FAKE_LOG,
    skipRemote: process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK,
    fail: process.env.DOCKER_FAKE_MIGRATION_FAIL,
  };
  process.env.PATH = `${root}${delimiter}${previous.path || ''}`;
  process.env.DOCKER_FAKE_LOG = logPath;
  process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = '1';

  return {
    lines: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean),
    restore: () => {
      process.env.PATH = previous.path;
      if (previous.log === undefined) delete process.env.DOCKER_FAKE_LOG;
      else process.env.DOCKER_FAKE_LOG = previous.log;
      if (previous.skipRemote === undefined) delete process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK;
      else process.env.PROPR_SKIP_REMOTE_IMAGE_CHECK = previous.skipRemote;
      if (previous.fail === undefined) delete process.env.DOCKER_FAKE_MIGRATION_FAIL;
      else process.env.DOCKER_FAKE_MIGRATION_FAIL = previous.fail;
    },
  };
}

function config() {
  return resolveConfig({}, {
    manifestPath,
    envFileLocal: '/stack/.env',
    envFileHost: '/stack/.env',
    hostData: '/stack/data',
    hostLogs: '/stack/logs',
    hostRepos: '/stack/repos',
  });
}

test('full stack startup completes one migration phase before creating services', () => {
  const fake = installFakeDocker();
  try {
    startStack(config(), { ui: false, docs: false, tunnel: false });

    const runs = fake.lines().filter(line => line.startsWith('run '));
    assert.equal(runs.length, 7, 'one migration process plus six core services');
    assert.match(runs[0], /^run --rm --init --name propr-migrate /);
    assert.match(runs[0], / node dist\/src\/migrate\.js$/);
    assert.doesNotMatch(runs[0], /--restart/);
    assert.match(runs[0], /PROPR_MIGRATIONS_PREAPPLIED=0/);
    assert.doesNotMatch(runs[0], /PROPR_MIGRATIONS_PREAPPLIED=1/);

    const detached = runs.slice(1);
    assert.ok(detached.every(line => line.startsWith('run -d ')));
    const databaseServices = detached.filter(line => /propr\.service=(daemon|worker|analysis-worker|indexing-worker|api)/.test(line));
    assert.equal(databaseServices.length, 5);
    assert.ok(databaseServices.every(line => line.includes('PROPR_MIGRATIONS_PREAPPLIED=1')));
    assert.doesNotMatch(detached.find(line => line.includes('propr.service=redis')), /PROPR_MIGRATIONS_PREAPPLIED/);
  } finally {
    fake.restore();
  }
});

test('migration failure aborts startup before any service container is created', () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MIGRATION_FAIL = '1';
    assert.throws(
      () => startStack(config(), { ui: false, docs: false, tunnel: false }),
      /Database migration phase failed: synthetic migration failure/,
    );

    const runs = fake.lines().filter(line => line.startsWith('run '));
    assert.equal(runs.length, 1);
    assert.match(runs[0], / node dist\/src\/migrate\.js$/);
  } finally {
    fake.restore();
  }
});

test('async migration phase also waits for the one-shot container', async () => {
  const fake = installFakeDocker();
  try {
    await runMigrationPhaseAsync(config());
    const runs = fake.lines().filter(line => line.startsWith('run '));
    assert.equal(runs.length, 1);
    assert.match(runs[0], /^run --rm --init --name propr-migrate /);
    assert.match(runs[0], / node dist\/src\/migrate\.js$/);
  } finally {
    fake.restore();
  }
});
