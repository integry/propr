import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  finalizeArtifacts,
  parseSquirrelReleases,
  signReleaseMetadata,
  stageArtifacts,
  validateSquirrelReleases,
} from './release-artifacts.mjs';
import { inspectArtifactArchitecture, inspectExecutableBytes } from './release-architecture.mjs';

const kinds = {
  'linux-x64': ['deb', 'rpm', 'zip'],
  'linux-arm64': ['deb', 'rpm', 'zip'],
  'darwin-x64': ['dmg', 'zip'],
  'darwin-arm64': ['dmg', 'zip'],
  'win32-x64': ['setup', 'nupkg', 'releases'],
  'win32-arm64': ['setup', 'nupkg', 'releases'],
};

const sourceName = kind => kind === 'setup' ? 'Desktop Setup.exe' : kind === 'nupkg' ? 'desktop-1.2.3-full.nupkg' : kind === 'releases' ? 'RELEASES' : `desktop.${kind}`;
const certificateSha256 = '1'.repeat(64);
const spkiSha256 = '2'.repeat(64);
const windowsSignerPins = `certificate-sha256:${certificateSha256},spki-sha256:${spkiSha256}`;

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
        PROPR_DESKTOP_ACTUAL_WINDOWS_CERTIFICATE_SHA256: certificateSha256,
        PROPR_DESKTOP_ACTUAL_WINDOWS_SPKI_SHA256: spkiSha256,
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
        ? `${createHash('sha1').update(nupkgContents).digest('hex')} desktop-1.2.3-full.nupkg ${Buffer.byteLength(nupkgContents)}\n`
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
  PROPR_DESKTOP_WINDOWS_SIGNER_PINS: windowsSignerPins,
  PROPR_DESKTOP_DARWIN_X64_FEED_URL: 'https://updates.example.test/darwin/x64/RELEASES.json',
  PROPR_DESKTOP_DARWIN_ARM64_FEED_URL: 'https://updates.example.test/darwin/arm64/RELEASES.json',
  PROPR_DESKTOP_WINDOWS_X64_FEED_URL: 'https://updates.example.test/win32/x64/',
  PROPR_DESKTOP_WINDOWS_ARM64_FEED_URL: 'https://updates.example.test/win32/arm64/',
});

const peFixture = machine => {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
};

