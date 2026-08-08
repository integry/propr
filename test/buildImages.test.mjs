import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FULL_SHA = '1234567890abcdef1234567890abcdef12345678';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const IMAGE_REPOSITORY = 'registry.example/propr/app';
const fixtures = [];

const DOCKER_MOCK = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const statePath = process.env.DOCKER_STATE_FILE;
const logPath = process.env.DOCKER_LOG_FILE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
appendFileSync(logPath, JSON.stringify(args) + '\n');

const save = () => writeFileSync(statePath, JSON.stringify(state));
const candidateDigest = process.env.CANDIDATE_DIGEST;

if (args[0] === 'image' && args[1] === 'inspect') {
  process.exit(args[2] === process.env.MISSING_LOCAL_REF ? 1 : 0);
}

if (args[0] === 'tag') process.exit(0);

if (args[0] === 'push') {
  state.digests[args[1]] = candidateDigest;
  save();
  process.exit(0);
}

if (args[0] === 'buildx' && args[1] === 'build') {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-t') state.digests[args[index + 1]] = candidateDigest;
  }
  save();
  process.exit(0);
}

if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'inspect') {
  const ref = args[3];
  if (ref === process.env.AUTH_ERROR_REF) {
    console.error('unauthorized: authentication required');
    process.exit(1);
  }
  const digest = state.digests[ref];
  if (!digest) {
    console.error('manifest unknown: ' + ref + ' not found');
    process.exit(1);
  }
  const formatIndex = args.indexOf('--format');
  const format = formatIndex >= 0 ? args[formatIndex + 1] : '';
  if (format === '{{json .Manifest.Digest}}') console.log(JSON.stringify(digest));
  else console.log(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json' }));
  process.exit(0);
}

if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'create') {
  const target = args[args.indexOf('--tag') + 1];
  if (target === process.env.FAIL_CREATE_REF) process.exit(1);
  const source = args.at(-1);
  state.digests[target] = source.slice(source.lastIndexOf('@') + 1);
  save();
  process.exit(0);
}

console.error('Unexpected docker arguments: ' + JSON.stringify(args));
process.exit(64);
`;

function createFixture(initialDigests = {}) {
  const root = mkdtempSync(join(tmpdir(), 'propr-build-images-test-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docker', 'launcher'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyFileSync(join(REPOSITORY_ROOT, 'scripts', 'build-images.sh'), join(root, 'scripts', 'build-images.sh'));
  chmodSync(join(root, 'scripts', 'build-images.sh'), 0o755);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'propr', version: '1.2.3', license: 'Apache-2.0' }));
  writeFileSync(join(root, 'docker', 'launcher', 'manifest.json'), '{}');
  writeFileSync(join(root, 'state.json'), JSON.stringify({ digests: initialDigests }));
  writeFileSync(join(root, 'docker.log'), '');
  writeFileSync(join(root, 'bin', 'docker'), DOCKER_MOCK);
  chmodSync(join(root, 'bin', 'docker'), 0o755);
  return root;
}

function runBuild(root, args, extraEnv = {}) {
  return spawnSync('bash', ['scripts/build-images.sh', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`,
      BUILD_DATE: '2026-08-03T00:00:00Z',
      CANDIDATE_DIGEST: DIGEST_A,
      DOCKERHUB_NS: 'registry.example/propr',
      DOCKER_LOG_FILE: join(root, 'docker.log'),
      DOCKER_STATE_FILE: join(root, 'state.json'),
      GIT_SHA: FULL_SHA,
      PUSH_LATEST: 'false',
      ...extraEnv,
    },
  });
}

function readState(root) {
  return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
}

