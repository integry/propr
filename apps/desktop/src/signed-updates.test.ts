import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import { checkForSignedUpdates, verifySignedUpdateManifest } from './signed-updates';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const manifest = {
  schemaVersion: 1,
  channel: 'stable',
  version: '1.2.4',
  tag: 'desktop-v1.2.4',
  publishedAt: '2026-08-29T12:00:00.000Z',
  feeds: {
    'darwin-arm64': { url: 'https://updates.example.test/darwin/arm64/RELEASES.json', signingIdentity: 'Developer ID Application: Example' },
    'win32-x64': { url: 'https://updates.example.test/win32/x64', signingIdentity: 'Example Publisher' },
  },
};
const payload = Buffer.from(`${JSON.stringify(manifest)}\n`);
const signature = sign(null, payload, keys.privateKey).toString('base64');

describe('signed desktop updates', () => {
  test('verifies the exact published manifest bytes', () => {
    assert.equal(verifySignedUpdateManifest(payload, signature, publicKey).version, '1.2.4');
    assert.throws(
      () => verifySignedUpdateManifest(Buffer.from(payload.toString().replace('1.2.4', '1.2.5')), signature, publicKey),
      /signature verification failed/,
    );
  });

  test('configures the native updater only after signature and identity verification', async () => {
    const calls: unknown[] = [];
    const result = await checkForSignedUpdates({
      config: {
        manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
        publicKey,
        signingIdentity: 'Example Publisher',
      },
      currentVersion: '1.2.3',
      platform: 'win32',
      arch: 'x64',
      fetchBytes: async url => url.endsWith('.sig') ? Buffer.from(signature) : payload,
      updater: {
        setFeedURL: options => calls.push(options),
        checkForUpdates: () => calls.push('check'),
      },
    });
    assert.equal(result, 'checked');
    assert.deepEqual(calls, [{ url: 'https://updates.example.test/win32/x64' }, 'check']);
  });

  test('does not initialize an updater for current or unsupported builds', async () => {
    let configured = false;
    const common = {
      config: { manifestUrl: 'https://updates.example.test/stable/desktop-release.json', publicKey, signingIdentity: 'Example Publisher' },
      currentVersion: '1.2.4',
      arch: 'x64',
      fetchBytes: async (url: string) => url.endsWith('.sig') ? Buffer.from(signature) : payload,
      updater: { setFeedURL: () => { configured = true; }, checkForUpdates: () => { configured = true; } },
    };
    assert.equal(await checkForSignedUpdates({ ...common, platform: 'win32' }), 'current');
    assert.equal(await checkForSignedUpdates({ ...common, platform: 'linux' }), 'unsupported');
    assert.equal(configured, false);
  });

  test('rejects a signer identity change even in a correctly signed manifest', async () => {
    await assert.rejects(
      checkForSignedUpdates({
        config: { manifestUrl: 'https://updates.example.test/stable/desktop-release.json', publicKey, signingIdentity: 'Different Publisher' },
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: async url => url.endsWith('.sig') ? Buffer.from(signature) : payload,
        updater: { setFeedURL: () => assert.fail('must not configure updater'), checkForUpdates: () => assert.fail('must not check') },
      }),
      /identity does not match/,
    );
  });
});