const machOFixture = cpuType => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const storedZip = entries => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, contents, unixMode = 0] of entries) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((unixMode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

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

  test('parses every exact Squirrel RELEASES record and verifies SHA-1 and decimal size', () => {
    const bytes = Buffer.from('exact nupkg bytes');
    const fileName = 'ProPR-Desktop-1.2.3-windows-x64-full.nupkg';
    const hash = createHash('sha1').update(bytes).digest('hex');
    for (const ending of ['\n', '\r\n']) {
      const releases = Buffer.from(`${hash} ${fileName} ${bytes.length}${ending}`);
      assert.deepEqual(validateSquirrelReleases(releases, [{ fileName, bytes }]).records, [
        { sha1: hash, fileName, size: bytes.length },
      ]);
    }
    assert.equal(parseSquirrelReleases(Buffer.from(`${hash.toUpperCase()} ${fileName} ${bytes.length}`)).records[0].sha1, hash);
  });

  test('rejects wrong Squirrel hash, size, duplicate, extra, missing, path, case, delta, and malformed lines', () => {
    const bytes = Buffer.from('exact nupkg bytes');
    const fileName = 'ProPR-Desktop-1.2.3-windows-x64-full.nupkg';
    const hash = createHash('sha1').update(bytes).digest('hex');
    const record = `${hash} ${fileName} ${bytes.length}`;
    const invalid = [
      `${'0'.repeat(40)} ${fileName} ${bytes.length}`,
      `${hash} ${fileName} ${bytes.length + 1}`,
      `${record}\n${record}`,
      `${record}\n${hash} foreign-full.nupkg ${bytes.length}`,
      '',
      `${hash} path/${fileName} ${bytes.length}`,
      `${hash} ${fileName.toUpperCase()} ${bytes.length}`,
      `${hash} ProPR-Desktop-1.2.3-windows-x64-delta.nupkg ${bytes.length}`,
      `${record}\n\n`,
      `${hash}  ${fileName} ${bytes.length}`,
    ];
    for (const contents of invalid) {
      assert.throws(
        () => validateSquirrelReleases(Buffer.from(contents), [{ fileName, bytes }]),
        /Squirrel RELEASES|Invalid Squirrel|does not contain|SHA-1 mismatch|size mismatch/,
      );
    }
  });

  test('revalidates exact Squirrel package bytes during staging and aggregate finalization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-squirrel-binding-'));
    const makeDirectory = join(root, 'make');
    await mkdir(makeDirectory, { recursive: true });
    await writeFile(join(makeDirectory, 'Desktop Setup.exe'), 'win32-x64-setup');
    await writeFile(join(makeDirectory, 'desktop-1.2.3-full.nupkg'), 'win32-x64-nupkg');
    await writeFile(
      join(makeDirectory, 'RELEASES'),
      `${'0'.repeat(40)} desktop-1.2.3-full.nupkg ${Buffer.byteLength('win32-x64-nupkg')}\n`,
    );
    await assert.rejects(
      stageArtifacts({
        makeDirectory,
        outputDirectory: join(root, 'stage'),
        platform: 'win32',
        arch: 'x64',
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /SHA-1 mismatch/,
    );

    const fragments = await createFragments(root);
    const releasesPath = join(fragments, 'win32-x64', 'ProPR-Desktop-1.2.3-windows-x64-RELEASES');
    const valid = await readFile(releasesPath, 'utf8');
    const tamperedReleases = valid.replace(/^[a-f0-9]{40}/, 'f'.repeat(40));
    await writeFile(releasesPath, tamperedReleases);
    const fragmentPath = join(fragments, 'win32-x64', 'release-fragment.json');
    const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
    const releasesArtifact = fragment.artifacts.find(artifact => artifact.kind === 'releases');
    releasesArtifact.size = Buffer.byteLength(tamperedReleases);
    releasesArtifact.sha256 = createHash('sha256').update(tamperedReleases).digest('hex');
    await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'final'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /invalid Squirrel RELEASES metadata.*SHA-1 mismatch/,
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
    assert.equal(manifest.feeds['win32-x64'].signer.certificateSha256, certificateSha256);
    assert.equal(manifest.feeds['win32-x64'].signer.spkiSha256, spkiSha256);
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

    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: signedUnsigned,
        outputDirectory: join(root, 'same-subject-different-key'),
        version: '1.2.3',
        env: {
          ...signingEnvironment(generateKeyPairSync('ed25519')),
          PROPR_DESKTOP_WINDOWS_SIGNER_PINS: `certificate-sha256:${'3'.repeat(64)}`,
        },
      }),
      /Actual native signer mismatch for win32-x64/,
    );
    await assert.rejects(
      signReleaseMetadata({
        inputDirectory: signedUnsigned,
        outputDirectory: join(root, 'malformed-pin'),
        version: '1.2.3',
        env: {
          ...signingEnvironment(generateKeyPairSync('ed25519')),
          PROPR_DESKTOP_WINDOWS_SIGNER_PINS: `certificate-sha256:${'A'.repeat(64)}`,
        },
      }),
      /canonical SHA-256 fingerprint allowlist/,
    );
  });

  test('rejects mixed Windows signers and tampered fingerprint evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-mixed-signers-'));
    const fragments = await createFragments(root, { signed: true });
    const fragmentPath = join(fragments, 'win32-arm64', 'release-fragment.json');
    const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
    fragment.nativeSigner.certificateSha256 = '3'.repeat(64);
    await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'final'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /mixed native signer evidence/,
    );

    fragment.nativeSigner.certificateSha256 = 'not-a-sha256';
    await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'tampered'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /Native signer evidence is incomplete or invalid/,
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
    assert.deepEqual(inspectExecutableBytes(pe(0x014c)), { format: 'pe', architectures: ['x86'] });
    assert.deepEqual(inspectExecutableBytes(machO(0x01000007)), { format: 'mach-o', architectures: ['x64'] });
    assert.deepEqual(inspectExecutableBytes(machO(0x0100000c)), { format: 'mach-o', architectures: ['arm64'] });
  });

  test('derives Windows target architecture from the full NUPKG independently of its supported bootstrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-squirrel-arch-'));
    const setup = join(root, 'Setup.exe');
    const arm64Package = join(root, 'desktop-arm64-full.nupkg');
    await writeFile(setup, peFixture(0x014c));
    await writeFile(arm64Package, storedZip([
      ['lib/net45/propr-desktop.exe', peFixture(0xaa64)],
    ]));

    assert.deepEqual(
      await inspectArtifactArchitecture({ path: setup, kind: 'setup', platform: 'win32', arch: 'arm64' }),
      { format: 'squirrel-setup', executable: { format: 'pe', architectures: ['x86'] } },
    );
    assert.deepEqual(
      await inspectArtifactArchitecture({ path: arm64Package, kind: 'nupkg', platform: 'win32', arch: 'arm64' }),
      { format: 'nupkg', executable: { format: 'pe', architectures: ['arm64'] } },
    );

    await assert.rejects(
      inspectArtifactArchitecture({ path: arm64Package, kind: 'nupkg', platform: 'win32', arch: 'x64' }),
      /executable architecture mismatch.*pe\/x64.*pe\/arm64/,
    );
    await writeFile(arm64Package, storedZip([
      ['lib/net45/propr-desktop.exe', Buffer.from('tampered payload')],
    ]));
    await assert.rejects(
      inspectArtifactArchitecture({ path: arm64Package, kind: 'nupkg', platform: 'win32', arch: 'arm64' }),
      /not a recognized.*binary/,
    );
    await writeFile(setup, peFixture(0x01c0));
    await assert.rejects(
      inspectArtifactArchitecture({ path: setup, kind: 'setup', platform: 'win32', arch: 'arm64' }),
      /not a supported x86, x64, or arm64 Squirrel PE bootstrapper/,
    );
  });

  test('binds ZIP and NUPKG executables to exact maker-specific canonical paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-canonical-archives-'));
    const fixtures = [
      ['linux.zip', 'zip', 'linux', 'x64', 'propr-desktop-linux-x64/propr-desktop', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, ...Array(12).fill(0), 62, 0])],
      ['darwin.zip', 'zip', 'darwin', 'arm64', 'propr-desktop.app/Contents/MacOS/propr-desktop', machOFixture(0x0100000c)],
      ['windows.nupkg', 'nupkg', 'win32', 'x64', 'lib/net45/propr-desktop.exe', peFixture(0x8664)],
    ];
    for (const [name, kind, platform, arch, executablePath, bytes] of fixtures) {
      const path = join(root, name);
      await writeFile(path, storedZip([[executablePath, bytes]]));
      const result = await inspectArtifactArchitecture({ path, kind, platform, arch });
      assert.equal(result.executable.architectures[0], arch);
    }
  });

  test('accepts only the real Forge macOS framework-internal symbolic-link layout', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-darwin-framework-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'darwin.zip');
    const framework = 'propr-desktop.app/Contents/Frameworks/Electron Framework.framework';
    const symlink = (name, target) => [`${framework}/${name}`, Buffer.from(target), 0xa1ff];
    await writeFile(path, storedZip([
      ['propr-desktop.app/Contents/MacOS/propr-desktop', machOFixture(0x0100000c)],
      [`${framework}/Versions/A/Electron Framework`, machOFixture(0x0100000c)],
      [`${framework}/Versions/A/Resources/Info.plist`, Buffer.from('resources')],
      [`${framework}/Versions/A/Libraries/libEGL.dylib`, Buffer.from('library')],
      [`${framework}/Versions/A/Helpers/chrome_crashpad_handler`, Buffer.from('helper')],
      symlink('Versions/Current', 'A'),
      symlink('Electron Framework', 'Versions/Current/Electron Framework'),
      symlink('Resources', 'Versions/Current/Resources'),
      symlink('Libraries', 'Versions/Current/Libraries'),
      symlink('Helpers', 'Versions/Current/Helpers'),
    ]));

    assert.deepEqual(
      await inspectArtifactArchitecture({ path, kind: 'zip', platform: 'darwin', arch: 'arm64' }),
      { format: 'zip', executable: { format: 'mach-o', architectures: ['arm64'] } },
    );
  });

  test('rejects hostile macOS ZIP symbolic links before trusting their payloads', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-hostile-darwin-links-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const executablePath = 'propr-desktop.app/Contents/MacOS/propr-desktop';
    const framework = 'propr-desktop.app/Contents/Frameworks/Electron Framework.framework';
    const executable = [executablePath, machOFixture(0x0100000c)];
    const target = [`${framework}/Versions/A/Resources/Info.plist`, Buffer.from('resource')];
    const link = (name, contents) => [`${framework}/${name}`, Buffer.isBuffer(contents) ? contents : Buffer.from(contents), 0xa1ff];
    const cases = [
      ['absolute', [executable, target, link('Resources', '/Applications')], /unsafe relative target/],
      ['escaping', [executable, target, link('Resources', '../../../../MacOS')], /unsafe relative target/],
      ['chained-escape', [
        executable,
        target,
        link('Resources', 'Versions/Current/Resources'),
        link('Versions/Current', '../../../../../outside'),
      ], /unsafe relative target/],
      ['cycle', [executable, target, link('Resources', 'Libraries'), link('Libraries', 'Resources')], /contains a cycle/],
      ['oversized', [executable, target, link('Resources', Buffer.alloc(1025, 0x61))], /oversized payload/],
      ['malformed-utf8', [executable, target, link('Resources', Buffer.from([0xc3, 0x28]))], /cannot be decoded strictly/],
      ['duplicate', [executable, target, link('Resources', 'Versions/A/Resources'), link('Resources', 'Versions/A/Resources')], /duplicate or case-colliding/],
      ['missing', [executable, target, link('Resources', 'Versions/B/Resources')], /missing target/],
      ['case-mismatched-target', [executable, target, link('Resources', 'Versions/a/Resources')], /missing target/],
      ['canonical-executable', [
        [executablePath, Buffer.from('../Frameworks/Electron Framework.framework/Electron Framework'), 0xa1ff],
        target,
      ], /symbolic link outside canonical macOS framework internals/],
      ['helper-executable', [
        executable,
        target,
        ['propr-desktop.app/Contents/Frameworks/propr-desktop Helper.app/Contents/MacOS/propr-desktop Helper', Buffer.from('target'), 0xa1ff],
      ], /symbolic link outside canonical macOS framework internals/],
      ['nested-helper-executable', [
        executable,
        target,
        [`${framework}/Helpers/propr-desktop Helper`, Buffer.from('Versions/A/Resources'), 0xa1ff],
      ], /symbolic link outside canonical macOS framework internals/],
      ['alternate-root', [executable, target, ['Other.app/Contents/Frameworks/Other.framework/Current', Buffer.from('A'), 0xa1ff]], /symbolic link outside canonical macOS framework internals/],
      ['special-file', [executable, target, [`${framework}/special`, Buffer.from('special'), 0x11ff]], /symbolic link or special file/],
    ];
    for (const [name, entries, pattern] of cases) {
      const path = join(root, `${name}.zip`);
      await writeFile(path, storedZip(entries));
      await assert.rejects(
        inspectArtifactArchitecture({ path, kind: 'zip', platform: 'darwin', arch: 'arm64' }),
        pattern,
        name,
      );
    }

    const crcPath = join(root, 'link-crc.zip');
    const linkName = `${framework}/Resources`;
    const crcBytes = storedZip([executable, target, link('Resources', 'Versions/A/Resources')]);
    const localLinkRecord = crcBytes.indexOf(Buffer.from(`${linkName}Versions/A/Resources`));
    assert.notEqual(localLinkRecord, -1);
    const payloadOffset = localLinkRecord + Buffer.byteLength(linkName);
    crcBytes[payloadOffset] ^= 1;
    await writeFile(crcPath, crcBytes);
    await assert.rejects(
      inspectArtifactArchitecture({ path: crcPath, kind: 'zip', platform: 'darwin', arch: 'arm64' }),
      /size or CRC is invalid/,
    );
  });

  test('rejects unsafe, duplicate, shadowed, forged, alternate, and noncanonical archive layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-malicious-archives-'));
    const executable = peFixture(0x8664);
    const cases = [
      ['traversal', storedZip([['../lib/net45/propr-desktop.exe', executable]]), /non-normalized|unsafe name/],
      ['duplicate', storedZip([['lib/net45/propr-desktop.exe', executable], ['lib/net45/propr-desktop.exe', executable]]), /duplicate or case-colliding/],
      ['case', storedZip([['lib/net45/propr-desktop.exe', executable], ['LIB/NET45/PROPR-DESKTOP.EXE', executable]]), /case-colliding/],
      ['shadow', storedZip([['lib', Buffer.from('file')], ['lib/net45/propr-desktop.exe', executable]]), /conflicting file and directory prefix/],
      ['alternate', storedZip([['lib/net45/propr-desktop.exe', executable], ['tools/propr-desktop.exe', executable]]), /executable outside/],
      ['wrong-path', storedZip([['lib/net46/propr-desktop.exe', executable]]), /executable outside|missing canonical/],
    ];
    const valid = storedZip([['lib/net45/propr-desktop.exe', executable]]);
    const forged = Buffer.from(valid);
    const localNameOffset = 30;
    Buffer.from('lib/net46/propr-desktop.exe').copy(forged, localNameOffset);
    cases.push(['forged-local-header', forged, /central and local entry metadata disagree/]);
    cases.push(['trailing-ambiguity', Buffer.concat([valid, Buffer.from('trailing')]), /end-of-central-directory.*ambiguous/]);
    for (const [name, bytes, pattern] of cases) {
      const path = join(root, `${name}.nupkg`);
      await writeFile(path, bytes);
      await assert.rejects(
        inspectArtifactArchitecture({ path, kind: 'nupkg', platform: 'win32', arch: 'x64' }),
        pattern,
      );
    }
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
