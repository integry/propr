import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';

const compose = readFileSync(
  new URL('../docker-compose.yml', import.meta.url),
  'utf8',
);

test('compose API resolves durable identity state at its mounted data directory', () => {
  const apiService = compose.match(
    /^  api:\n(?<service>[\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|^networks:)/mu,
  )?.groups?.service;

  assert.ok(apiService, 'docker-compose.yml must define the API service');
  const startup = apiService.match(
    /^    command:\n      - sh\n      - -c\n      - \|\n(?<script>(?:        .*\n)+)/mu,
  )?.groups?.script;
  assert.ok(startup, 'the API must define a startup shell command');
  // Decode Compose's escaped dollars and inspect the environment before launch.
  const script = startup.replace(/^        /gmu, '').replaceAll('$$', '$');
  const launch = /^cd \/usr\/src\/app\/packages\/api && exec npx tsx server\.ts\n?$/mu;
  assert.match(script, launch);
  const normalization = script.replace(launch, 'printf \'%s\' "$DB_FILENAME"');
  assert.ok(apiService.includes('      - ${PROPR_DATA_DIR:-./data}:${PROPR_DATA_DIR:-/usr/src/app/data}'));
  assert.ok(apiService.includes('      - DATA_DIR=${PROPR_DATA_DIR:-/usr/src/app/data}'));

  // The startup shell resolves the relative filename supplied by env_file.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const exampleDatabase = example.match(/^DB_FILENAME=(.+)$/mu)?.[1];
  assert.equal(exampleDatabase, './data/propr.sqlite');
  assert.match(apiService, /env_file:\n(?:      #.*\n)*      - docker\/compose-backend-defaults\.env\n      - \$\{PROPR_ENV_FILE:-\.env\}\n      - \$\{STAGING_ENV_FILE:-\.env\}/u);
  const overrides = Object.fromEntries(
    [...apiService.matchAll(/^      - (DB_FILENAME|DATA_DIR)=(.+)$/gmu)]
      .map(([, key, value]) => [key, value]),
  );
  const environment = { DB_FILENAME: exampleDatabase, ...overrides, DATA_DIR: '/usr/src/app/data' };
  const resolvedDatabase = execFileSync('sh', ['-c', normalization], {
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(posix.normalize(resolvedDatabase), '/usr/src/app/data/propr.sqlite');
  assert.equal(environment.DATA_DIR, '/usr/src/app/data');

  for (const [filename, expected] of [
    ['', '/usr/src/app/data/propr.sqlite'],
    ['data/custom.sqlite', '/usr/src/app/data/custom.sqlite'],
    ['/custom/propr.sqlite', '/custom/propr.sqlite'],
    [':memory:', ':memory:'],
    ['file:custom.sqlite?mode=ro', 'file:custom.sqlite?mode=ro'],
  ]) {
    assert.equal(execFileSync('sh', ['-c', normalization], {
      env: { ...environment, DB_FILENAME: filename },
      encoding: 'utf8',
    }), expected, `startup DB_FILENAME=${JSON.stringify(filename)}`);
  }

  // An existing absolute host path and its default filename share the selected mount.
  for (const filename of ['/custom/data/propr.sqlite', '']) {
    const resolved = execFileSync('sh', ['-c', normalization], {
      env: { DATA_DIR: '/custom/data', DB_FILENAME: filename }, encoding: 'utf8',
    });
    assert.equal(resolved, '/custom/data/propr.sqlite');
  }
  const explicitDataDirectories = compose.match(/^\s+- DATA_DIR=.*$/gmu) ?? [];
  assert.equal(explicitDataDirectories.length, 4);
  assert.ok(explicitDataDirectories.every(line => line.trim() === '- DATA_DIR=${PROPR_DATA_DIR:-/usr/src/app/data}'));
});

const backendServices = ['daemon', 'worker', 'indexing-worker', 'api'];
const serviceBlock = name => compose.match(new RegExp(
  `^  ${name}:\\n(?<service>[\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^networks:)`, 'mu',
))?.groups?.service;
const parseEnvFile = text => Object.fromEntries(text.split('\n')
  .map(line => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u))
  .filter(Boolean)
  .map(([, key, value]) => [key, value]));

test('compose backends keep imported Redis settings unless local settings override them', () => {
  const defaults = parseEnvFile(readFileSync(
    new URL('../docker/compose-backend-defaults.env', import.meta.url), 'utf8',
  ));
  assert.deepEqual(defaults, { REDIS_HOST: 'redis', REDIS_PORT: '6379' });
  const imported = { REDIS_HOST: 'external-redis', REDIS_PORT: '6390' };

  for (const name of backendServices) {
    const service = serviceBlock(name);
    assert.ok(service, `docker-compose.yml must define ${name}`);
    const envFiles = [...service.match(/^    env_file:\n(?<files>(?:      .*\n)+)/mu)
      .groups.files.matchAll(/^      - (.+)$/gmu)].map(([, file]) => file);
    // Later env_file entries win, so the bundled defaults must load first.
    assert.deepEqual(envFiles.slice(0, 2), ['docker/compose-backend-defaults.env', '${PROPR_ENV_FILE:-.env}'], name);
    // Explicit environment entries beat every env_file value, including imported ones.
    assert.doesNotMatch(service, /^      - REDIS_(HOST|PORT)=/mu, name);

    const merge = (...layers) => Object.assign({}, defaults, ...layers);
    assert.deepEqual(merge(imported, {}), { ...imported }, `${name} keeps imported Redis`);
    assert.equal(merge(imported, { REDIS_HOST: 'local-redis' }).REDIS_HOST, 'local-redis', name);
    assert.deepEqual(merge({}, {}), defaults, `${name} falls back to bundled Redis`);
  }
});
