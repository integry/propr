import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  createDesktopRuntimeManifest,
  normalizeDesktopRuntimeManifestMode,
  validateDesktopRuntimeManifest,
  validatePublishedDesktopRuntimeImageInspection,
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