function readDockerLog(root) {
  return readFileSync(join(root, 'docker.log'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
});

describe('build-images publication reconciliation', () => {
  test('resolves the supported descriptor digest and creates missing immutable tags', () => {
    const root = createFixture();
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app']);

    assert.equal(result.status, 0, result.stderr);
    const state = readState(root);
    assert.equal(state.digests[`${IMAGE_REPOSITORY}:${FULL_SHA}`], DIGEST_A);
    assert.equal(state.digests[`${IMAGE_REPOSITORY}:1.2.3`], DIGEST_A);
    assert.ok(readDockerLog(root).some(args =>
      args.includes('--format') && args.includes('{{json .Manifest.Digest}}')
    ));
  });

  test('refuses to overwrite an existing full commit tag before publishing the version', () => {
    const shaRef = `${IMAGE_REPOSITORY}:${FULL_SHA}`;
    const root = createFixture({ [shaRef]: DIGEST_B });
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite immutable image tag/);
    assert.equal(readState(root).digests[shaRef], DIGEST_B);
    assert.equal(readState(root).digests[`${IMAGE_REPOSITORY}:1.2.3`], undefined);
    assert.deepEqual(readDockerLog(root).filter(args => args[0] === 'push').map(args => args[1]), [
      `${IMAGE_REPOSITORY}:reconcile-${FULL_SHA}`,
    ]);
  });

  test('refuses an immutable version conflict after confirming the commit artifact', () => {
    const shaRef = `${IMAGE_REPOSITORY}:${FULL_SHA}`;
    const versionRef = `${IMAGE_REPOSITORY}:1.2.3`;
    const root = createFixture({ [shaRef]: DIGEST_A, [versionRef]: DIGEST_B });
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite immutable image tag/);
    assert.equal(readState(root).digests[versionRef], DIGEST_B);
  });

  test('preflights every selected image before publishing any consumer tag', () => {
    const uiRepository = 'registry.example/propr/ui';
    const conflictingUiVersion = `${uiRepository}:1.2.3`;
    const root = createFixture({ [conflictingUiVersion]: DIGEST_B });
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app,ui']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite immutable image tag/);
    const state = readState(root);
    assert.equal(state.digests[`${IMAGE_REPOSITORY}:${FULL_SHA}`], undefined);
    assert.equal(state.digests[`${IMAGE_REPOSITORY}:1.2.3`], undefined);
    assert.equal(state.digests[conflictingUiVersion], DIGEST_B);
    assert.deepEqual(
      readDockerLog(root).filter(args => args[0] === 'push').map(args => args[1]),
      [
        `${IMAGE_REPOSITORY}:reconcile-${FULL_SHA}`,
        `${uiRepository}:reconcile-${FULL_SHA}`,
      ],
    );
  });

  test('does not treat registry authorization failures as missing manifests', () => {
    const shaRef = `${IMAGE_REPOSITORY}:${FULL_SHA}`;
    const root = createFixture();
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app'], {
      AUTH_ERROR_REF: shaRef,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to inspect remote image/);
    assert.equal(readState(root).digests[shaRef], undefined);
  });

  test('push-only fails before registry mutation when the smoke-tested local image is absent', () => {
    const versionRef = `${IMAGE_REPOSITORY}:1.2.3`;
    const root = createFixture();
    const result = runBuild(root, ['--push-only', '--dockerhub', '--only', 'app'], {
      MISSING_LOCAL_REF: versionRef,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing local image/);
    assert.equal(readDockerLog(root).some(args => args[0] === 'push'), false);
  });

  test('multi-platform builds push only a staging tag before immutable reconciliation', () => {
    const root = createFixture();
    const result = runBuild(root, [
      '--push',
      '--dockerhub',
      '--only',
      'app',
      '--platform',
      'linux/amd64,linux/arm64',
    ]);

    assert.equal(result.status, 0, result.stderr);
    const build = readDockerLog(root).find(args => args[0] === 'buildx' && args[1] === 'build');
    assert.ok(build);
    const buildTags = build.flatMap((arg, index) => arg === '-t' ? [build[index + 1]] : []);
    assert.deepEqual(buildTags, [`${IMAGE_REPOSITORY}:reconcile-${FULL_SHA}`]);
    assert.equal(readState(root).digests[`${IMAGE_REPOSITORY}:${FULL_SHA}`], DIGEST_A);
    assert.equal(readState(root).digests[`${IMAGE_REPOSITORY}:1.2.3`], DIGEST_A);
  });

  test('promotes latest only from matching immutable version and full-SHA tags', () => {
    const versionRef = `${IMAGE_REPOSITORY}:1.2.3`;
    const shaRef = `${IMAGE_REPOSITORY}:${FULL_SHA}`;
    const latestRef = `${IMAGE_REPOSITORY}:latest`;
    const root = createFixture({ [versionRef]: DIGEST_A, [shaRef]: DIGEST_A, [latestRef]: DIGEST_B });
    const result = runBuild(root, ['--promote-latest', '--dockerhub', '--only', 'app']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readState(root).digests[latestRef], DIGEST_A);
    assert.equal(readDockerLog(root).some(args =>
      args[0] === 'push' || (args[0] === 'buildx' && args[1] === 'build')
    ), false);
  });

  test('leaves latest unchanged when immutable version and commit tags disagree', () => {
    const versionRef = `${IMAGE_REPOSITORY}:1.2.3`;
    const shaRef = `${IMAGE_REPOSITORY}:${FULL_SHA}`;
    const latestRef = `${IMAGE_REPOSITORY}:latest`;
    const root = createFixture({ [versionRef]: DIGEST_A, [shaRef]: DIGEST_B, [latestRef]: DIGEST_B });
    const result = runBuild(root, ['--promote-latest', '--dockerhub', '--only', 'app']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version and commit tags disagree/);
    assert.equal(readState(root).digests[latestRef], DIGEST_B);
  });

  test('restores an earlier registry when a later latest promotion fails', () => {
    const ghcrRepository = 'registry.example/ghcr/propr-app';
    const dockerLatest = `${IMAGE_REPOSITORY}:latest`;
    const ghcrLatest = `${ghcrRepository}:latest`;
    const root = createFixture({
      [`${IMAGE_REPOSITORY}:1.2.3`]: DIGEST_A,
      [`${IMAGE_REPOSITORY}:${FULL_SHA}`]: DIGEST_A,
      [dockerLatest]: DIGEST_B,
      [`${ghcrRepository}:1.2.3`]: DIGEST_A,
      [`${ghcrRepository}:${FULL_SHA}`]: DIGEST_A,
      [ghcrLatest]: DIGEST_B,
    });
    const result = runBuild(root, ['--promote-latest', '--only', 'app'], {
      FAIL_CREATE_REF: ghcrLatest,
      GHCR_NS: 'registry.example/ghcr',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restoring previously published latest tags/);
    assert.equal(readState(root).digests[dockerLatest], DIGEST_B);
    assert.equal(readState(root).digests[ghcrLatest], DIGEST_B);
  });

  test('reports a non-atomic result when rollback cannot remove a newly created latest tag', () => {
    const ghcrRepository = 'registry.example/ghcr/propr-app';
    const dockerLatest = `${IMAGE_REPOSITORY}:latest`;
    const ghcrLatest = `${ghcrRepository}:latest`;
    const root = createFixture({
      [`${IMAGE_REPOSITORY}:1.2.3`]: DIGEST_A,
      [`${IMAGE_REPOSITORY}:${FULL_SHA}`]: DIGEST_A,
      [`${ghcrRepository}:1.2.3`]: DIGEST_A,
      [`${ghcrRepository}:${FULL_SHA}`]: DIGEST_A,
    });
    const result = runBuild(root, ['--promote-latest', '--only', 'app'], {
      FAIL_CREATE_REF: ghcrLatest,
      GHCR_NS: 'registry.example/ghcr',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NON-ATOMIC PROMOTION/);
    assert.match(result.stderr, /registry-side reconciliation is required/);
    assert.equal(readState(root).digests[dockerLatest], DIGEST_A);
  });
});
