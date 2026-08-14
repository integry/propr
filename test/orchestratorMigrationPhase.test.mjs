import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  resolveConfig,
  runMigrationPhaseAsync,
  startService,
  startServiceAsync,
  startStack,
  startStackAsync,
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

if [ "$1" = "ps" ]; then
  case " $* " in
    *" name=^propr-migrate$ "*)
      if [ "\${DOCKER_FAKE_MIGRATE_STATE:-}" = "running" ]; then
        echo "propr-migrate"
      elif [ "\${DOCKER_FAKE_MIGRATE_STATE:-}" = "stopped" ]; then
        case " $* " in *" -a "*) echo "propr-migrate" ;; esac
      fi
      exit 0
      ;;
  esac
  for service in daemon worker analysis-worker indexing-worker api; do
    case " $* " in
      *" name=^propr-$service$ "*)
        case ",\${DOCKER_FAKE_RUNNING_SERVICES:-}," in
          *",$service,"*) echo "propr-$service" ;;
        esac
        exit 0
        ;;
    esac
  done
fi

if [ "$1" = "rm" ] && [ "$2" = "propr-migrate" ] && [ "\${DOCKER_FAKE_MIGRATE_REMOVE_FAIL:-}" = "1" ]; then
  echo "container is running" >&2
  exit 1
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
    running: process.env.DOCKER_FAKE_RUNNING_SERVICES,
    migrateState: process.env.DOCKER_FAKE_MIGRATE_STATE,
    migrateRemoveFail: process.env.DOCKER_FAKE_MIGRATE_REMOVE_FAIL,
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
      if (previous.running === undefined) delete process.env.DOCKER_FAKE_RUNNING_SERVICES;
      else process.env.DOCKER_FAKE_RUNNING_SERVICES = previous.running;
      if (previous.migrateState === undefined) delete process.env.DOCKER_FAKE_MIGRATE_STATE;
      else process.env.DOCKER_FAKE_MIGRATE_STATE = previous.migrateState;
      if (previous.migrateRemoveFail === undefined) delete process.env.DOCKER_FAKE_MIGRATE_REMOVE_FAIL;
      else process.env.DOCKER_FAKE_MIGRATE_REMOVE_FAIL = previous.migrateRemoveFail;
    },
  };
}

