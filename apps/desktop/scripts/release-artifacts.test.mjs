import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { finalizeArtifacts, signReleaseMetadata, stageArtifacts } from './release-artifacts.mjs';
import { inspectExecutableBytes } from './release-architecture.mjs';

const kinds = {
  'linux-x64': ['deb', 'rpm', 'zip'],
  'linux-arm64': ['deb', 'rpm', 'zip'],
  'darwin-x64': ['dmg', 'zip'],
  'darwin-arm64': ['dmg', 'zip'],
  'win32-x64': ['setup', 'nupkg', 'releases'],
  'win32-arm64': ['setup', 'nupkg', 'releases'],
};

const sourceName = kind => kind === 'setup' ? 'Desktop Setup.exe' : kind === 'nupkg' ? 'desktop-1.2.3-full.nupkg' : kind === 'releases' ? 'RELEASES' : `desktop.${kind}`;

const architectureInspector = async ({ path, kind, platform, arch }) => {
  if (kind === 'releases') return { format: 'squirrel-releases', target: `${platform}-${arch}` };
  const contents = await readFile(path, 'utf8');
  if (!contents.includes(`${platform}-${arch}-${kind}`)) {
    throw new Error(`${kind} packaged executable architecture mismatch for ${platform}-${arch}`);
  }
  return { format: kind, executable: { platform, architectures: [arch] } };
};

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
      inspectArchitecture: architectureInspector,
    });
  }
  return fragments;
};

const signingEnvironment = keys => ({
  PROPR_DESKTOP_UPDATE_PRIVATE_KEY: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  PROPR_DESKTOP_UPDATE_PUBLIC_KEY: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  PROPR_DESKTOP_UPDATE_MANIFEST_URL: 'https://updates.example.test/stable/desktop-release.json',
  PROPR_DESKTOP_MAC_TEAM_ID: 'TEAM123456',
  PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY: 'CN=Example Publisher',
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
    const manifest = await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: output, version: '1.2.3', inspectArchitecture: architectureInspector });
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
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3', inspectArchitecture: architectureInspector });
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
    const complete = signingEnvironment(generateKeyPairSync('ed25519'));
    for (const name of Object.keys(complete)) {
      const incomplete = { ...complete };
      delete incomplete[name];
      await assert.rejects(
        signReleaseMetadata({
          inputDirectory: unsigned,
          outputDirectory: join(root, `missing-${name}`),
          version: '1.2.3',
          env: incomplete,
        }),
        new RegExp(`configuration is incomplete.*${name}`),
      );
    }
  });

  test('signs cryptographically bound feeds only in the trusted release phase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-sign-'));
    const fragments = await createFragments(root, { signed: true });
    const unsigned = join(root, 'unsigned');
    const output = join(root, 'signed');
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3', inspectArchitecture: architectureInspector });
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
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3', inspectArchitecture: architectureInspector });
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

  test('rejects unsigned production metadata and actual signer mismatches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-unsigned-production-'));
    const fragments = await createFragments(root);
    const unsigned = join(root, 'unsigned');
    await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: unsigned, version: '1.2.3', inspectArchitecture: architectureInspector });
    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: unsigned,
        outputDirectory: join(root, 'signed'),
        version: '1.2.3',
        env: signingEnvironment(generateKeyPairSync('ed25519')),
      }),
      /Actual native signer mismatch/,
    );

    const signedFragments = await createFragments(await mkdtemp(join(tmpdir(), 'propr-release-signer-mismatch-')), { signed: true });
    const signedUnsigned = join(root, 'signed-unsigned');
    await finalizeArtifacts({ inputDirectory: signedFragments, outputDirectory: signedUnsigned, version: '1.2.3', inspectArchitecture: architectureInspector });
    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: signedUnsigned,
        outputDirectory: join(root, 'mismatch'),
        version: '1.2.3',
        env: { ...signingEnvironment(generateKeyPairSync('ed25519')), PROPR_DESKTOP_WINDOWS_SIGNING_IDENTITY: 'CN=Wrong Publisher' },
      }),
      /Actual native signer mismatch for win32-x64/,
    );
  });

  test('parses x64 and arm64 ELF, PE, and Mach-O executable fixtures', () => {
    const elf = machine => {
      const bytes = Buffer.alloc(64);
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
      bytes[5] = 1;
      bytes.writeUInt16LE(machine, 18);
      return bytes;
    };
    const pe = machine => {
      const bytes = Buffer.alloc(128);
      bytes.write('MZ');
      bytes.writeUInt32LE(64, 0x3c);
      bytes.writeUInt32LE(0x00004550, 64);
      bytes.writeUInt16LE(machine, 68);
      return bytes;
    };
    const machO = cpuType => {
      const bytes = Buffer.alloc(32);
      bytes.writeUInt32LE(0xfeedfacf, 0);
      bytes.writeUInt32LE(cpuType, 4);
      return bytes;
    };
    assert.deepEqual(inspectExecutableBytes(elf(62)), { format: 'elf', architectures: ['x64'] });
    assert.deepEqual(inspectExecutableBytes(elf(183)), { format: 'elf', architectures: ['arm64'] });
    assert.deepEqual(inspectExecutableBytes(pe(0x8664)), { format: 'pe', architectures: ['x64'] });
    assert.deepEqual(inspectExecutableBytes(pe(0xaa64)), { format: 'pe', architectures: ['arm64'] });
    assert.deepEqual(inspectExecutableBytes(machO(0x01000007)), { format: 'mach-o', architectures: ['x64'] });
    assert.deepEqual(inspectExecutableBytes(machO(0x0100000c)), { format: 'mach-o', architectures: ['arm64'] });
  });

  test('rejects cross-labeled package architectures at staging and finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-wrong-arch-'));
    for (const [target, targetKinds] of Object.entries(kinds)) {
      const [platform, arch] = target.split('-');
      const oppositeArch = arch === 'x64' ? 'arm64' : 'x64';
      for (const kind of targetKinds.filter(candidate => candidate !== 'releases')) {
        const path = join(root, `${target}-${kind}`);
        await writeFile(path, `${platform}-${oppositeArch}-${kind}`);
        await assert.rejects(
          architectureInspector({ path, kind, platform, arch }),
          new RegExp(`${kind} packaged executable architecture mismatch`),
        );
      }
    }

    const makeDirectory = join(root, 'make');
    await mkdir(makeDirectory, { recursive: true });
    for (const kind of kinds['linux-x64']) {
      const contents = kind === 'releases' ? '' : `linux-arm64-${kind}`;
      await writeFile(join(makeDirectory, sourceName(kind)), contents);
    }
    await assert.rejects(
      stageArtifacts({
        makeDirectory,
        outputDirectory: join(root, 'stage'),
        platform: 'linux',
        arch: 'x64',
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /architecture mismatch/,
    );

    const fragments = await createFragments(root);
    const fragmentPath = join(fragments, 'darwin-arm64', 'release-fragment.json');
    const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
    fragment.artifacts[0].architectureEvidence.executable.architectures = ['x64'];
    await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({ inputDirectory: fragments, outputDirectory: join(root, 'final'), version: '1.2.3', inspectArchitecture: architectureInspector }),
      /architecture evidence does not match/,
    );
  });
});
