import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  checkForSignedUpdates,
  type SignedUpdateManifest,
  verifySignedUpdateManifest,
} from './signed-updates';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const artifact = Buffer.from('signed windows package bytes');
const artifactUrl = 'https://updates.example.test/win32/x64/ProPR-Desktop-1.2.4-windows-x64-full.nupkg';
const feed = Buffer.from(`0123456789abcdef0123456789abcdef01234567 ProPR-Desktop-1.2.4-windows-x64-full.nupkg ${artifact.length}\n`);
const bytes = (url: string, value: Buffer) => ({
  url,
  size: value.length,
  sha256: createHash('sha256').update(value).digest('hex'),
});
const manifest: SignedUpdateManifest = {
  schemaVersion: 2,
  channel: 'stable',
  manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
  version: '1.2.4',
  tag: 'desktop-v1.2.4',
  publishedAt: '2026-08-29T12:00:00.000Z',
  feeds: {
    'win32-x64': {
      target: 'win32-x64',
      version: '1.2.4',
      feed: bytes('https://updates.example.test/win32/x64/RELEASES', feed),
      artifact: {
        ...bytes(artifactUrl, artifact),
        fileName: 'ProPR-Desktop-1.2.4-windows-x64-full.nupkg',
        kind: 'nupkg',
      },
      signer: { type: 'authenticode-subject', identity: 'CN=Example Publisher' },
    },
  },
};

const signed = (value: unknown = manifest) => {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`);
  return { payload, signature: sign(null, payload, keys.privateKey).toString('base64') };
};

const fetcher = (payload: Buffer, signature: string, overrides: Record<string, Buffer> = {}) => async (url: string) => {
  if (url.endsWith('desktop-release.json.sig')) return Buffer.from(signature);
  if (url.endsWith('desktop-release.json')) return payload;
  if (url === manifest.feeds['win32-x64'].feed.url) return overrides.feed ?? feed;
  if (url === artifactUrl) return overrides.artifact ?? artifact;
  throw new Error(`Unexpected URL ${url}`);
};

const config = {
  manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
  publicKey,
  signingIdentity: 'CN=Example Publisher',
};

describe('signed desktop updates', () => {
  test('verifies the exact published manifest bytes', () => {
    const release = signed();
    assert.equal(verifySignedUpdateManifest(release.payload, release.signature, publicKey).version, '1.2.4');
    assert.throws(
      () => verifySignedUpdateManifest(Buffer.from(release.payload.toString().replace('1.2.4', '1.2.5')), release.signature, publicKey),
      /signature verification failed/,
    );
  });

  test('checks exact feed, artifact, and native signer without invoking Electron autoUpdater', async () => {
    const release = signed();
    let verifiedBytes: Buffer | undefined;
    const result = await checkForSignedUpdates({
      config,
      currentVersion: '1.2.3',
      platform: 'win32',
      arch: 'x64',
      fetchBytes: fetcher(release.payload, release.signature),
      verifyNativeSigner: async value => {
        verifiedBytes = value;
        return { type: 'authenticode-subject', identity: 'CN=Example Publisher' };
      },
    });
    assert.equal(result, 'available');
    assert.equal(verifiedBytes, artifact);
  });

  test('rejects tampered native feed bytes', async () => {
    const release = signed();
    const tamperedFeed = Buffer.from(feed);
    tamperedFeed[0] = tamperedFeed[0] === 48 ? 49 : 48;
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: fetcher(release.payload, release.signature, { feed: tamperedFeed }),
        verifyNativeSigner: async () => assert.fail('must not inspect a package from a tampered feed'),
      }),
      /feed SHA-256/i,
    );
  });

  test('rejects tampered artifact bytes before native signer inspection', async () => {
    const release = signed();
    const tamperedArtifact = Buffer.from(artifact);
    tamperedArtifact[0] ^= 1;
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: fetcher(release.payload, release.signature, { artifact: tamperedArtifact }),
        verifyNativeSigner: async () => assert.fail('must not inspect a tampered package'),
      }),
      /artifact SHA-256/i,
    );
  });

  test('rejects the actual native signer when it differs from the signed build pin', async () => {
    const release = signed();
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: fetcher(release.payload, release.signature),
        verifyNativeSigner: async () => ({ type: 'authenticode-subject', identity: 'CN=Attacker' }),
      }),
      /artifact signer does not match/,
    );
  });

  test('rejects wrong target, version, and architecture bindings', async () => {
    const wrongTarget = structuredClone(manifest) as unknown as Record<string, any>;
    wrongTarget.feeds['win32-x64'].target = 'win32-arm64';
    const targetRelease = signed(wrongTarget);
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: fetcher(targetRelease.payload, targetRelease.signature),
      }),
      /exact target and version/,
    );

    const wrongVersion = structuredClone(manifest) as unknown as Record<string, any>;
    wrongVersion.feeds['win32-x64'].version = '1.2.3';
    const versionRelease = signed(wrongVersion);
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: fetcher(versionRelease.payload, versionRelease.signature),
      }),
      /exact target and version/,
    );

    const release = signed();
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'arm64',
        fetchBytes: fetcher(release.payload, release.signature),
      }),
      /does not contain a feed for win32-arm64/,
    );
  });

  test('rejects manifest query strings before resolving the pathname .sig companion', async () => {
    await assert.rejects(
      checkForSignedUpdates({
        config: { ...config, manifestUrl: `${config.manifestUrl}?channel=stable` },
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        fetchBytes: async () => assert.fail('query-bearing manifest URL must not be fetched'),
      }),
      /without credentials, a fragment, or a query/,
    );
  });

  test('does not fetch update bytes for current or unsupported builds', async () => {
    const release = signed();
    let artifactFetched = false;
    const currentFetcher = async (url: string) => {
      if (!url.includes('desktop-release.json')) artifactFetched = true;
      return fetcher(release.payload, release.signature)(url);
    };
    assert.equal(await checkForSignedUpdates({
      config,
      currentVersion: '1.2.4',
      platform: 'win32',
      arch: 'x64',
      fetchBytes: currentFetcher,
    }), 'current');
    assert.equal(await checkForSignedUpdates({
      config,
      currentVersion: '1.2.3',
      platform: 'linux',
      arch: 'x64',
      fetchBytes: async () => assert.fail('unsupported builds must not fetch metadata'),
    }), 'unsupported');
    assert.equal(artifactFetched, false);
  });
});
