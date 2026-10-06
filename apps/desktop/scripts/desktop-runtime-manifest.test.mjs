import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  createDesktopRuntimeManifest,
  normalizeDesktopRuntimeManifestMode,
  validateDesktopRuntimeManifest,
  validatePublishedDesktopRuntimeImageInspection,
  validatePublishedManagedAgentInspection,
  writeDesktopRuntimeManifest,
} from './desktop-runtime-manifest.mjs';

const revision = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const base = {
  version: '0.8.15', git_sha: 'legacy', registry: 'propr',
  images: {
    app: 'propr/app:0.8.15', ui: 'propr/ui:0.8.15', docs: 'propr/docs:0.8.15',
    agent: 'propr/agent:0.8.15', redis: 'redis:7-alpine',
  },
};

describe('desktop runtime manifest alignment', () => {
  test('normalizes generated and packaged manifests for ordinary-user reads', {
    skip: process.platform === 'win32',
  }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'propr-desktop-runtime-manifest-'));
    const generated = join(directory, 'generated.json');
    const packaged = join(directory, 'packaged.json');
    try {
      writeFileSync(generated, '{}\n', { mode: 0o600 });
      writeDesktopRuntimeManifest(generated, base);
      assert.equal(statSync(generated).mode & 0o777, 0o644);

      writeFileSync(packaged, '{}\n', { mode: 0o600 });
      chmodSync(packaged, 0o600);
      normalizeDesktopRuntimeManifestMode(packaged);
      assert.equal(statSync(packaged).mode & 0o777, 0o644);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('creates a source-local manifest without claiming unpublished images', () => {
    const manifest = createDesktopRuntimeManifest(base, {
      distribution: 'local', sourceRevision: revision,
      appImage: `propr-desktop-local/app:${revision}`,
      uiImage: `propr-desktop-local/ui:${revision}`,
      apiCompatibility: '2026-06-27',
    });
    assert.equal(manifest.images.app, `propr-desktop-local/app:${revision}`);
    assert.equal(manifest.desktopRuntime.distribution, 'local');
    assert.equal(manifest.git_sha, revision);
    assert.equal(manifest.images.agent, base.images.agent);
  });

  test('requires published release images to bind the exact commit tag and digest', () => {
    const manifest = createDesktopRuntimeManifest(base, {
      distribution: 'published', sourceRevision: revision,
      appImage: `propr/app:${revision}@${digest}`,
      uiImage: `propr/ui:${revision}@${digest}`,
      apiCompatibility: '2026-06-27',
    });
    assert.equal(manifest.desktopRuntime.distribution, 'published');
    assert.throws(() => createDesktopRuntimeManifest(base, {
      distribution: 'published', sourceRevision: revision,
      appImage: 'propr/app:0.8.15', uiImage: `propr/ui:${revision}@${digest}`,
      apiCompatibility: '2026-06-27',
    }), /not bound/);
  });

  test('rejects a manifest from another source or compatibility contract', () => {
    const manifest = createDesktopRuntimeManifest(base, {
      distribution: 'local', sourceRevision: revision,
      appImage: `propr-desktop-local/app:${revision}`,
      uiImage: `propr-desktop-local/ui:${revision}`,
      apiCompatibility: '2026-06-27',
    });
    assert.throws(() => validateDesktopRuntimeManifest(manifest, {
      sourceRevision: 'c'.repeat(40),
    }), /release revision/);
    assert.throws(() => validateDesktopRuntimeManifest(manifest, {
      apiCompatibility: '2025-01-01',
    }), /compatibility contract/);
  });

  test('requires the separately resolved release tag to match its configured digest', () => {
    const image = `propr/app:${revision}@${digest}`;
    const inspection = {
      digest,
      manifests: [
        { platform: { os: 'linux', architecture: 'amd64' } },
        { platform: { os: 'linux', architecture: 'arm64' } },
      ],
    };
    assert.equal(validatePublishedDesktopRuntimeImageInspection(image, 'app', revision, inspection), inspection);
    assert.throws(() => validatePublishedDesktopRuntimeImageInspection(image, 'app', revision, {
      ...inspection,
      digest: `sha256:${'c'.repeat(64)}`,
    }), /does not resolve to configured digest/);
  });

  test('requires both supported Linux architectures in every published runtime image', () => {
    const image = `propr/ui:${revision}@${digest}`;
    assert.throws(() => validatePublishedDesktopRuntimeImageInspection(image, 'ui', revision, {
      digest,
      manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }],
    }), /missing required platforms: linux\/arm64/);
  });
});

