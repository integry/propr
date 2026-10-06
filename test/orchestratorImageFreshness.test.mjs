import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import {
  inspectImageFreshness,
  inspectImageFreshnessAsync,
  normalizeDigest,
  pullImages,
  ensureServiceImage,
  remoteDigestFromImagetoolsInspectOutput,
  remoteDigestFromManifestInspectOutput,
} from '../docker/launcher/orchestrator.mjs';

function installFakeDocker() {
  const binDir = mkdtempSync(join(tmpdir(), 'propr-fake-docker-'));
  const dockerPath = join(binDir, 'docker');
  writeFileSync(dockerPath, `#!/bin/sh
# Like the real daemon, the repository[:tag] filter never matches a combined
# repo:tag@sha256:digest reference, even when that image has been pulled.
if [ "$1" = "images" ]; then
  [ "$DOCKER_FAKE_PRESENT" = "0" ] && exit 0
  case "$3" in *@*) exit 0 ;; esac
  echo "image-id"
  exit 0
fi

# Exact-reference presence probe: docker image inspect --format {{.Id}} <ref>.
if [ "$1" = "image" ] && [ "$2" = "inspect" ] && [ "$4" = "{{.Id}}" ]; then
  [ -n "$DOCKER_FAKE_PRESENCE_LOG" ] && echo "$5" >> "$DOCKER_FAKE_PRESENCE_LOG"
  case "$DOCKER_FAKE_PRESENCE" in
    fail) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
    empty-id) exit 0 ;;
    hang) exec sleep 5 ;;
  esac
  if [ "$DOCKER_FAKE_PRESENT" = "0" ]; then
    echo "Error response from daemon: No such image: $5" >&2
    exit 1
  fi
  if [ -n "$DOCKER_FAKE_MISSING_REF" ] && [ "$5" = "$DOCKER_FAKE_MISSING_REF" ]; then
    echo "Error response from daemon: No such image: $5" >&2
    exit 1
  fi
  echo "sha256:0123456789abcdef"
  exit 0
fi

if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  case "$DOCKER_FAKE_INSPECT" in
    fail) echo "inspect failed" >&2; exit 1 ;;
    empty) echo "[]" ; exit 0 ;;
    stale) echo '["example/app@sha256:local"]' ; exit 0 ;;
    platform-a) echo '["example/app@sha256:platform-a"]' ; exit 0 ;;
    *) echo '["example/app@sha256:remote"]' ; exit 0 ;;
  esac
fi

if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then
  [ -n "$DOCKER_FAKE_MANIFEST_LOG" ] && echo "manifest $4" >> "$DOCKER_FAKE_MANIFEST_LOG"
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

if [ "$1" = "tag" ]; then
  [ -n "$DOCKER_FAKE_LOG" ] && echo "tag $2 $3" >> "$DOCKER_FAKE_LOG"
  exit 0
fi

if [ "$1" = "pull" ]; then
  [ -n "$DOCKER_FAKE_LOG" ] && echo "pull $2" >> "$DOCKER_FAKE_LOG"
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
    delete process.env.DOCKER_FAKE_LOG;
    delete process.env.DOCKER_FAKE_PRESENCE;
    delete process.env.DOCKER_FAKE_PRESENCE_LOG;
    delete process.env.DOCKER_FAKE_MISSING_REF;
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
  assert.equal(remoteDigestFromManifestInspectOutput('[{"Ref":"example/app:latest@sha256:a"},{"Ref":"example/app:latest@sha256:b"}]'), 'sha256:a');
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

test('inspectImageFreshness treats an old multi-arch platform digest as stale', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    process.env.DOCKER_FAKE_INSPECT = 'stale';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'stale',
      tag: 'example/app:latest',
      localDigests: ['sha256:local'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshness treats a current multi-arch platform digest as current', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    process.env.DOCKER_FAKE_INSPECT = 'platform-a';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:platform-a'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshness accepts a current multi-arch index digest when recorded locally', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    assert.deepEqual(inspectImageFreshness('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
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

test('inspectImageFreshnessAsync mirrors the sync classification', async () => {
  const restore = installFakeDocker();
  try {
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      remoteDigest: 'sha256:remote',
    });

    process.env.DOCKER_FAKE_INSPECT = 'stale';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'stale',
      tag: 'example/app:latest',
      localDigests: ['sha256:local'],
      remoteDigest: 'sha256:remote',
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshnessAsync treats an old multi-arch platform digest as stale', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    process.env.DOCKER_FAKE_INSPECT = 'stale';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'stale',
      tag: 'example/app:latest',
      localDigests: ['sha256:local'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshnessAsync treats a current multi-arch platform digest as current', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    process.env.DOCKER_FAKE_INSPECT = 'platform-a';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:platform-a'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshnessAsync accepts a current multi-arch index digest when recorded locally', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'array';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'current',
      tag: 'example/app:latest',
      localDigests: ['sha256:remote'],
      remoteDigest: 'sha256:platform-a',
      remoteDigests: ['sha256:platform-a', 'sha256:platform-b', 'sha256:remote'],
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshnessAsync can skip the remote registry check', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_MANIFEST = 'fail';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest', { skipRemoteCheck: true }), {
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

test('inspectImageFreshness treats local-only images as acceptable when remote checks are skipped', () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_INSPECT = 'empty';
    assert.deepEqual(inspectImageFreshness('example/app:latest', { skipRemoteCheck: true }), {
      status: 'unknown',
      tag: 'example/app:latest',
      localDigests: [],
      skipped: true,
      error: 'remote image check skipped',
    });
  } finally {
    restore();
  }
});

test('inspectImageFreshnessAsync reports missing images without a remote call', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_PRESENT = '0';
    assert.deepEqual(await inspectImageFreshnessAsync('example/app:latest'), {
      status: 'missing',
      tag: 'example/app:latest',
    });
  } finally {
    restore();
  }
});

test('pullImages leaves local-only images alone when remote checks are skipped', () => {
  const restore = installFakeDocker();
  try {
    const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-log-')), 'commands.log');
    const logs = [];
    process.env.DOCKER_FAKE_INSPECT = 'empty';
    process.env.DOCKER_FAKE_LOG = logPath;
    writeFileSync(logPath, '');

    pullImages(
      { images: { app: 'propr/app:1.0.0' }, manifest: { registry: 'propr' } },
      { onLog: (line) => logs.push(line), env: { ...process.env, PROPR_SKIP_REMOTE_IMAGE_CHECK: '1' } }
    );

    assert.ok(logs.includes('  · propr/app:1.0.0 (local, remote check skipped via PROPR_SKIP_REMOTE_IMAGE_CHECK)'));
    assert.equal(readFileSync(logPath, 'utf8').trim(), '');
  } finally {
    restore();
  }
});

test('pullImages pulls local-only ProPR images', () => {
  const restore = installFakeDocker();
  try {
    const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-log-')), 'commands.log');
    const logs = [];
    process.env.DOCKER_FAKE_INSPECT = 'empty';
    process.env.DOCKER_FAKE_LOG = logPath;

    pullImages(
      { images: { app: 'propr/app:1.0.0' }, manifest: { registry: 'propr' } },
      { onLog: (line) => logs.push(line), env: process.env }
    );

    assert.ok(logs.includes('  · propr/app:1.0.0 (local-only, pulling)'));
    assert.equal(logs.filter((line) => line === '  · propr/app:1.0.0 (local-only, pulling)').length, 1);
    assert.ok(!logs.includes('  · propr/app:1.0.0'));
    assert.equal(readFileSync(logPath, 'utf8').trim(), 'pull propr/app:1.0.0');
  } finally {
    restore();
  }
});

test('ensureServiceImage caches freshness per image tag during a startup pass', () => {
  const restore = installFakeDocker();
  try {
    const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-manifest-log-')), 'manifest.log');
    process.env.DOCKER_FAKE_MANIFEST_LOG = logPath;
    const cache = new Map();
    const cfg = { images: { app: 'propr/app:1.0.0' }, manifest: { registry: 'propr' } };

    ensureServiceImage(cfg, 'daemon', () => {}, { freshnessCache: cache });
    ensureServiceImage(cfg, 'worker', () => {}, { freshnessCache: cache });
    ensureServiceImage(cfg, 'api', () => {}, { freshnessCache: cache });

    assert.equal(readFileSync(logPath, 'utf8').trim(), 'manifest propr/app:1.0.0');
  } finally {
    restore();
    delete process.env.DOCKER_FAKE_MANIFEST_LOG;
  }
});

const PINNED_SHA = 'a'.repeat(40);
const PINNED_DIGEST = `sha256:${'b'.repeat(64)}`;
// The digest-pinned reference a staged unsigned Linux preview binds into images.*.
const PINNED_AGENT = `propr/agent:${PINNED_SHA}@${PINNED_DIGEST}`;

test('inspectImageFreshness resolves a pulled digest-pinned reference exactly, not by tag filter', async () => {
  const restore = installFakeDocker();
  try {
    const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-presence-')), 'presence.log');
    process.env.DOCKER_FAKE_PRESENCE_LOG = logPath;
    const expected = {
      status: 'unknown',
      tag: PINNED_AGENT,
      localDigests: ['sha256:remote'],
      skipped: true,
      error: 'remote image check skipped',
    };
    assert.deepEqual(inspectImageFreshness(PINNED_AGENT, { skipRemoteCheck: true }), expected);
    assert.deepEqual(await inspectImageFreshnessAsync(PINNED_AGENT, { skipRemoteCheck: true }), expected);
    // The full configured reference is inspected; the digest is never stripped.
    assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [PINNED_AGENT, PINNED_AGENT]);
  } finally {
    restore();
  }
});

test('inspectImageFreshness still reports ordinary tagged images through the exact-reference probe', async () => {
  const restore = installFakeDocker();
  try {
    const expected = { status: 'current', tag: 'propr/app:1.0.0', localDigests: ['sha256:remote'], remoteDigest: 'sha256:remote' };
    assert.deepEqual(inspectImageFreshness('propr/app:1.0.0'), expected);
    assert.deepEqual(await inspectImageFreshnessAsync('propr/app:1.0.0'), expected);
    process.env.DOCKER_FAKE_PRESENT = '0';
    assert.deepEqual(inspectImageFreshness('propr/app:1.0.0'), { status: 'missing', tag: 'propr/app:1.0.0' });
    assert.deepEqual(await inspectImageFreshnessAsync('propr/app:1.0.0'), { status: 'missing', tag: 'propr/app:1.0.0' });
  } finally {
    restore();
  }
});

for (const [label, configure] of [
  ['never pulled', () => { process.env.DOCKER_FAKE_PRESENT = '0'; }],
  ['a different digest of the repository was pulled', () => { process.env.DOCKER_FAKE_MISSING_REF = PINNED_AGENT; }],
  ['inspect fails', () => { process.env.DOCKER_FAKE_PRESENCE = 'fail'; }],
  ['inspect reports no image ID', () => { process.env.DOCKER_FAKE_PRESENCE = 'empty-id'; }],
]) {
  test(`inspectImageFreshness reports a digest-pinned image as missing when ${label}`, async () => {
    const restore = installFakeDocker();
    try {
      configure();
      assert.deepEqual(inspectImageFreshness(PINNED_AGENT, { skipRemoteCheck: true }), { status: 'missing', tag: PINNED_AGENT });
      assert.deepEqual(await inspectImageFreshnessAsync(PINNED_AGENT), { status: 'missing', tag: PINNED_AGENT });
    } finally {
      restore();
    }
  });
}

test('inspectImageFreshnessAsync cancels an in-flight exact-reference presence probe', async () => {
  const restore = installFakeDocker();
  try {
    process.env.DOCKER_FAKE_PRESENCE = 'hang';
    const controller = new AbortController();
    const started = Date.now();
    const pending = inspectImageFreshnessAsync(PINNED_AGENT, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('setup cancelled')), 50);
    await assert.rejects(pending, /setup cancelled/);
    assert.ok(Date.now() - started < 4000, 'abort must not wait for the hung docker inspect');
  } finally {
    restore();
  }
});

test('pullImages with PROPR_SKIP_AGENT_PULL accepts a pulled digest-pinned agent and retags latest', () => {
  const restore = installFakeDocker();
  try {
    const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-log-')), 'commands.log');
    writeFileSync(logPath, '');
    process.env.DOCKER_FAKE_LOG = logPath;
    const logs = [];

    pullImages(
      { images: { agent: PINNED_AGENT }, manifest: { registry: 'propr' } },
      { onLog: (line) => logs.push(line), env: { ...process.env, PROPR_SKIP_AGENT_PULL: '1' } }
    );

    assert.ok(logs.includes(`  · ${PINNED_AGENT} (local, pull skipped via PROPR_SKIP_AGENT_PULL)`), logs.join('\n'));
    assert.equal(readFileSync(logPath, 'utf8').trim(), `tag ${PINNED_AGENT} propr/agent:latest`);
  } finally {
    restore();
  }
});

test('pullImages with PROPR_SKIP_AGENT_PULL neither retags nor accepts a missing or uninspectable pinned agent', () => {
  for (const configure of [
    () => { process.env.DOCKER_FAKE_PRESENT = '0'; },
    () => { process.env.DOCKER_FAKE_PRESENCE = 'fail'; },
  ]) {
    const restore = installFakeDocker();
    try {
      const logPath = join(mkdtempSync(join(tmpdir(), 'propr-fake-docker-log-')), 'commands.log');
      writeFileSync(logPath, '');
      process.env.DOCKER_FAKE_LOG = logPath;
      configure();
      const logs = [];

      pullImages(
        { images: { agent: PINNED_AGENT }, manifest: { registry: 'propr' } },
        { onLog: (line) => logs.push(line), env: { ...process.env, PROPR_SKIP_AGENT_PULL: '1' } }
      );

      assert.ok(logs.includes(`  · ${PINNED_AGENT} (not found locally, pull skipped via PROPR_SKIP_AGENT_PULL)`), logs.join('\n'));
      assert.equal(readFileSync(logPath, 'utf8').trim(), '');
    } finally {
      restore();
    }
  }
});
