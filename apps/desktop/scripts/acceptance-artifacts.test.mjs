import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ACCEPTANCE_JOURNEYS, ACCEPTANCE_VARIANTS, readPngDimensions,
  expectedScreenshotNames, scanAcceptancePaths, screenshotName,
  validateAcceptanceEvidence, verifyAcceptanceArtifacts,
} from './acceptance-artifacts.mjs';

const pngHeader = (width, height) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

describe('packaged acceptance artifact contract', () => {
  it('has deterministic unique names and dimensions for every journey/variant', () => {
    const names = ACCEPTANCE_JOURNEYS.flatMap(journey => Object.entries(ACCEPTANCE_VARIANTS).map(([variant, config]) => {
      assert.deepEqual(readPngDimensions(pngHeader(config.viewport.width * config.deviceScaleFactor, config.viewport.height * config.deviceScaleFactor)), {
        width: config.viewport.width * config.deviceScaleFactor,
        height: config.viewport.height * config.deviceScaleFactor,
      });
      return screenshotName(journey, variant);
    }));
    assert.equal(new Set(names).size, ACCEPTANCE_JOURNEYS.length * Object.keys(ACCEPTANCE_VARIANTS).length);
    assert.ok(names.every(name => /^[a-z0-9-]+--[a-z0-9-]+\.png$/.test(name)));
  });

  it('scans arbitrary persisted/artifact surfaces for exact and shaped secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-'));
    try {
      await mkdir(join(root, 'storage'));
      await writeFile(join(root, 'storage', 'safe.json'), '{"status":"ready"}');
      await scanAcceptancePaths([root], ['acceptance-exact-sentinel']);
      await writeFile(join(root, 'storage', 'unsafe.log'), 'acceptance-exact-sentinel');
      await assert.rejects(scanAcceptancePaths([root], ['acceptance-exact-sentinel']), /Secret sentinel/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on a missing artifact set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-missing-'));
    try {
      await mkdir(join(root, 'screenshots'));
      await assert.rejects(verifyAcceptanceArtifacts(root), /artifact set mismatch.*missing/i);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires complete deterministic manifests and zero-threshold accessibility evidence', () => {
    const accessible = {
      schemaVersion: 1, serious: 0, critical: 0, keyboardOrder: true, visibleFocus: true,
      modalFocusTrap: true, modalFocusRestore: true, accessibleNames: true, liveAnnouncements: true,
    };
    const manifest = {
      schemaVersion: 1, platform: 'linux', arch: 'x64', generatedAt: '2026-01-02T03:04:05.000Z',
      screenshots: expectedScreenshotNames().map(name => ({ name })),
    };
    assert.doesNotThrow(() => validateAcceptanceEvidence(accessible, manifest));
    assert.throws(() => validateAcceptanceEvidence({ ...accessible, serious: 1 }, manifest), /thresholds/);
    assert.throws(() => validateAcceptanceEvidence(accessible, { ...manifest, screenshots: manifest.screenshots.slice(1) }), /incomplete/);
    assert.throws(() => validateAcceptanceEvidence(accessible, { ...manifest, generatedAt: new Date().toISOString() }), /non-deterministic/);
  });
});
