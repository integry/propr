import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import {
  applySignedUpdate,
  canonicalPosixFileIdentity,
  checkForSignedUpdates,
  collectUpdateCacheQuarantinesForTest,
  downloadBoundedUpdateFile,
  fetchBoundedUpdateBytes,
  parseSquirrelReleaseEntry,
  posixAuthorityIsPrivate,
  quarantineUpdateCacheNamespaceForTest,
  SIGNED_UPDATE_CACHE_POLICY,
  SIGNED_UPDATE_DOWNLOAD_LIMITS,
  sameExactFileIdentity,
  type SignedUpdateManifest,
  type SignedUpdateRequest,
  validateMacOSUpdateApplicationLayout,
  verifySignedUpdateManifest,
} from './signed-updates';
import { ensureWindowsPrivateDirectory, protectWindowsPrivateFile } from './windows-update-authority';

const execFileAsync = promisify(execFile);

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const certificateSha256 = '1'.repeat(64);
const spkiSha256 = '2'.repeat(64);
const artifact = Buffer.from('signed windows package bytes');
const artifactUrl = 'https://updates.example.test/win32/x64/ProPR-Desktop-1.2.4-windows-x64-full.nupkg';
const artifactSha1 = createHash('sha1').update(artifact).digest('hex');
const feed = Buffer.from(`${artifactSha1} ProPR-Desktop-1.2.4-windows-x64-full.nupkg ${artifact.length}\r\n`);
const bytes = (url: string, value: Buffer) => ({
  url,
  size: value.length,
  sha256: createHash('sha256').update(value).digest('hex'),
});
const manifest: SignedUpdateManifest = {
  schemaVersion: 2,
  channel: 'stable',
  manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
  windowsSignerPins: [`certificate-sha256:${certificateSha256}`],
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

const windowsArtifact = manifest.feeds['win32-x64'].artifact;
const windowsSigner = async () => ({
  type: 'authenticode-subject' as const,
  identity: 'CN=Example Publisher',
  certificateSha256,
  spkiSha256,
});

test('security identities preserve adjacent device/inode values above Number precision', () => {
  const adjacent = 2n ** 53n;
  const first = canonicalPosixFileIdentity(adjacent, adjacent + 1n);
  const second = canonicalPosixFileIdentity(adjacent, adjacent + 2n);
  assert.notEqual(first.inode, second.inode);
  assert.equal(sameExactFileIdentity(first, first), true);
  assert.equal(sameExactFileIdentity(first, second), false);
  assert.equal(posixAuthorityIsPrivate(1000n, 0o100600n, undefined), false);
  assert.equal(posixAuthorityIsPrivate(1000n, 0o100600n, 1000n), true);
  assert.equal(posixAuthorityIsPrivate(1000n, 0o100644n, 1000n), false);
});

describe('runtime Squirrel RELEASES binding', () => {
  test('accepts a canonical Windows Squirrel record and canonicalizes its SHA-1', () => {
    const entry = parseSquirrelReleaseEntry(
      Buffer.from(`${artifactSha1.toUpperCase()} ${windowsArtifact.fileName} ${artifact.length}\r\n`),
      '1.2.4',
      windowsArtifact,
    );
    assert.deepEqual(entry, { sha1: artifactSha1, fileName: windowsArtifact.fileName, size: artifact.length });
  });

  test('rejects duplicate, ambiguous, wrong-name/version/size, traversal, case, and algorithm records', () => {
    const valid = `${artifactSha1} ${windowsArtifact.fileName} ${artifact.length}`;
    const hostile = [
      `${valid}\n${valid}\n`,
      `${valid}\n${artifactSha1} ${windowsArtifact.fileName.toUpperCase()} ${artifact.length}\n`,
      `${artifactSha1} ProPR-Desktop-1.2.5-windows-x64-full.nupkg ${artifact.length}\n`,
      `${artifactSha1} other.nupkg ${artifact.length}\n`,
      `${artifactSha1} ${windowsArtifact.fileName} ${artifact.length + 1}\n`,
      `${artifactSha1} ../${windowsArtifact.fileName} ${artifact.length}\n`,
      `sha1:${artifactSha1} ${windowsArtifact.fileName} ${artifact.length}\n`,
      `${artifactSha1}  ${windowsArtifact.fileName} ${artifact.length}\n`,
    ];
    for (const candidate of hostile) {
      assert.throws(
        () => parseSquirrelReleaseEntry(Buffer.from(candidate), '1.2.4', windowsArtifact),
        /Signed Windows update feed is invalid/,
      );
    }
  });

  test('rejects a RELEASES SHA-1 that does not bind the signed SHA-256 package bytes', async () => {
    const mismatched = Buffer.from(`${'0'.repeat(40)} ${windowsArtifact.fileName} ${artifact.length}\n`);
    const changed = structuredClone(manifest);
    changed.feeds['win32-x64'].feed = bytes(manifest.feeds['win32-x64'].feed.url, mismatched);
    const release = signed(changed);
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(release.payload, release.signature, { feed: mismatched }),
        verifyNativeSigner: async () => assert.fail('mismatched SHA-1 must fail before signer verification'),
      }),
      /does not match Squirrel metadata/,
    );
  });
});

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

  test('keeps macOS checks non-installing while caching notarized signer-verified bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-macos-update-cache-test-'));
    const macArtifact = Buffer.from('signed macOS ZIP bytes');
    const macArtifactUrl = 'https://updates.example.test/darwin/x64/ProPR-Desktop-1.2.4-macos-x64-zip';
    const macFeed = Buffer.from(JSON.stringify({ url: macArtifactUrl, name: '1.2.4' }));
    const macManifest = structuredClone(manifest);
    macManifest.feeds['darwin-x64'] = {
      target: 'darwin-x64',
      version: '1.2.4',
      feed: bytes('https://updates.example.test/darwin/x64/RELEASES.json', macFeed),
      artifact: {
        ...bytes(macArtifactUrl, macArtifact),
        fileName: 'ProPR-Desktop-1.2.4-macos-x64-zip',
        kind: 'zip',
      },
      signer: {
        type: 'apple-team-id',
        identity: 'TEAMID1234',
        designatedRequirement: 'designated => identifier "com.propr.desktop" and anchor apple generic',
      },
    };
    const release = signed(macManifest);
    let artifactRequests = 0;
    const request: SignedUpdateRequest = async url => {
      if (url.endsWith('desktop-release.json.sig')) return byteResponse(url, Buffer.from(release.signature));
      if (url.endsWith('desktop-release.json')) return byteResponse(url, release.payload);
      if (url === macManifest.feeds['darwin-x64'].feed.url) return byteResponse(url, macFeed);
      if (url === macArtifactUrl) {
        artifactRequests += 1;
        return byteResponse(url, macArtifact);
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    let installs = 0;
    try {
      assert.equal(await checkForSignedUpdates({
        config: { ...config, signingIdentity: 'TEAMID1234' },
        currentVersion: '1.2.3',
        platform: 'darwin',
        arch: 'x64',
        request,
        cacheDirectory: join(directory, 'cache'),
        verifyNativeSigner: async () => ({
          type: 'apple-team-id',
          identity: 'TEAMID1234',
          designatedRequirement: 'designated => identifier "com.propr.desktop" and anchor apple generic',
        }),
      }), 'available');
      assert.equal(installs, 0);
      assert.equal(artifactRequests, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

    const alteredPolicy = structuredClone(manifest);
    alteredPolicy.windowsSignerPins = [`spki-sha256:${spkiSha256}`];
    const alteredPolicyRelease = signed(alteredPolicy);
    await assert.rejects(
      checkForSignedUpdates({
        config,
        currentVersion: '1.2.3',
        platform: 'win32',
        arch: 'x64',
        request: fetcher(alteredPolicyRelease.payload, alteredPolicyRelease.signature),
      }),
      /pin policy does not match the signed application policy/,
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

describe('verified update artifact cache', () => {
  const makeOptions = (
    cacheDirectory: string,
    request: SignedUpdateRequest,
    extra: Partial<Parameters<typeof checkForSignedUpdates>[0]> = {},
  ) => ({
    config,
    currentVersion: '1.2.3',
    platform: 'win32' as const,
    arch: 'x64',
    request,
    cacheDirectory,
    verifyNativeSigner: windowsSigner,
    ...extra,
  });

  const countingFetcher = (release: ReturnType<typeof signed>) => {
    let artifactRequests = 0;
    const base = fetcher(release.payload, release.signature);
    return {
      request: (async (url, init) => {
        if (url === artifactUrl) artifactRequests += 1;
        return base(url, init);
      }) as SignedUpdateRequest,
      count: () => artifactRequests,
    };
  };

  test('check then explicit apply downloads one artifact and check-only never installs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
    const cacheDirectory = join(directory, 'cache');
    const counted = countingFetcher(signed());
    let installs = 0;
    try {
      assert.equal(await checkForSignedUpdates(makeOptions(cacheDirectory, counted.request)), 'available');
      assert.equal(installs, 0);
      assert.equal(counted.count(), 1);
      assert.equal(await applySignedUpdate({
        ...makeOptions(cacheDirectory, counted.request),
        applyHeldArtifact: async source => {
          installs += 1;
          assert.deepEqual(await source.read(0, artifact.length), artifact);
          assert.deepEqual(source.feedBytes, feed);
        },
        installVerifiedArtifact: verified => {
          assert.deepEqual(Object.keys(verified).sort(), ['apply', 'artifact', 'feedBytes']);
          assert.equal('packagePath' in verified, false);
          return verified.apply();
        },
      }), 'applied');
      assert.equal(installs, 1);
      assert.equal(counted.count(), 1);
      await assert.rejects(access(join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('fails automatic apply closed when no held-capability platform adapter exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
    const cacheDirectory = join(directory, 'cache');
    const counted = countingFetcher(signed());
    try {
      const options = makeOptions(cacheDirectory, counted.request);
      await checkForSignedUpdates(options);
      await assert.rejects(
        applySignedUpdate({
          ...options,
          installVerifiedArtifact: async () => assert.fail('an unavailable platform adapter must not receive a path'),
        }),
        /Automatic update apply is unavailable/,
      );
      assert.equal(counted.count(), 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('expiry and corruption each cause exactly one safe artifact redownload', async t => {
    for (const scenario of ['expired', 'corrupt'] as const) {
      await t.test(scenario, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        let now = 10_000;
        try {
          const options = makeOptions(cacheDirectory, counted.request, { now: () => now });
          await checkForSignedUpdates(options);
          if (scenario === 'expired') now += SIGNED_UPDATE_CACHE_POLICY.expiryMs + 1;
          else await writeFile(
            join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName, SIGNED_UPDATE_CACHE_POLICY.artifactName),
            Buffer.alloc(artifact.length, 0x41),
          );
          await applySignedUpdate({
            ...options,
            applyHeldArtifact: async source => assert.deepEqual(await source.read(0, artifact.length), artifact),
            installVerifiedArtifact: verified => verified.apply(),
          });
          assert.equal(counted.count(), 2);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('origin, channel, and version cache-key mismatches each force one redownload', async t => {
    for (const field of ['origin', 'channel', 'version'] as const) {
      await t.test(field, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        try {
          const options = makeOptions(cacheDirectory, counted.request);
          await checkForSignedUpdates(options);
          const metadataPath = join(
            cacheDirectory,
            SIGNED_UPDATE_CACHE_POLICY.entryName,
            SIGNED_UPDATE_CACHE_POLICY.metadataName,
          );
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
          metadata.key[field] = field === 'origin' ? 'https://other.example.test' : field === 'channel' ? 'beta' : '9.9.9';
          await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
          await applySignedUpdate({
            ...options,
            applyHeldArtifact: async source => assert.deepEqual(await source.read(0, artifact.length), artifact),
            installVerifiedArtifact: verified => verified.apply(),
          });
          assert.equal(counted.count(), 2);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('rejects symlink, hardlink, permission-broad, partial, and ABA-swapped entries', async t => {
    for (const scenario of ['symlink', 'hardlink', 'permissions', 'partial', 'aba'] as const) {
      await t.test(scenario, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        let attack = false;
        const signer = async (packagePath: string) => {
          if (attack) {
            attack = false;
            const held = `${packagePath}.held`;
            await rename(packagePath, held);
            await writeFile(packagePath, Buffer.alloc(artifact.length, 0x42), { mode: 0o600 });
            await rm(packagePath);
            await rename(held, packagePath);
          }
          return windowsSigner();
        };
        try {
          const options = makeOptions(cacheDirectory, counted.request, { verifyNativeSigner: signer });
          if (scenario === 'partial') {
            if (process.platform === 'win32') await ensureWindowsPrivateDirectory(cacheDirectory);
            await mkdir(join(cacheDirectory, '.partial-crash'), { recursive: true, mode: 0o700 });
            await writeFile(join(cacheDirectory, '.partial-crash', 'artifact'), 'partial');
          }
          await checkForSignedUpdates(options);
          const artifactPath = join(
            cacheDirectory,
            SIGNED_UPDATE_CACHE_POLICY.entryName,
            SIGNED_UPDATE_CACHE_POLICY.artifactName,
          );
          if (scenario === 'symlink') {
            const decoy = join(directory, 'decoy');
            await writeFile(decoy, artifact);
            await rm(artifactPath);
            await symlink(decoy, artifactPath);
          } else if (scenario === 'hardlink') {
            await link(artifactPath, join(directory, 'hardlink'));
          } else if (scenario === 'permissions') {
            if (process.platform === 'win32') {
              await execFileAsync('icacls.exe', [artifactPath, '/grant', '*S-1-5-32-545:M']);
            } else await chmod(artifactPath, 0o644);
          } else if (scenario === 'aba') {
            attack = true;
          }
          await applySignedUpdate({
            ...options,
            applyHeldArtifact: async source => assert.deepEqual(await source.read(0, artifact.length), artifact),
            installVerifiedArtifact: verified => verified.apply(),
          });
          assert.equal(counted.count(), scenario === 'partial' ? 1 : 2);
          await assert.rejects(access(join(cacheDirectory, '.partial-crash')));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('serializes concurrent checks and retains only the single bounded artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
    const cacheDirectory = join(directory, 'cache');
    const counted = countingFetcher(signed());
    try {
      const options = makeOptions(cacheDirectory, counted.request);
      assert.deepEqual(await Promise.all([
        checkForSignedUpdates(options),
        checkForSignedUpdates(options),
        checkForSignedUpdates(options),
      ]), ['available', 'available', 'available']);
      assert.equal(counted.count(), 1);
      assert.deepEqual(
        (await readFile(join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName, SIGNED_UPDATE_CACHE_POLICY.artifactName))),
        artifact,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('enforces the whole-cache one-entry and byte quota during concurrent cleanup', async t => {
    for (const scenario of [
      'unknown',
      'many-small',
      'over-limit',
      'long-name-total',
      'oversized',
      'nested',
      'deep-nesting',
      'symlink-loop',
      'case-collision',
    ] as const) {
      await t.test(scenario, async context => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-quota-test-'));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        try {
          const options = makeOptions(cacheDirectory, counted.request);
          await checkForSignedUpdates(options);
          const entry = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
          if (scenario === 'unknown') {
            await writeFile(join(cacheDirectory, 'unknown'), 'x');
          } else if (scenario === 'many-small') {
            await Promise.all(Array.from({ length: 32 }, (_, index) =>
              writeFile(join(cacheDirectory, `unknown-${index}`), 'x')));
          } else if (scenario === 'over-limit') {
            await Promise.all(Array.from({ length: SIGNED_UPDATE_CACHE_POLICY.inspectionEntryCap + 8 }, (_, index) =>
              writeFile(join(cacheDirectory, `overflow-${index}`), 'x')));
          } else if (scenario === 'long-name-total') {
            await Promise.all(Array.from({ length: 60 }, (_, index) =>
              writeFile(join(cacheDirectory, `${index}-${'n'.repeat(230)}`), 'x')));
          } else if (scenario === 'oversized') {
            await truncate(
              join(entry, SIGNED_UPDATE_CACHE_POLICY.artifactName),
              SIGNED_UPDATE_CACHE_POLICY.namespaceBytes + 1,
            );
          } else if (scenario === 'nested') {
            await mkdir(join(entry, 'nested'));
            await writeFile(join(entry, 'nested', 'unknown'), 'x');
          } else if (scenario === 'deep-nesting') {
            let nested = join(entry, 'nested');
            for (let depth = 0; depth < SIGNED_UPDATE_CACHE_POLICY.inspectionDepth + 8; depth += 1) {
              await mkdir(nested, { recursive: true });
              nested = join(nested, 'deeper');
            }
          } else if (scenario === 'symlink-loop') {
            const nested = join(entry, 'nested');
            await mkdir(nested);
            await symlink(nested, join(nested, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
          } else {
            const collision = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName.toUpperCase());
            try {
              await mkdir(collision);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                context.skip('filesystem does not permit distinct case-colliding names');
                return;
              }
              throw error;
            }
          }
          assert.deepEqual(await Promise.all([
            checkForSignedUpdates(options),
            checkForSignedUpdates(options),
          ]), ['available', 'available']);
          assert.equal(await checkForSignedUpdates(options), 'available', 'restart must reuse only the fresh namespace');
          assert.equal(counted.count(), 2);
          assert.deepEqual(await readdir(cacheDirectory), [SIGNED_UPDATE_CACHE_POLICY.entryName]);
          assert.deepEqual((await readdir(entry)).sort(), [
            SIGNED_UPDATE_CACHE_POLICY.artifactName,
            SIGNED_UPDATE_CACHE_POLICY.metadataName,
          ].sort());
          assert.equal(SIGNED_UPDATE_CACHE_POLICY.inspectionEntryCap, 64);
          assert.equal(SIGNED_UPDATE_CACHE_POLICY.inspectionDepth, 3);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('bounded quarantine collector persists progress, refuses backlog growth, and eventually completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-quarantine-restart-'));
    const cacheDirectory = join(directory, 'cache');
    const quarantineRoot = join(directory, '.cache.quarantine');
    try {
      if (process.platform === 'win32') await ensureWindowsPrivateDirectory(cacheDirectory);
      else await mkdir(cacheDirectory, { mode: 0o700 });
      await Promise.all(Array.from({ length: 400 }, (_, index) =>
        writeFile(join(cacheDirectory, `attacker-${String(index).padStart(3, '0')}`), 'x')));
      await quarantineUpdateCacheNamespaceForTest(cacheDirectory);

      await writeFile(join(cacheDirectory, 'next-invalid'), 'x');
      await assert.rejects(
        quarantineUpdateCacheNamespaceForTest(cacheDirectory),
        /quarantine backlog exceeds the global bound/,
        'an incomplete fixed-slot backlog must prevent accumulation',
      );

      let previousNames = -1;
      let passes = 0;
      while (passes < 12) {
        const state = await collectUpdateCacheQuarantinesForTest(cacheDirectory);
        passes += 1;
        if (state.records.length === 0) break;
        const names = state.records.reduce((total, record) => total + record.names, 0);
        if (previousNames >= 0) {
          assert.ok(names - previousNames <= SIGNED_UPDATE_CACHE_POLICY.cleanupEntryCap);
        }
        previousNames = names;
      }
      assert.ok(passes > 1, 'oversized attacker trees must require bounded restart passes');
      assert.deepEqual((await collectUpdateCacheQuarantinesForTest(cacheDirectory)).records, []);
      assert.deepEqual(await readdir(quarantineRoot), ['collector.json']);

      // Once the bounded backlog is gone a later invalid namespace can rotate
      // through the same fixed slots and complete without adjacent accumulation.
      await quarantineUpdateCacheNamespaceForTest(cacheDirectory);
      assert.deepEqual((await collectUpdateCacheQuarantinesForTest(cacheDirectory)).records, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('quarantine cleanup unlinks loops and resumes after a permission failure', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-quarantine-hostile-'));
    const cacheDirectory = join(directory, 'cache');
    const external = join(directory, 'external');
    try {
      if (process.platform === 'win32') await ensureWindowsPrivateDirectory(cacheDirectory);
      else await mkdir(cacheDirectory, { mode: 0o700 });
      await mkdir(external);
      await writeFile(join(external, 'preserved'), 'outside');
      await symlink(external, join(cacheDirectory, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
      await quarantineUpdateCacheNamespaceForTest(cacheDirectory);
      assert.equal(await readFile(join(external, 'preserved'), 'utf8'), 'outside');
      assert.deepEqual((await collectUpdateCacheQuarantinesForTest(cacheDirectory)).records, []);

      await t.test('permission failure resumes', { skip: process.platform === 'win32' }, async () => {
        const blocked = join(cacheDirectory, 'blocked');
        await mkdir(blocked, { mode: 0o700 });
        await writeFile(join(blocked, 'entry'), 'x');
        await chmod(blocked, 0o000);
        await quarantineUpdateCacheNamespaceForTest(cacheDirectory);
        let state = await collectUpdateCacheQuarantinesForTest(cacheDirectory);
        assert.equal(state.records.length, 1);
        assert.equal(state.records[0].saturated, true);
        await chmod(join(directory, '.cache.quarantine', `slot-${state.records[0].slot}`, 'blocked'), 0o700);
        state = await collectUpdateCacheQuarantinesForTest(cacheDirectory);
        assert.deepEqual(state.records, []);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('never consumes attacker B across post-verify swap/delete/link/reparse/ABA barriers', async t => {
    for (const scenario of ['swap', 'delete', 'hardlink', 'symlink', 'aba'] as const) {
      await t.test(scenario, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'propr-update-handoff-test-'));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        const consumed: Buffer[] = [];
        let attackBlocked = false;
        try {
          const options = makeOptions(cacheDirectory, counted.request);
          await checkForSignedUpdates(options);
          const artifactPath = join(
            cacheDirectory,
            SIGNED_UPDATE_CACHE_POLICY.entryName,
            SIGNED_UPDATE_CACHE_POLICY.artifactName,
          );
          const displaced = join(directory, 'held-A');
          const attacker = join(directory, 'attacker-B');
          await writeFile(attacker, Buffer.alloc(artifact.length, 0x42), { mode: 0o600 });
          const mutate = async (): Promise<void> => {
            try {
              if (scenario === 'delete') await rm(artifactPath);
              else if (scenario === 'hardlink') await link(artifactPath, join(directory, 'extra-link'));
              else {
                await rename(artifactPath, displaced);
                if (scenario === 'symlink') await symlink(attacker, artifactPath);
                else await writeFile(artifactPath, Buffer.alloc(artifact.length, 0x42), { mode: 0o600 });
              }
            } catch { attackBlocked = true; }
          };
          const applying = applySignedUpdate({
            ...options,
            applyHeldArtifact: async source => {
              const split = Math.floor(artifact.length / 2);
              const first = await source.read(0, split);
              if (scenario === 'aba') {
                await mutate();
                if (!attackBlocked) {
                  await rm(artifactPath);
                  await rename(displaced, artifactPath);
                }
              }
              const second = await source.read(split, artifact.length - split);
              consumed.push(Buffer.concat([first, second]));
            },
            installVerifiedArtifact: async verified => {
              if (scenario !== 'aba') await mutate();
              await verified.apply();
            },
          });
          if (attackBlocked) assert.equal(await applying, 'applied');
          else await assert.rejects(applying);
          assert.deepEqual(consumed, [artifact]);
          assert.equal(counted.count(), 1);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('native Windows rejects deterministic pre-CreateFileW swap, deletion, reparse, and hardlink acquisition', {
    skip: process.platform !== 'win32',
  }, async t => {
    for (const scenario of ['swap-aba', 'delete', 'reparse', 'hardlink'] as const) {
      await t.test(scenario, async () => {
        const directory = await mkdtemp(join(tmpdir(), `propr-update-acquire-${scenario}-`));
        const cacheDirectory = join(directory, 'cache');
        const counted = countingFetcher(signed());
        let hookCount = 0;
        let restoreCount = 0;
        let signerCalls = 0;
        let installerCalls = 0;
        let heldReadCalls = 0;
        const displaced = join(directory, 'capability-A');
        const attacker = join(directory, 'attacker-B');
        const extraLink = join(directory, 'extra-link');
        const reparseTarget = join(directory, 'reparse-target');
        try {
          const options = makeOptions(cacheDirectory, counted.request);
          await checkForSignedUpdates(options);
          const artifactPath = join(
            cacheDirectory,
            SIGNED_UPDATE_CACHE_POLICY.entryName,
            SIGNED_UPDATE_CACHE_POLICY.artifactName,
          );
          await writeFile(attacker, Buffer.alloc(artifact.length, 0x42), { mode: 0o600 });
          await protectWindowsPrivateFile(attacker);
          await mkdir(reparseTarget);
          await assert.rejects(applySignedUpdate({
            ...options,
            verifyNativeSigner: async () => {
              signerCalls += 1;
              return windowsSigner();
            },
            beforeWindowsArtifactOpenForTest: async acquiredPath => {
              hookCount += 1;
              assert.equal(acquiredPath, artifactPath);
              if (scenario === 'hardlink') await link(artifactPath, extraLink);
              else {
                await rename(artifactPath, displaced);
                if (scenario === 'swap-aba') await rename(attacker, artifactPath);
                else if (scenario === 'reparse') {
                  await symlink(reparseTarget, artifactPath, 'junction');
                  assert.equal(
                    (await lstat(artifactPath)).isSymbolicLink(),
                    true,
                    'fixture must create a real junction reparse point',
                  );
                }
              }
            },
            ...(scenario === 'swap-aba' ? {
              afterWindowsArtifactMismatchForTest: async (acquiredPath: string, acquired: {
                size: string;
                sha256: string;
              }) => {
                assert.equal(acquiredPath, artifactPath);
                assert.equal(acquired.size, String(artifact.length));
                assert.equal(acquired.sha256, createHash('sha256').update(Buffer.alloc(artifact.length, 0x42)).digest('hex'));
                await rename(artifactPath, attacker);
                await rename(displaced, artifactPath);
                assert.deepEqual(await readFile(artifactPath), artifact, 'A must be restored before caller rejection');
                restoreCount += 1;
              },
            } : {}),
            applyHeldArtifact: async source => {
              heldReadCalls += 1;
              await source.read(0, artifact.length);
            },
            installVerifiedArtifact: async verified => {
              installerCalls += 1;
              await verified.apply();
            },
          }));
          assert.equal(hookCount, 1, 'the pre-CreateFileW hook must fire exactly once');
          assert.equal(restoreCount, scenario === 'swap-aba' ? 1 : 0);
          assert.equal(signerCalls, 0, 'native signer inspection must not see attacker bytes');
          assert.equal(installerCalls, 0, 'installer handoff must not receive attacker bytes');
          assert.equal(heldReadCalls, 0, 'the held-byte adapter must not read attacker bytes');

          if (scenario === 'hardlink') await rm(extraLink, { force: true });
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });

  test('cancellation removes private partials before a later safe retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-cache-test-'));
    const cacheDirectory = join(directory, 'cache');
    const release = signed();
    const good = fetcher(release.payload, release.signature);
    let cancelArtifact = true;
    let artifactRequests = 0;
    const request: SignedUpdateRequest = async (url, init) => {
      if (url === artifactUrl) {
        artifactRequests += 1;
        if (cancelArtifact) throw new DOMException('cancelled', 'AbortError');
      }
      return good(url, init);
    };
    try {
      const options = makeOptions(cacheDirectory, request);
      await assert.rejects(checkForSignedUpdates(options), /cancelled/);
      assert.deepEqual(await readdir(cacheDirectory), []);
      cancelArtifact = false;
      assert.equal(await checkForSignedUpdates(options), 'available');
      assert.equal(artifactRequests, 2);
      assert.deepEqual(await readdir(cacheDirectory), [SIGNED_UPDATE_CACHE_POLICY.entryName]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
