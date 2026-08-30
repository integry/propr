import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  checkForSignedUpdates,
  downloadBoundedUpdateFile,
  fetchBoundedUpdateBytes,
  SIGNED_UPDATE_DOWNLOAD_LIMITS,
  type SignedUpdateManifest,
  type SignedUpdateRequest,
  validateMacOSUpdateApplicationLayout,
  verifySignedUpdateManifest,
} from './signed-updates';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const certificateSha256 = '1'.repeat(64);
const spkiSha256 = '2'.repeat(64);
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
      signer: {
        type: 'authenticode-subject',
        identity: 'CN=Example Publisher',
        certificateSha256,
        spkiSha256,
      },
    },
  },
};

const signed = (value: unknown = manifest) => {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`);
  return { payload, signature: sign(null, payload, keys.privateKey).toString('base64') };
};

const response = (
  url: string,
  chunks: Uint8Array[],
  { headers, status = 200 }: { headers?: HeadersInit; status?: number } = {},
): Response => {
  const value = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers, status });
  Object.defineProperty(value, 'url', { value: url });
  return value;
};

const byteResponse = (url: string, value: Buffer): Response => response(
  url,
  [value],
  { headers: { 'content-length': String(value.length) } },
);

const fetcher = (payload: Buffer, signature: string, overrides: Record<string, Buffer> = {}): SignedUpdateRequest => async (url: string) => {
  if (url.endsWith('desktop-release.json.sig')) return byteResponse(url, Buffer.from(signature));
  if (url.endsWith('desktop-release.json')) return byteResponse(url, payload);
  if (url === manifest.feeds['win32-x64'].feed.url) return byteResponse(url, overrides.feed ?? feed);
  if (url === artifactUrl) return byteResponse(url, overrides.artifact ?? artifact);
  throw new Error(`Unexpected URL ${url}`);
};

const config = {
  manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
  publicKey,
  signingIdentity: 'CN=Example Publisher',
  windowsSignerPins: [`certificate-sha256:${certificateSha256}`],
};

describe('signed desktop updates', () => {
  test('accepts only the real canonical macOS application at the ZIP root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-macos-update-layout-test-'));
    try {
      const valid = join(directory, 'valid');
      await mkdir(join(valid, 'propr-desktop.app'), { recursive: true });
      assert.equal(
        await validateMacOSUpdateApplicationLayout(valid),
        join(valid, 'propr-desktop.app'),
      );

      const decoy = join(directory, 'decoy');
      await mkdir(join(decoy, 'propr-desktop.app'), { recursive: true });
      await mkdir(join(decoy, 'signed-decoy.app'));
      await assert.rejects(
        validateMacOSUpdateApplicationLayout(decoy),
        /ambiguous application layout/,
      );

      const linked = join(directory, 'linked');
      await mkdir(linked);
      await mkdir(join(directory, 'real.app'));
      await symlink('../real.app', join(linked, 'propr-desktop.app'));
      await assert.rejects(
        validateMacOSUpdateApplicationLayout(linked),
        /must be a real directory/,
      );

      const missing = join(directory, 'missing');
      await mkdir(missing);
      await assert.rejects(
        validateMacOSUpdateApplicationLayout(missing),
        /missing the canonical propr-desktop\.app bundle/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('verifies the exact published manifest bytes', () => {
    const release = signed();
    assert.equal(verifySignedUpdateManifest(release.payload, release.signature, publicKey).version, '1.2.4');
    assert.throws(
      () => verifySignedUpdateManifest(Buffer.from(release.payload.toString().replace('1.2.4', '1.2.5')), release.signature, publicKey),
      /signature verification failed/,
    );
  });

  test('rejects a signed artifact size above the global runtime limit', () => {
    const oversized = structuredClone(manifest);
    oversized.feeds['win32-x64'].artifact.size = SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes + 1;
    const release = signed(oversized);
    assert.throws(
      () => verifySignedUpdateManifest(release.payload, release.signature, publicKey),
      /artifact exceeds the runtime download limit/,
    );
  });

  test('checks exact feed, artifact, and native signer without invoking Electron autoUpdater', async () => {
    const release = signed();
    let verifiedBytes: Buffer | undefined;
    let verifiedPath: string | undefined;
    const result = await checkForSignedUpdates({
      config,
      currentVersion: '1.2.3',
      platform: 'win32',
      arch: 'x64',
      request: fetcher(release.payload, release.signature),
      verifyNativeSigner: async packagePath => {
        verifiedPath = packagePath;
        verifiedBytes = await readFile(packagePath);
        return { type: 'authenticode-subject', identity: 'CN=Example Publisher', certificateSha256, spkiSha256 };
      },
    });
    assert.equal(result, 'available');
    assert.deepEqual(verifiedBytes, artifact);
    await assert.rejects(access(verifiedPath!));
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
        request: fetcher(release.payload, release.signature, { feed: tamperedFeed }),
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
        request: fetcher(release.payload, release.signature, { artifact: tamperedArtifact }),
        verifyNativeSigner: async () => assert.fail('must not inspect a tampered package'),
      }),
      /artifact SHA-256/i,
    );
  });

  test('rejects the actual native signer when it differs from the signed build pin', async () => {
    const release = signed();
    let inspectedPath: string | undefined;
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(release.payload, release.signature),
        verifyNativeSigner: async packagePath => {
          inspectedPath = packagePath;
          return { type: 'authenticode-subject', identity: 'CN=Attacker', certificateSha256, spkiSha256 };
        },
      }),
      /artifact signer does not match/,
    );
    await assert.rejects(access(inspectedPath!));
  });

  test('rejects same-subject different-key signers and tampered or missing pin evidence', async () => {
    const release = signed();
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(release.payload, release.signature),
        verifyNativeSigner: async () => ({
          type: 'authenticode-subject',
          identity: 'CN=Example Publisher',
          certificateSha256: '3'.repeat(64),
          spkiSha256: '4'.repeat(64),
        }),
      }),
      /artifact signer does not match/,
    );

    const tamperedEvidence = structuredClone(manifest);
    tamperedEvidence.feeds['win32-x64'].signer.certificateSha256 = '3'.repeat(64);
    tamperedEvidence.feeds['win32-x64'].signer.spkiSha256 = '4'.repeat(64);
    const tamperedRelease = signed(tamperedEvidence);
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(tamperedRelease.payload, tamperedRelease.signature),
      }),
      /fingerprint is not in the embedded allowlist/,
    );

    await assert.rejects(
      checkForSignedUpdates({
        config: { ...config, windowsSignerPins: [] },
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(release.payload, release.signature),
      }),
      /signer pin allowlist.*required/,
    );

    const malformedEvidence = structuredClone(manifest) as unknown as Record<string, any>;
    malformedEvidence.feeds['win32-x64'].signer.spkiSha256 = 'not-a-fingerprint';
    const malformedRelease = signed(malformedEvidence);
    assert.throws(
      () => verifySignedUpdateManifest(malformedRelease.payload, malformedRelease.signature, publicKey),
      /fingerprint evidence is invalid/,
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
        request: fetcher(targetRelease.payload, targetRelease.signature),
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
        request: fetcher(versionRelease.payload, versionRelease.signature),
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
        request: fetcher(release.payload, release.signature),
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
        request: async () => assert.fail('query-bearing manifest URL must not be fetched'),
      }),
      /without credentials, a fragment, or a query/,
    );
  });

  test('does not fetch update bytes for current or unsupported builds', async () => {
    const release = signed();
    let artifactFetched = false;
    const currentFetcher: SignedUpdateRequest = async (url, init) => {
      if (!url.includes('desktop-release.json')) artifactFetched = true;
      return fetcher(release.payload, release.signature)(url, init);
    };
    assert.equal(await checkForSignedUpdates({
      config,
      currentVersion: '1.2.4',
      platform: 'win32',
      arch: 'x64',
      request: currentFetcher,
    }), 'current');
    assert.equal(await checkForSignedUpdates({
      config,
      currentVersion: '1.2.3',
      platform: 'linux',
      arch: 'x64',
      request: async () => assert.fail('unsupported builds must not fetch metadata'),
    }), 'unsupported');
    assert.equal(artifactFetched, false);
  });
});

describe('signed update download boundary', () => {
  const url = 'https://updates.example.test/update.bin';

  test('aborts before reading a response with an oversized Content-Length', async () => {
    let signal: AbortSignal | undefined;
    const request: SignedUpdateRequest = async (requestedUrl, init) => {
      signal = init.signal as AbortSignal;
      return response(requestedUrl, [Buffer.from('ignored')], {
        headers: { 'content-length': '6' },
      });
    };
    await assert.rejects(
      fetchBoundedUpdateBytes({ request, url, label: 'Test metadata', maxBytes: 5, timeoutMs: 1_000 }),
      /Content-Length exceeds/,
    );
    assert.equal(signal?.aborted, true);
  });

  test('aborts a chunked response as soon as received bytes overflow the limit', async () => {
    let signal: AbortSignal | undefined;
    const request: SignedUpdateRequest = async (requestedUrl, init) => {
      signal = init.signal as AbortSignal;
      return response(requestedUrl, [Buffer.from('abc'), Buffer.from('def')]);
    };
    await assert.rejects(
      fetchBoundedUpdateBytes({ request, url, label: 'Test metadata', maxBytes: 5, timeoutMs: 1_000 }),
      /received bytes exceed/,
    );
    assert.equal(signal?.aborted, true);
  });

  test('aborts a stalled request at its timeout', async () => {
    let signal: AbortSignal | undefined;
    const request: SignedUpdateRequest = async (_requestedUrl, init) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
    await assert.rejects(
      fetchBoundedUpdateBytes({ request, url, label: 'Test metadata', maxBytes: 5, timeoutMs: 10 }),
      /timed out and was aborted/,
    );
    assert.equal(signal?.aborted, true);
  });

  test('removes a partial artifact when a chunked response is undersized', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-boundary-test-'));
    const destinationPath = join(directory, 'update.bin');
    try {
      const request: SignedUpdateRequest = async requestedUrl => response(requestedUrl, [Buffer.from('four')]);
      await assert.rejects(
        downloadBoundedUpdateFile({
          request,
          url,
          destinationPath,
          label: 'Test artifact',
          maxBytes: 10,
          timeoutMs: 1_000,
          expected: { size: 5, sha256: createHash('sha256').update('wrong').digest('hex') },
        }),
        /size does not match the signed size/,
      );
      await assert.rejects(access(destinationPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('streams an exact-size artifact to one file and verifies its SHA-256', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-boundary-test-'));
    const destinationPath = join(directory, 'update.bin');
    const exact = Buffer.from('exact artifact bytes');
    try {
      const request: SignedUpdateRequest = async requestedUrl => response(
        requestedUrl,
        [exact.subarray(0, 5), exact.subarray(5)],
      );
      await downloadBoundedUpdateFile({
        request,
        url,
        destinationPath,
        label: 'Test artifact',
        maxBytes: 100,
        timeoutMs: 1_000,
        expected: bytes(url, exact),
      });
      assert.deepEqual(await readFile(destinationPath), exact);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a cross-origin final redirect URL', async () => {
    const request: SignedUpdateRequest = async () => response(
      'https://cdn.example.test/update.bin',
      [Buffer.from('bytes')],
    );
    await assert.rejects(
      fetchBoundedUpdateBytes({ request, url, label: 'Test metadata', maxBytes: 10, timeoutMs: 1_000 }),
      /redirected outside its signed HTTPS origin/,
    );
  });
});
