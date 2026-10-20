import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveConfig, buildServiceSpec, startService } from '../docker/launcher/orchestrator.mjs';

const manifestPath = fileURLToPath(new URL('../docker/launcher/manifest.json', import.meta.url));
const APP_SERVICES = ['daemon', 'worker', 'indexing-worker', 'api'];

function writeEnvFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'propr-instance-id-')), '.env');
  writeFileSync(path, contents);
  return path;
}

// The container's final environment as Docker assembles it from a `docker run`
// argument list: every --env-file entry (Docker's literal parsing) followed by
// every -e entry, without deduplication — which is how `.Config.Env` records it.
// A bare `NAME` line is resolved from the docker CLI's environment.
function dockerRunEnv(args, cliEnv = process.env) {
  const env = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--env-file') {
      for (const rawLine of readFileSync(args[i + 1], 'utf8').replace(/^\uFEFF/, '').split('\n')) {
        const line = rawLine.replace(/\r$/, '').trimStart();
        if (!line || line.startsWith('#')) continue;
        if (line.includes('=')) env.push(line);
        else if (cliEnv[line] !== undefined) env.push(`${line}=${cliEnv[line]}`);
      }
    } else if (args[i] === '-e') {
      env.push(args[i + 1]);
    }
  }
  return env;
}

function instanceIdBindings(args, cliEnv) {
  return dockerRunEnv(args, cliEnv).filter((entry) => entry.startsWith('PROPR_INSTANCE_ID='));
}

function envFileArg(args) {
  return args[args.indexOf('--env-file') + 1];
}

function rmScratch(spec) {
  if (spec.scratchDir) rmSync(spec.scratchDir, { recursive: true, force: true });
}

function hostedConfig(envFileContents, env = {}) {
  return resolveConfig({
    PROPR_LAUNCHER_ENV_FILE: writeEnvFile(envFileContents),
    PROPR_DATA_DIR: '/host/propr/data',
    PROPR_LOGS_DIR: '/host/propr/logs',
    PROPR_REPOS_DIR: '/host/propr/repos',
    PROPR_ENV_FILE: '/host/propr/.env',
    ...env,
  }, { manifestPath });
}

test('hosted api container receives exactly one PROPR_INSTANCE_ID binding from the shared env file', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID=abc123\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), ['PROPR_INSTANCE_ID=abc123']);
  assert.ok(!args.some((arg) => arg.startsWith('PROPR_INSTANCE_ID=')), 'no command-line identity override');
  // Tunnel URL derivation and the remaining tunnel env are unchanged.
  const env = dockerRunEnv(args);
  assert.ok(env.includes('PROPR_UI_PUBLIC_API_URL=https://t-abc123.propr.dev'));
  assert.ok(env.includes('API_PUBLIC_URL=https://t-abc123.propr.dev'));
  assert.ok(env.includes('PROPR_UI_TUNNEL_ENABLED=true'));
});

test('every managed app service exposes exactly one PROPR_INSTANCE_ID entry', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\nPROPR_INSTANCE_ID=abc123\n');
  for (const service of APP_SERVICES) {
    assert.deepEqual(instanceIdBindings(buildServiceSpec(cfg, service).args), ['PROPR_INSTANCE_ID=abc123'], service);
  }
});

// Shapes whose Docker-literal env-file binding is not exactly the canonical id.
// Each must still leave the API with one, lowercased PROPR_INSTANCE_ID.
const NON_CANONICAL_ENV_FILES = {
  'mixed-case': 'PROPR_INSTANCE_ID=AbC123\n',
  // Docker does not strip quotes, so the container would otherwise see `"abc123"`.
  quoted: 'PROPR_INSTANCE_ID="abc123"\n',
  'repeated canonical': 'PROPR_INSTANCE_ID=abc123\nPROPR_INSTANCE_ID=abc123\n',
  'trailing space': 'PROPR_INSTANCE_ID=abc123 \n',
};

