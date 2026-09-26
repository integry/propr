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
  assert.match(apiService, /^      - \.\/data:\/usr\/src\/app\/data$/mu);
  assert.match(apiService, /^      - DATA_DIR=\/usr\/src\/app\/data$/mu);

  // The startup shell resolves the relative filename supplied by env_file.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const exampleDatabase = example.match(/^DB_FILENAME=(.+)$/mu)?.[1];
  assert.equal(exampleDatabase, './data/propr.sqlite');
  assert.match(apiService, /env_file:\n(?:      #.*\n)*      - \$\{STAGING_ENV_FILE:-\.env\}/u);
  const overrides = Object.fromEntries(
    [...apiService.matchAll(/^      - (DB_FILENAME|DATA_DIR)=(.+)$/gmu)]
      .map(([, key, value]) => [key, value]),
  );
  const environment = { DB_FILENAME: exampleDatabase, ...overrides };
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

  const explicitDataDirectories = compose.match(/^\s+- DATA_DIR=.*$/gmu) ?? [];
  assert.deepEqual(explicitDataDirectories, [
    '      - DATA_DIR=/usr/src/app/data',
  ]);
});
