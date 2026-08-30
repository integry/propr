import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { applySignedUpdate, checkForSignedUpdates, type SignedUpdateManifest } from './signed-updates';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const config = {
  manifestUrl: 'https://updates.example.test/stable/desktop-release.json',
  publicKey,
  signingIdentity: 'TEAM123456',
  windowsSignerPins: [],
};

test('Windows signed-update public boundary is fixed unsupported with zero external or apply calls', async () => {
  const calls = { request: 0, signer: 0, authority: 0, install: 0 };
  const common = {
    config: { ...config, signingIdentity: 'CN=Configured Windows Publisher' },
    currentVersion: '1.2.3',
    platform: 'win32' as const,
    arch: 'x64',
    cacheDirectory: 'configured-but-never-touched',
    request: async (): Promise<Response> => {
      calls.request += 1;
      throw new Error('Windows must not request metadata or artifacts');
    },
    verifyNativeSigner: async () => {
      calls.signer += 1;
      throw new Error('Windows must not inspect an update artifact');
    },
    applyHeldArtifact: async () => {
      calls.authority += 1;
      throw new Error('Windows must not invoke windows-update-authority');
    },
  };

  assert.equal(await checkForSignedUpdates(common), 'unsupported');
  assert.equal(await applySignedUpdate({
    ...common,
    installVerifiedArtifact: async () => { calls.install += 1; },
  }), 'unsupported');
  assert.deepEqual(calls, { request: 0, signer: 0, authority: 0, install: 0 });
});

test('macOS signed-update check remains check-only and verifies its exact feed and artifact', async () => {
  const artifact = Buffer.from('signed macOS application ZIP');
  const artifactUrl = 'https://updates.example.test/darwin/x64/ProPR-Desktop-1.2.4-macos-x64-zip';
  const feed = Buffer.from(`${JSON.stringify({ url: artifactUrl, name: '1.2.4' })}\n`);
  const bytes = (url: string, value: Buffer) => ({
    url,
    size: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
  });
  const manifest: SignedUpdateManifest = {
    schemaVersion: 2,
    channel: 'stable',
    manifestUrl: config.manifestUrl,
    windowsSignerPins: [],
    version: '1.2.4',
    tag: 'desktop-v1.2.4',
    publishedAt: '2026-08-30T00:00:00.000Z',
    feeds: {
      'darwin-x64': {
        target: 'darwin-x64',
        version: '1.2.4',
        feed: bytes('https://updates.example.test/darwin/x64/RELEASES.json', feed),
        artifact: { ...bytes(artifactUrl, artifact), fileName: 'ProPR-Desktop-1.2.4-macos-x64-zip', kind: 'zip' },
        signer: {
          type: 'apple-team-id',
          identity: 'TEAM123456',
          designatedRequirement: 'designated => identifier "dev.propr.desktop" and anchor apple generic',
        },
      },
    },
  };
  const payload = Buffer.from(`${JSON.stringify(manifest)}\n`);
  const signature = Buffer.from(sign(null, payload, keys.privateKey).toString('base64'));
  let artifactRequests = 0;
  let installs = 0;
  const response = (url: string, value: Buffer) => {
    const result = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from(value));
        controller.close();
      },
    }), { headers: { 'content-length': String(value.length) } });
    Object.defineProperty(result, 'url', { value: url });
    return result;
  };
  const result = await checkForSignedUpdates({
    config,
    currentVersion: '1.2.3',
    platform: 'darwin',
    arch: 'x64',
    request: async url => {
      if (url === config.manifestUrl) return response(url, payload);
      if (url === `${config.manifestUrl}.sig`) return response(url, signature);
      if (url === manifest.feeds['darwin-x64'].feed.url) return response(url, feed);
      if (url === artifactUrl) { artifactRequests += 1; return response(url, artifact); }
      throw new Error(`Unexpected update URL ${url}`);
    },
    verifyNativeSigner: async () => manifest.feeds['darwin-x64'].signer,
  });
  assert.equal(result, 'available');
  assert.equal(artifactRequests, 1);
  assert.equal(installs, 0);
});