for (const [shape, identityLines] of Object.entries(NON_CANONICAL_ENV_FILES)) {
  test(`api receives exactly one canonical PROPR_INSTANCE_ID for a ${shape} env file binding`, (t) => {
    const shared = 'NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\n' + identityLines + '# note\nOTHER_SETTING="kept verbatim"\n';
    const cfg = hostedConfig(shared);
    const spec = buildServiceSpec(cfg, 'api');
    t.after(() => rmScratch(spec));

    assert.deepEqual(instanceIdBindings(spec.args), ['PROPR_INSTANCE_ID=abc123']);
    assert.equal(cfg.uiPublicApiUrl, 'https://t-abc123.propr.dev');
    // The API reads a private copy; every other line survives verbatim and the
    // shared file other services use is untouched.
    const apiEnvFile = envFileArg(spec.args);
    assert.notEqual(apiEnvFile, cfg.envFileLocal);
    assert.equal(statSync(apiEnvFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(apiEnvFile, 'utf8'), shared.replace(identityLines, ''));
    assert.equal(readFileSync(cfg.envFileLocal, 'utf8'), shared);
    assert.equal(envFileArg(buildServiceSpec(cfg, 'worker').args), cfg.envFileLocal);
  });
}

test('api replaces a bare env file binding resolved from the docker CLI environment', (t) => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_INSTANCE_ID\n', { PROPR_INSTANCE_ID: 'AbC123' });
  const spec = buildServiceSpec(cfg, 'api');
  t.after(() => rmScratch(spec));

  assert.deepEqual(instanceIdBindings(spec.args, { PROPR_INSTANCE_ID: 'AbC123' }), ['PROPR_INSTANCE_ID=abc123']);
});

test('api keeps a single override when the instance id comes only from the process environment', () => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_UI_TUNNEL_TOKEN=secret-token\n', { PROPR_INSTANCE_ID: 'AbC123' });
  const { args, scratchDir } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), ['PROPR_INSTANCE_ID=abc123']);
  assert.equal(envFileArg(args), cfg.envFileLocal);
  assert.equal(scratchDir, undefined);
});

test('api receives only a differing process-environment override, not the env file value', (t) => {
  const cfg = hostedConfig('NODE_ENV=production\nPROPR_INSTANCE_ID=old\n', { PROPR_INSTANCE_ID: 'new' });
  const spec = buildServiceSpec(cfg, 'api');
  t.after(() => rmScratch(spec));

  assert.deepEqual(instanceIdBindings(spec.args), ['PROPR_INSTANCE_ID=new']);
});

test('startService removes the private api env file after docker run has read it', (t) => {
  // A stand-in docker CLI on PATH that records what `docker run` read from
  // --env-file and reports no existing containers.
  const bin = mkdtempSync(join(tmpdir(), 'propr-fake-docker-'));
  const capture = join(bin, 'run-env');
  const fakeDocker = join(bin, 'docker');
  writeFileSync(fakeDocker, [
    '#!/bin/sh',
    'if [ "$1" = run ]; then',
    '  while [ $# -gt 0 ]; do',
    `    if [ "$1" = --env-file ]; then echo "$2" > '${capture}.path'; cat "$2" > '${capture}'; fi`,
    '    shift',
    '  done',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(fakeDocker, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const cfg = hostedConfig('NODE_ENV=production\nPROPR_INSTANCE_ID=AbC123\n');
  startService(cfg, 'api', { pull: false });

  const apiEnvFile = readFileSync(`${capture}.path`, 'utf8').trim();
  assert.notEqual(apiEnvFile, cfg.envFileLocal);
  assert.equal(readFileSync(capture, 'utf8'), 'NODE_ENV=production\n');
  assert.equal(existsSync(dirname(apiEnvFile)), false);
});

test('local stack without an instance id gets no PROPR_INSTANCE_ID binding', () => {
  const cfg = hostedConfig('NODE_ENV=production\n');
  const { args } = buildServiceSpec(cfg, 'api');

  assert.deepEqual(instanceIdBindings(args), []);
  assert.ok(dockerRunEnv(args).includes('PROPR_UI_TUNNEL_ENABLED=false'));
});
