import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  inspectImageFreshness,
  normalizeDigest,
  remoteDigestFromImagetoolsInspectOutput,
  remoteDigestFromManifestInspectOutput,
} from '../docker/launcher/orchestrator.mjs';

function installFakeDocker() {
  const binDir = mkdtempSync(join(tmpdir(), 'propr-fake-docker-'));
  const dockerPath = join(binDir, 'docker');
  writeFileSync(dockerPath, `#!/bin/sh
if [ "$1" = "images" ]; then
  [ "$DOCKER_FAKE_PRESENT" = "0" ] && exit 0
  echo "image-id"
  exit 0
fi

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  case "$DOCKER_FAKE_INSPECT" in
    fail) echo "inspect failed" >&2; exit 1 ;;
    empty) echo "[]" ; exit 0 ;;
    stale) echo '["example/app@sha256:local"]' ; exit 0 ;;
    *) echo '["example/app@sha256:remote"]' ; exit 0 ;;
  esac
fi

if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then
  case "$DOCKER_FAKE_MANIFEST" in
    array) echo '[{"Ref":"example/app:latest@sha256:platform-a"},{"Ref":"example/app:latest@sha256:platform-b"}]' ; exit 0 ;;
    fail) echo "manifest failed" >&2; exit 1 ;;
    *) echo '{"Descriptor":{"digest":"sha256:remote"}}' ; exit 0 ;;
  esac
fi

if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  echo "Name: example/app:latest"
  echo "Digest: sha256:remote"
  exit 0
fi

echo "unexpected docker command: $*" >&2
exit 1
`);
  chmodSync(dockerPath, 0o755);
  const previousPath = process.env.PATH || '';
  process.env.PATH = `${binDir}${delimiter}${previousPath}`;
  return () => {
    process.env.PATH = previousPath;
    delete process.env.DOCKER_FAKE_PRESENT;
    delete process.env.DOCKER_FAKE_INSPECT;
    delete process.env.DOCKER_FAKE_MANIFEST;
  };
}

test('normalizes image repo digests and plain digests', () => {
  assert.equal(normalizeDigest('example/app@sha256:abc\n'), 'sha256:abc');
  assert.equal(normalizeDigest('sha256:def'), 'sha256:def');
  assert.equal(normalizeDigest(''), null);
});

test('parses remote manifest digests from docker output shapes', () => {
  assert.equal(remoteDigestFromManifestInspectOutput('{"Descriptor":{"Digest":"sha256:index"}}'), 'sha256:index');
  assert.equal(remoteDigestFromManifestInspectOutput('[{"Ref":"example/app:latest@sha256:index"},{"Ref":"example/app:latest@sha256:index"}]'), 'sha256:index');
  assert.equal(remoteDigestFromManifestInspectOutput('[{"Ref":"example/app:latest@sha256:a"},{"Ref":"example/app:latest@sha256:b"}]'), null);
  assert.equal(remoteDigestFromImagetoolsInspectOutput('Name: example/app:latest\nDigest: sha256:index\n'), 'sha256:index');
});

test('inspectImageFreshness classifies current and stale images', () => {
  const restore = installFakeDocker();
  try {
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      remoteDigest: 'sha256:remote',
    });

    process.env.DOCKER_FAKE_INSPECT = 'stale';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'stale',
      tag: 'example/app:latest',
      localDigests: ['sha256:local'],
      remoteDigest: 'sha256:remote',
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshness uses buildx for multi-arch manifest output', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      remoteDigest: 'sha256:remote',
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshness treats local-only and inspect-failure images as unknown', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_INSPECT = 'empty';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'unknown',
      tag: 'example/app:latest',
      localDigests: [],
      localOnly: true,
      error: 'local image has no registry digest; pull the tag to verify freshness',
    });

    process.env.DOCKER_FAKE_INSPECT = 'fail';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'unknown',
      tag: 'example/app:latest',
      error: 'local image metadata could not be inspected',
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshness can skip the remote registry check', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'fail';
    assert.deepEqual(inspectImageFreshness('example/app:latest', { skipRemoteCheck: true }), {
      status: 'unknown',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      skipped: true,
      error: 'remote image check skipped',
    });
  } finally {
    restore();
  }
});
