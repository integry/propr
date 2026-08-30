import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyDarwinImage } from './verify-darwin-image.mjs';

test('Darwin image verification retries only bounded documented resource states', async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-dmg-verify-'));
  const image = join(root, 'fixture.dmg');
  try {
    await writeFile(image, 'canonical-darwin-fixture');
    let calls = 0;
    const result = await verifyDarwinImage(image, {
      nativePlatform: 'darwin',
      wait: async () => undefined,
      run: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('busy'), {
          stderr: calls === 1
            ? 'hdiutil: verify failed - Resource temporarily unavailable\n'
            : 'hdiutil: verify failed - Resource busy\n',
        });
      },
    });
    assert.equal(result.attempts, 3);
    assert.equal(calls, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Darwin image verification does not retry malformed/truncated images or accept mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-dmg-malformed-'));
  const image = join(root, 'fixture.dmg');
  try {
    await writeFile(image, 'canonical-darwin-fixture');
    let malformedCalls = 0;
    await assert.rejects(verifyDarwinImage(image, {
      nativePlatform: 'darwin',
      wait: async () => undefined,
      run: async () => {
        malformedCalls += 1;
        throw Object.assign(new Error('malformed'), { stderr: 'hdiutil: verify failed - image not recognized\n' });
      },
    }), /rejected the image/);
    assert.equal(malformedCalls, 1);

    await assert.rejects(verifyDarwinImage(image, {
      nativePlatform: 'darwin',
      run: async () => { await truncate(image, 3); },
    }), /identity or checksum changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