describe('desktop runtime managed agent binding', () => {
  const published = {
    distribution: 'published', sourceRevision: revision,
    appImage: `propr/app:${revision}@${digest}`,
    uiImage: `propr/ui:${revision}@${digest}`,
    apiCompatibility: '2026-06-27',
  };
  const agentImage = `propr/agent:${revision}@${digest}`;
  const agentConfig = (overrides = {}) => ({
    os: 'linux',
    architecture: 'amd64',
    config: { Labels: {
      'org.opencontainers.image.revision': revision,
      'org.opencontainers.image.source': 'https://github.com/integry/propr',
      'dev.propr.agent-bundle': 'true',
    } },
    ...overrides,
  });

  test('embeds the exact agent reference in the launcher manifest only when explicitly bound', () => {
    const manifest = createDesktopRuntimeManifest(base, { ...published, agentImage });
    assert.equal(manifest.images.agent, agentImage);
    assert.deepEqual(manifest.desktopRuntime.managedAgent, { image: agentImage, platforms: ['linux/amd64'] });
    assert.equal(validateDesktopRuntimeManifest(manifest, { agentImage }), manifest);

    const ordinary = createDesktopRuntimeManifest(base, published);
    assert.equal(ordinary.images.agent, base.images.agent);
    assert.equal(ordinary.desktopRuntime.managedAgent, undefined);
    assert.throws(() => validateDesktopRuntimeManifest(ordinary, { agentImage }), /expected source-aligned managed agent/);
  });

  test('rejects missing, mutable, other-source, local, or retargeted agent bindings', () => {
    for (const candidate of ['', 'propr/agent:0.9.0', `propr/agent:${revision}`,
      `propr/agent:${'c'.repeat(40)}@${digest}`, `propr/app:${revision}@${digest}`]) {
      assert.throws(() => createDesktopRuntimeManifest(base, { ...published, agentImage: candidate }),
        /managed agent image is not published/, candidate);
    }
    assert.throws(() => createDesktopRuntimeManifest(base, {
      ...published, distribution: 'local',
      appImage: `propr-desktop-local/app:${revision}`, uiImage: `propr-desktop-local/ui:${revision}`,
      agentImage,
    }), /managed agent image is not published/);
    const manifest = createDesktopRuntimeManifest(base, { ...published, agentImage });
    assert.throws(() => validateDesktopRuntimeManifest({
      ...manifest, images: { ...manifest.images, agent: 'propr/agent:0.9.0' },
    }), /managed agent image is not published/);
    assert.throws(() => validateDesktopRuntimeManifest({
      ...manifest,
      desktopRuntime: { ...manifest.desktopRuntime, managedAgent: { image: agentImage, platforms: ['linux/amd64', 'linux/arm64'] } },
    }), /linux\/amd64/);
  });

  test('accepts only a registry-resolved source-labelled linux/amd64 agent', () => {
    const index = { digest, manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] };
    assert.equal(validatePublishedManagedAgentInspection(agentImage, revision, index, { 'linux/amd64': agentConfig() }), index);
    assert.equal(validatePublishedManagedAgentInspection(agentImage, revision, { digest }, agentConfig()).digest, digest);
    assert.throws(() => validatePublishedManagedAgentInspection(agentImage, revision, {
      digest: `sha256:${'c'.repeat(64)}`,
    }, agentConfig()), /does not resolve to configured digest/);
    assert.throws(() => validatePublishedManagedAgentInspection(agentImage, revision, {
      digest,
      manifests: [
        { platform: { os: 'linux', architecture: 'amd64' } },
        { platform: { os: 'linux', architecture: 'arm64' } },
      ],
    }, { 'linux/amd64': agentConfig(), 'linux/arm64': agentConfig({ architecture: 'arm64' }) }), /exactly linux\/amd64/);
    assert.throws(() => validatePublishedManagedAgentInspection(agentImage, revision, { digest },
      agentConfig({ architecture: 'arm64' })), /not a linux\/amd64 image/);
    assert.throws(() => validatePublishedManagedAgentInspection(agentImage, revision, { digest }, agentConfig({
      config: { Labels: { ...agentConfig().config.Labels, 'org.opencontainers.image.revision': 'c'.repeat(40) } },
    })), /not the unified agent bundle built from the release revision/);
    assert.throws(() => validatePublishedManagedAgentInspection(agentImage, revision, { digest }, agentConfig({
      config: { Labels: { ...agentConfig().config.Labels, 'dev.propr.agent-bundle': undefined } },
    })), /not the unified agent bundle/);
    assert.throws(() => validatePublishedManagedAgentInspection('propr/agent:0.9.0', revision, { digest }, agentConfig()),
      /digest-pinned propr\/agent reference/);
  });

  test('release generation refuses an explicitly empty agent input and writes an exact binding', () => {
    const directory = mkdtempSync(join(tmpdir(), 'propr-desktop-runtime-agent-'));
    const script = resolve(import.meta.dirname, 'desktop-runtime-manifest.mjs');
    const basePath = join(directory, 'base.json');
    writeFileSync(basePath, JSON.stringify(base));
    const releaseArgs = [script, 'release', '--source-revision', revision,
      '--app-image', published.appImage, '--ui-image', published.uiImage,
      '--api-compatibility', '2026-06-27', '--base', basePath];
    try {
      const empty = spawnSync('node', [...releaseArgs, '--agent-image', '', '--output', join(directory, 'empty', 'manifest.json')], { encoding: 'utf8' });
      assert.notEqual(empty.status, 0);
      assert.match(empty.stderr, /--agent-image must be a published propr\/agent/);
      const output = join(directory, 'bound', 'manifest.json');
      const bound = spawnSync('node', [...releaseArgs, '--agent-image', agentImage, '--output', output], { encoding: 'utf8' });
      assert.equal(bound.status, 0, bound.stderr);
      assert.equal(JSON.parse(readFileSync(output, 'utf8')).images.agent, agentImage);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('desktop source runtime build inputs', () => {
  test('copies the client workspace manifest and source into the UI image build', () => {
    const dockerfile = readFileSync(resolve(import.meta.dirname, '../../../propr-ui/Dockerfile'), 'utf8');
    assert.match(dockerfile, /COPY packages\/client\/package\*\.json \.\/packages\/client\//);
    assert.match(dockerfile, /COPY packages\/client \.\/packages\/client/);
    assert.match(dockerfile, /cd packages\/client && npm run build/);
  });

  test('makes the isolated smoke data root private independently of caller umask', () => {
    const smoke = readFileSync(resolve(import.meta.dirname, 'smoke-local-runtime.sh'), 'utf8');
    const create = smoke.indexOf('mkdir -p "$SMOKE_ROOT/data" "$SMOKE_ROOT/logs"');
    const protect = smoke.indexOf('chmod 700 "$SMOKE_ROOT/data" "$SMOKE_ROOT/logs"');
    const launch = smoke.indexOf('docker run -d --name "$API_CONTAINER"');
    assert.ok(create >= 0 && protect > create && launch > protect);
  });
});
