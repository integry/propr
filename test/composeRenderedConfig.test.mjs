import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';

/**
 * Renders docker-compose.yml with Docker Compose itself (`config`), so env_file
 * layering, imported settings, interpolation and data mounts are checked
 * together as Compose resolves them, not as the text-level tests model them.
 * Skipped when no Compose binary is installed; set PROPR_TEST_DOCKER_COMPOSE to
 * a standalone `docker-compose` binary to run it anywhere.
 */
const backends = ['daemon', 'worker', 'indexing-worker', 'api'];
const root = new URL('..', import.meta.url);

function findCompose() {
  const candidates = [
    ...(process.env.PROPR_TEST_DOCKER_COMPOSE ? [[process.env.PROPR_TEST_DOCKER_COMPOSE]] : []),
    ['docker', 'compose'],
    ['docker-compose'],
  ];
  for (const [command, ...prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, 'version'], { encoding: 'utf8' });
    if (probe.status === 0 && /v2\./u.test(probe.stdout)) return { command, prefix };
  }
  return null;
}

const compose = findCompose();
const skip = compose ? false : 'Docker Compose v2 is not installed';

/** A throwaway project holding the real compose file, its defaults, and the documented template as `.env`. */
function project({ local = '', imported } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'propr-compose-'));
  copyFileSync(new URL('docker-compose.yml', root), join(directory, 'docker-compose.yml'));
  mkdirSync(join(directory, 'docker'));
  copyFileSync(new URL('docker/compose-backend-defaults.env', root), join(directory, 'docker', 'compose-backend-defaults.env'));
  const template = readFileSync(new URL('.env.example', root), 'utf8');
  writeFileSync(join(directory, '.env'), `${template}\n${local}\n`);
  if (imported !== undefined) writeFileSync(join(directory, 'imported.env'), imported);
  return directory;
}

function render(directory, environment = {}) {
  const output = execFileSync(compose.command, [...compose.prefix, '--project-directory', directory, 'config', '--format', 'json'], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    // The template's STAGING_ENV_FILE is a placeholder path; point it at the local file.
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? directory, STAGING_ENV_FILE: '.env', ...environment },
  });
  return JSON.parse(output).services;
}

function dataMount(service) {
  return service.volumes.find(volume => volume.type === 'bind' && volume.target === service.environment.DATA_DIR);
}

/** Where a backend opens SQLite: daemon and workers resolve DB_FILENAME from /usr/src/app. */
const databasePath = service => posix.resolve('/usr/src/app', service.environment.DB_FILENAME || posix.join(service.environment.DATA_DIR, 'propr.sqlite'));

test('the documented template renders every backend onto the mounted data directory', { skip }, () => {
  const directory = project();
  try {
    const services = render(directory);
    for (const name of backends) {
      const service = services[name];
      const mount = dataMount(service);
      assert.ok(mount, `${name} mounts DATA_DIR`);
      assert.equal(mount.source, join(directory, 'data'), name);
      assert.equal(service.environment.PROPR_DATA_MOUNT, mount.target, name);
      assert.ok(databasePath(service).startsWith(`${mount.target}/`), `${name} keeps SQLite on the bind mount`);
    }
    assert.equal(services['web-ui'].environment.PROPR_UI_PUBLIC_API_URL, 'http://localhost:4000');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('an imported env file overrides bundled defaults and the local .env overrides both', { skip }, () => {
  const directory = project({
    local: 'PROPR_ENV_FILE=./imported.env\nREDIS_PORT=6391\n',
    imported: 'REDIS_HOST=external-redis\nREDIS_PORT=6390\nGH_APP_ID=imported-app\n',
  });
  try {
    // The template itself sets REDIS_HOST; drop that line so the imported value is observable.
    const envPath = join(directory, '.env');
    writeFileSync(envPath, readFileSync(envPath, 'utf8').replace(/^REDIS_HOST=.*$/mu, ''));
    const services = render(directory);
    for (const name of backends) {
      const { environment } = services[name];
      assert.equal(environment.REDIS_HOST, 'external-redis', name);
      assert.equal(environment.REDIS_PORT, '6391', `${name}: local .env wins`);
      assert.equal(environment.GH_APP_ID, 'imported-app', name);
    }
    const daemon = services.daemon.volumes.find(volume => volume.target === '/usr/src/app/.env');
    assert.equal(daemon.source, join(directory, 'imported.env'), 'the daemon mounts the imported env file');
    const api = services.api.volumes.find(volume => volume.target === '/usr/src/app/.env');
    assert.equal(api.source, join(directory, '.env'), 'the API mounts the selected staging env file');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a custom PROPR_DATA_DIR mounts at the same path and is paired with an absolute DB_FILENAME', { skip }, () => {
  const data = mkdtempSync(join(tmpdir(), 'propr-data-'));
  const directory = project({ local: `PROPR_DATA_DIR=${data}\nDB_FILENAME=${data}/propr.sqlite\n` });
  try {
    const services = render(directory);
    for (const name of backends) {
      const service = services[name];
      const mount = dataMount(service);
      assert.deepEqual([mount.source, mount.target], [data, data], name);
      assert.equal(service.environment.PROPR_DATA_MOUNT, data, name);
      assert.equal(databasePath(service), `${data}/propr.sqlite`, name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test('a custom PROPR_DATA_DIR with the template relative DB_FILENAME is the pairing startup refuses', { skip }, () => {
  const directory = project({ local: 'PROPR_DATA_DIR=/custom/data\n' });
  try {
    const services = render(directory);
    for (const name of backends) {
      const service = services[name];
      assert.equal(service.environment.DB_FILENAME, './data/propr.sqlite', name);
      assert.equal(service.environment.PROPR_DATA_MOUNT, '/custom/data', name);
      // The core guard and the API startup script reject exactly this: the path is off the mount.
      assert.ok(!databasePath(service).startsWith('/custom/data/'), name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the web UI keeps an explicitly empty public API URL for same-origin access', { skip }, () => {
  const directory = project({ local: 'PROPR_UI_PUBLIC_API_URL=\n' });
  try {
    assert.equal(render(directory)['web-ui'].environment.PROPR_UI_PUBLIC_API_URL, '');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a bare relative PROPR_ENV_FILE is rejected, as .env.example warns', { skip }, () => {
  const directory = project({ local: 'PROPR_ENV_FILE=imported.env\n', imported: '' });
  try {
    assert.throws(() => render(directory), /imported\.env/u);
    const template = readFileSync(new URL('.env.example', root), 'utf8');
    assert.match(template, /^# Use an absolute or \.\/-relative path/mu);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
