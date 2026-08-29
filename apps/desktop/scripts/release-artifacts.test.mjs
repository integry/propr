import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { finalizeArtifacts, signReleaseMetadata, stageArtifacts } from './release-artifacts.mjs';

const kinds = {
  'linux-x64': ['deb', 'rpm', 'zip'],
  'linux-arm64': ['deb', 'rpm', 'zip'],
  'darwin-x64': ['dmg', 'zip'],
  'darwin-arm64': ['dmg', 'zip'],
  'win32-x64': ['setup', 'nupkg', 'releases'],
  'win32-arm64': ['setup', 'nupkg', 'releases'],
};

const sourceName = kind => kind === 'setup' ? 'Desktop Setup.exe' : kind === 'nupkg' ? 'desktop-1.2.3-full.nupkg' : kind === 'releases' ? 'RELEASES' : `desktop.${kind}`;

const signerEnvironment = platform => platform === 'darwin'
  ? {
      PROPR_DESKTOP_ACTUAL_SIGNER_TYPE: 'apple-team-id',
      PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY: 'TEAM123456',
      PROPR_DESKTOP_ACTUAL_MAC_DESIGNATED_REQUIREMENT: 'designated => identifier "dev.propr.desktop" and anchor apple generic',
    }
  : platform === 'win32'
    ? {
        PROPR_DESKTOP_ACTUAL_SIGNER_TYPE: 'authenticode-subject',
        PROPR_DESKTOP_ACTUAL_SIGNER_IDENTITY: 'CN=Example Publisher',
      }
    : {};

const createFragments = async (root, { signed = false } = {}) => {
  const fragments = join(root, 'fragments');
  for (const [target, targetKinds] of Object.entries(kinds)) {
    const [platform, arch] = target.split('-');
    const makeDirectory = join(root, 'make', target);
    await mkdir(makeDirectory, { recursive: true });
    const nupkgContents = `${target}-nupkg`;
    for (const kind of targetKinds) {
      const contents = kind === 'releases'
        ? `0123456789abcdef0123456789abcdef01234567 desktop-1.2.3-full.nupkg ${Buffer.byteLength(nupkgContents)}\n`
        : kind === 'nupkg' ? nupkgContents : `${target}-${kind}`;
      await writeFile(join(makeDirectory, sourceName(kind)), contents);
    }
    await stageArtifacts({
      makeDirectory,
      outputDirectory: join(fragments, target),
      platform,
      arch,
      version: '1.2.3',
      env: signed ? signerEnvironment(platform) : {},
    });
  }
  return fragments;
};

const signingEnvironment = keys => ({
  PROPR_DESKTOP_UPDATE_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  PROPR_DESKTOP_UPDATE_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://updates.example.test/stable/desktop-release.json',
  PROPR_DESKTOP_DARWIN_X64_FEED_URL: 'https://updates.example.test/darwin/x64/RELEASES.json',
  PROPR_DESKTOP_DARWIN_ARM64_FEED_URL: 'https://updates.example.test/darwin/arm64/RELEASES.json',
  PROPR_DESKTOP_WINDOWS_X64_FEED_URL: 'https://updates.example.test/win32/x64/',
  PROPR_DESKTOP_WINDOWS_ARM64_FEED_URL: 'https://updates.example.test/win32/arm64/',
});

describe('desktop release artifacts', () => {
  test('stages named artifacts and finalizes unsigned validation metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-test-'));
    const fragments = await createFragments(root);
    const output = join(root, 'final');
    const manifest = await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: output, version: '1.2.3' });
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.artifacts.length, 16);
    assert.equal(manifest.tag, 'desktop-v1.2.3');
    assert.equal(Object.keys(manifest.feeds).length, 0);
    assert.equal(Object.keys(manifest.nativeSigners).length, 0);
    await assert.rejects(access(join(output, 'desktop-release.json.sig')));
    assert.match(await readFile(join(output, 'SHA256SUMS'), 'utf8'), /ProPR-Desktop-1\.2\.3-windows-x64-Setup\.exe/);
    assert.match(
      await readFile(join(output, 'ProPR-Desktop-1.2.3-windows-x64-RELEASES'), 'utf8'),
      /ProPR-Desktop-1\.2\.3-windows-x64-full\.nupkg/,
    );
  });

  test('fails closed when trusted update signing configuration is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-missing-key-'));
    const fragments = await createFragments(root, { signed: true });
    const unsigned = join(root, 'unsigned');
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3' });
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: unsigned,
        outputDirectory: join(root, 'signed'),
        version: '1.2.3',
        env: { PROPR_DESKTOP_UPDATE_PUBLIC_KEY: publicKey },
      }),
      /configuration is incomplete.*PROPR_DESKTOP_UPDATE_PRIVATE_KEY/,
    );
  });

  test('signs cryptographically bound feeds only in the trusted release phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-sign-'));
    const fragments = await createFragments(root, { signed: true });
    const unsigned = join(root, 'unsigned');
    const output = join(root, 'signed');
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3' });
    const keys = generateKeyPairSync('ed25519');
    const manifest = await signReleaseMetadata({
      inputDirectory: unsigned,
      outputDirectory: output,
      version: '1.2.3',
      env: signingEnvironment(keys),
    });

    assert.equal(manifest.manifestUrl, 'https://updates.example.test/stable/desktop-release.json');
    assert.deepEqual(Object.keys(manifest.feeds).sort(), [
      'darwin-arm64',
      'darwin-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    assert.equal(manifest.feeds['darwin-arm64'].signer.identity, 'TEAM123456');
    assert.equal(manifest.feeds['win32-x64'].signer.identity, 'CN=Example Publisher');
    assert.equal(manifest.feeds['win32-x64'].artifact.version, undefined);
    assert.equal(manifest.feeds['win32-x64'].version, '1.2.3');
    const payload = await readFile(join(output, 'desktop-release.json'));
    const signature = Buffer.from((await readFile(join(output, 'desktop-release.json.sig'), 'utf8')).trim(), 'base64');
    assert.equal(verify(null, payload, keys.publicKey, signature), true);
  });

  test('refuses to sign when artifact bytes changed after unsigned finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-tamper-'));
    const fragments = await createFragments(root, { signed: true });
    const unsigned = join(root, 'unsigned');
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3' });
    await writeFile(join(unsigned, 'ProPR-Desktop-1.2.3-windows-x64-full.nupkg'), 'tampered');
    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: unsigned,
        outputDirectory: join(root, 'signed'),
        version: '1.2.3',
        env: signingEnvironment(generateKeyPairSync('ed25519')),
      }),
      /artifact integrity is invalid/,
    );
  });
});
