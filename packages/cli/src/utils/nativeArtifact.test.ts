import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertCanonicalNativeArtifactParents,
  physicalNativeArtifactCandidate,
} from './nativeArtifact.js';

test('packaged native artifact candidates resolve to the physical non-ASAR resource', () => {
  assert.equal(
    physicalNativeArtifactCandidate(join('/Applications/ProPR.app/Contents/Resources/app.asar', '.vite/native/broker')),
    join('/Applications/ProPR.app/Contents/Resources/app.asar.unpacked', '.vite/native/broker'),
  );
});

test('packaged native artifact candidates require canonical non-link parent ancestry', () => {
  const fixture = mkdtempSync(join(realpathSync.native(tmpdir()), 'propr-native-artifact-'));
  try {
    const canonical = join(fixture, 'native', 'prebuilds', 'darwin-arm64');
    mkdirSync(canonical, { recursive: true });
    const artifact = join(canonical, 'broker');
    writeFileSync(artifact, 'fixture');
    assert.doesNotThrow(() => assertCanonicalNativeArtifactParents(artifact));

    const linked = join(fixture, 'linked');
    symlinkSync(join(fixture, 'native'), linked, 'dir');
    assert.throws(
      () => assertCanonicalNativeArtifactParents(join(linked, 'prebuilds', 'darwin-arm64', 'broker')),
      /ancestry failed verification/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