function config(overrides = {}, env = {}) {
  return resolveConfig(env, {
    manifestPath,
    envFileLocal: '/stack/.env',
    envFileHost: '/stack/.env',
    hostData: '/stack/data',
    hostLogs: '/stack/logs',
    hostRepos: '/stack/repos',
    ...overrides,
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

test('migration owner argv contains only its data bind and forced migration runtime', async () => {
  const fake = installFakeDocker();
  try {
    const privilegedEnv = {
      HOST_GH_PRIVATE_KEY: '/stack/github-app.pem',
      HOST_CLAUDE_DIR: '/stack/claude',
      HOST_CODEX_DIR: '/stack/codex',
      HOST_ANTIGRAVITY_DIR: '/stack/antigravity',
      HOST_OPENCODE_XDG_DIR: '/stack/opencode-config',
      HOST_OPENCODE_DATA_DIR: '/stack/opencode-data',
      HOST_VIBE_DIR: '/stack/vibe',
      HOST_VIBE_PROMPT_CACHE_DIR: '/stack/vibe-prompts',
      PROPR_UI_TUNNEL_TOKEN: 'sensitive-tunnel-token',
    };

    await runMigrationPhaseAsync(config({}, privilegedEnv));

    const run = fake.lines().find(line => line.startsWith('run --rm --init --name propr-migrate '));
    assert.equal(
      run,
      'run --rm --init --name propr-migrate --network propr-net --label propr.stack=propr --label propr.service=migrate --env-file /stack/.env -e NODE_ENV=production -e PROPR_CONTAINERIZED=1 -e PROPR_MIGRATIONS_PREAPPLIED=0 -v /stack/data:/usr/src/app/data propr/app:0.8.14 node dist/src/migrate.js',
    );
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

test('direct database service start with no live peers forces the migration marker to zero', () => {
  const fake = installFakeDocker();
  const root = mkdtempSync(join(tmpdir(), 'propr-direct-service-env-'));
  const envFile = join(root, '.env');
  writeFileSync(envFile, 'NODE_ENV=production\nPROPR_MIGRATIONS_PREAPPLIED=1\n');
  try {
    // Even the removed public-looking option cannot forge the private handoff.
    startService(config({ envFileLocal: envFile, envFileHost: envFile }), 'worker', {
      pull: false,
      migrationsPreapplied: true,
      migrationHandoff: Symbol('migrations-preapplied-handoff'),
    });
    const run = fake.lines().find(line => line.startsWith('run -d '));
    assert.ok(run);
    assert.match(run, new RegExp(`--env-file ${envFile} .*PROPR_MIGRATIONS_PREAPPLIED=0`));
    assert.doesNotMatch(run, /PROPR_MIGRATIONS_PREAPPLIED=1/);
  } finally {
    fake.restore();
  }
});

test('async direct database service start with no live peers is allowed', async () => {
  const fake = installFakeDocker();
  try {
    await startServiceAsync(config(), 'api', { pull: false });

    const run = fake.lines().find(line => line.startsWith('run -d '));
    assert.ok(run);
    assert.match(run, /propr\.service=api/);
    assert.match(run, /PROPR_MIGRATIONS_PREAPPLIED=0/);
  } finally {
    fake.restore();
  }
});

test('direct database service start refuses live peers including its replacement target', () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_RUNNING_SERVICES = 'daemon,worker';
    assert.throws(
      () => startService(config(), 'worker', {
        pull: false,
        migrationHandoff: Symbol('migrations-preapplied-handoff'),
      }),
      /Refusing to start propr-worker directly while database services are running \(propr-daemon, propr-worker\).*propr start --restart.*left untouched/,
    );
    assert.equal(fake.lines().some(line => line.startsWith('run ')), false);
    assert.equal(fake.lines().some(line => line.startsWith('rm ')), false);
  } finally {
    fake.restore();
  }
});

test('async direct database service start refuses live peers without replacing containers', async () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_RUNNING_SERVICES = 'analysis-worker';
    await assert.rejects(
      startServiceAsync(config(), 'api', { pull: false }),
      /Refusing to start propr-api directly while database services are running \(propr-analysis-worker\).*propr start --restart.*left untouched/,
    );
    assert.equal(fake.lines().some(line => line.startsWith('run ')), false);
    assert.equal(fake.lines().some(line => line.startsWith('rm ')), false);
  } finally {
    fake.restore();
  }
});

test('full stack refuses to migrate under a surviving database service', () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_RUNNING_SERVICES = 'worker,api';
    assert.throws(
      () => startStack(config(), { ui: false, docs: false, tunnel: false }),
      /Refusing to run database migrations while database services are running \(propr-worker, propr-api\).*left untouched/,
    );
    assert.equal(fake.lines().filter(line => line.startsWith('run ')).length, 0);
    assert.equal(fake.lines().filter(line => line.startsWith('rm ')).length, 0);
  } finally {
    fake.restore();
  }
});

test('async full stack also leaves surviving database services untouched', async () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_RUNNING_SERVICES = 'analysis-worker';
    await assert.rejects(
      startStackAsync(config(), { ui: false, docs: false, tunnel: false }),
      /Refusing to run database migrations while database services are running \(propr-analysis-worker\).*left untouched/,
    );
    assert.equal(fake.lines().filter(line => line.startsWith('run ')).length, 0);
    assert.equal(fake.lines().filter(line => line.startsWith('rm ')).length, 0);
  } finally {
    fake.restore();
  }
});

test('a stopped migration container is removed without force before the owner runs', async () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MIGRATE_STATE = 'stopped';
    await runMigrationPhaseAsync(config());
    const lines = fake.lines();
    const removal = lines.indexOf('rm propr-migrate');
    const owner = lines.findIndex(line => line.startsWith('run --rm --init --name propr-migrate '));
    assert.ok(removal >= 0);
    assert.ok(owner > removal);
    assert.equal(lines.some(line => line === 'rm -f propr-migrate'), false);
  } finally {
    fake.restore();
  }
});

test('a live migration owner is never removed or replaced', () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MIGRATE_STATE = 'running';
    assert.throws(
      () => startStack(config(), { ui: false, docs: false, tunnel: false }),
      /migration owner propr-migrate is already running; it was left untouched/,
    );
    assert.equal(fake.lines().filter(line => line.startsWith('run ')).length, 0);
    assert.equal(fake.lines().filter(line => line.startsWith('rm ')).length, 0);
  } finally {
    fake.restore();
  }
});

test('a stopped owner that races live is not force-removed', async () => {
  const fake = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MIGRATE_STATE = 'stopped';
    process.env.DOCKER_FAKE_MIGRATE_REMOVE_FAIL = '1';
    await assert.rejects(
      runMigrationPhaseAsync(config()),
      /may have started and was left untouched: container is running/,
    );
    assert.equal(fake.lines().some(line => line === 'rm propr-migrate'), true);
    assert.equal(fake.lines().some(line => line.startsWith('run ')), false);
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
