import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, link, lstat, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import {
  finalizeArtifacts,
  parseSquirrelReleases,
  signReleaseMetadata,
  stageArtifacts,
  validateSquirrelReleases,
} from './release-artifacts.mjs';
import {
  createHeldDmgArtifact,
  inspectArtifactArchitecture,
  inspectExecutableBytes,
  readHeldDmgArtifactBytes,
} from './release-architecture.mjs';

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
const execFile = promisify(execFileCallback);
const nativeDarwinArch = process.arch === 'arm64' ? 'arm64' : 'x64';

const privateDmgSnapshotPaths = async () => {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('propr-dmg-snapshot-')) continue;
    const directory = join(tmpdir(), entry.name);
    for (const name of await readdir(directory)) {
      if (name.endsWith('.dmg')) paths.push(join(directory, name));
    }
  }
  return paths;
};

const findNewPrivateDmgSnapshot = async previous => {
  const paths = (await privateDmgSnapshotPaths()).filter(path => !previous.has(path));
  assert.equal(paths.length, 1, 'inspection must create exactly one private DMG snapshot');
  return paths[0];
};

const nativeDmgValidation = arch => ({
  schemaVersion: 1,
  tool: 'propr-desktop-release-architecture',
  toolVersion: '1.0.0',
  nativePlatform: 'darwin',
  mountMethod: 'hdiutil-attach-readonly',
  layout: {
    topLevelApplication: 'propr-desktop.app',
    installLink: { path: 'Applications', type: 'symbolic-link', target: '/Applications' },
    mainExecutable: {
      path: 'propr-desktop.app/Contents/MacOS/propr-desktop',
      format: 'mach-o',
      architectures: [arch],
    },
    helperExecutables: [
      'propr-desktop Helper.app',
      'propr-desktop Helper (GPU).app',
      'propr-desktop Helper (Plugin).app',
      'propr-desktop Helper (Renderer).app',
    ].map(bundle => ({
      bundle,
      path: `propr-desktop.app/Contents/Frameworks/${bundle}/Contents/MacOS/${bundle.slice(0, -'.app'.length)}`,
      format: 'mach-o',
      architectures: [arch],
    })),
  },
});

const architectureInspector = async ({ path, heldArtifact, kind, platform, arch }) => {
  if (kind === 'releases') return { format: 'squirrel-releases', target: `${platform}-${arch}` };
  const contents = kind === 'dmg'
    ? (await readHeldDmgArtifactBytes(heldArtifact)).toString('utf8')
    : await readFile(path, 'utf8');
  if (!contents.includes(`${platform}-${arch}-${kind}`)) {
    throw new Error(`${kind} packaged executable architecture mismatch for ${platform}-${arch}`);
  }
  return {
    format: kind,
    executable: { platform, architectures: [arch] },
    ...(kind === 'dmg' ? { nativeValidation: nativeDmgValidation(arch) } : {}),
  };
};

const windowsDmgFixtureAuthority = Object.freeze({
  schemaVersion: 1,
  platform: 'win32',
  scope: 'release-test-private-dmg',
});

const stageFixtureArtifacts = arguments_ => stageArtifacts({
  ...arguments_,
  privateDmgFixtureAuthority: windowsDmgFixtureAuthority,
});

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
    await stageFixtureArtifacts({
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

const windowsAuthorityFixtureEntries = (executablePath, executable) => {
  const helper = Buffer.alloc(1024);
  helper.writeUInt16LE(0x5a4d, 0);
  helper.writeUInt32LE(0x80, 0x3c);
  helper.write('PE\0\0', 0x80, 'ascii');
  helper.writeUInt16LE(0x14c, 0x84);
  helper.writeUInt16LE(1, 0x86);
  helper.writeUInt16LE(224, 0x94);
  helper.writeUInt16LE(0x10b, 0x98);
  helper.writeUInt32LE(0x2000, 0x98 + 96 + (14 * 8));
  helper.writeUInt32LE(72, 0x98 + 96 + (14 * 8) + 4);
  helper.writeUInt32LE(0x200, 0x178 + 8);
  helper.writeUInt32LE(0x2000, 0x178 + 12);
  helper.writeUInt32LE(0x200, 0x178 + 16);
  helper.writeUInt32LE(0x200, 0x178 + 20);
  helper.writeUInt32LE(0x1, 0x210);
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    name: 'propr-windows-authority.exe',
    format: 'PE32',
    architecture: 'anycpu',
    machine: 'I386',
    clr: true,
    size: helper.length,
    sha256: createHash('sha256').update(helper).digest('hex'),
    sourceSha256: 'a'.repeat(64),
    protocol: 'propr-windows-authority-v1',
    trust: 'unsigned-validation',
    publisher: null,
    signerPins: [],
    signerCertificateSha256: null,
    signerSpkiSha256: null,
    compiler: {
      kind: 'kernel-systemroot-dotnet-framework-csc',
      framework: 'Framework64-v4.0.30319',
      inputs: [
        { name: 'csc.exe', size: 1, sha256: 'b'.repeat(64) },
        { name: 'System.dll', size: 1, sha256: 'c'.repeat(64) },
        { name: 'System.Web.Extensions.dll', size: 1, sha256: 'd'.repeat(64) },
      ],
    },
  })}\n`);
  return [
    [executablePath, executable],
    ['lib/net45/resources/windows-authority/propr-windows-authority.exe', helper],
    ['lib/net45/resources/windows-authority/propr-windows-authority.manifest.json', manifest],
  ];
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
    const checksumLines = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).trim().split('\n');
    assert.equal(checksumLines.length, 16);
    assert.ok(checksumLines.some(line => line.endsWith('ProPR-Desktop-1.2.3-windows-x64-Setup.exe')));
    for (const line of checksumLines) {
      const match = /^([a-f0-9]{64})  ([^/\\]+)$/.exec(line);
      assert.ok(match, `invalid SHA256SUMS line: ${line}`);
      assert.equal(createHash('sha256').update(await readFile(join(output, match[2]))).digest('hex'), match[1]);
    }
    assert.match(
      await readFile(join(output, 'ProPR-Desktop-1.2.3-windows-x64-RELEASES'), 'utf8'),
      /ProPR-Desktop-1\.2\.3-windows-x64-full\.nupkg/,
    );
    const dmg = manifest.artifacts.find(artifact => artifact.kind === 'dmg' && artifact.arch === 'arm64');
    assert.deepEqual(dmg.nativeDmgValidationEvidence.artifact, {
      fileName: dmg.fileName,
      size: dmg.size,
      sha256: dmg.sha256,
    });
    assert.equal(dmg.nativeDmgValidationEvidence.validatedNatively, true);
    assert.deepEqual(dmg.nativeDmgValidationEvidence.layout.installLink, {
      path: 'Applications',
      type: 'symbolic-link',
      target: '/Applications',
    });
  });

  test('rejects altered DMG bytes even when fragment artifact metadata is rewritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-altered-'));
    const fragments = await createFragments(root);
    const fragmentPath = join(fragments, 'darwin-arm64', 'release-fragment.json');
    const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
    const dmg = fragment.artifacts.find(artifact => artifact.kind === 'dmg');
    const dmgPath = join(fragments, 'darwin-arm64', dmg.fileName);
    const altered = Buffer.from('darwin-arm64-dmg-altered-after-native-validation');
    await writeFile(dmgPath, altered);
    dmg.size = altered.length;
    dmg.sha256 = createHash('sha256').update(altered).digest('hex');
    await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'final'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /does not bind the exact canonical DMG bytes/,
    );
  });

  test('rejects permanent DMG replacement or in-place mutation during held inspection without emitting evidence', async () => {
    for (const operation of ['in-place-mutation', 'permanent-replace']) {
      const root = await mkdtemp(join(tmpdir(), `propr-release-dmg-inspection-${operation}-`));
      const makeDirectory = join(root, 'make');
      const outputDirectory = join(root, 'stage');
      await mkdir(makeDirectory);
      await writeFile(join(makeDirectory, 'desktop.dmg'), 'darwin-arm64-dmg');
      await writeFile(join(makeDirectory, 'desktop.zip'), 'darwin-arm64-zip');
      const previousSnapshots = new Set(await privateDmgSnapshotPaths());
      await assert.rejects(
        stageFixtureArtifacts({
          makeDirectory,
          outputDirectory,
          platform: 'darwin',
          arch: 'arm64',
          version: '1.2.3',
          inspectArchitecture: async arguments_ => {
            const inspection = await architectureInspector(arguments_);
            if (arguments_.kind === 'dmg') {
              assert.equal(arguments_.path, undefined, 'DMG inspectors must not receive a mutable pathname');
              assert.deepEqual(Object.keys(arguments_.heldArtifact), ['description']);
              const privatePath = await findNewPrivateDmgSnapshot(previousSnapshots);
              assert.ok(!privatePath.startsWith(`${outputDirectory}/`), 'private snapshot must stay outside public output');
              if (operation === 'in-place-mutation') {
                await writeFile(privatePath, 'darwin-arm64-dmg-mutated-during-native-validation');
              } else {
                const displaced = `${privatePath}.displaced`;
                await rename(privatePath, displaced);
                await writeFile(privatePath, 'darwin-arm64-dmg-permanent-replacement');
              }
            }
            return inspection;
          },
        }),
        /Staged DMG identity or content changed during native validation|pathname no longer names the held exact artifact|\[dmg-private:file-(?:identity|mode)\]/,
        operation,
      );
      await assert.rejects(access(join(outputDirectory, 'release-fragment.json')), undefined, operation);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps held A bytes, evidence, and publication stable when original and public pathnames change during inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-swap-restore-'));
    const makeDirectory = join(root, 'make');
    const outputDirectory = join(root, 'stage');
    await mkdir(makeDirectory);
    const originalPath = join(makeDirectory, 'desktop.dmg');
    const destination = join(outputDirectory, 'ProPR-Desktop-1.2.3-macos-arm64-dmg');
    await writeFile(originalPath, 'darwin-arm64-dmg-A');
    await writeFile(join(makeDirectory, 'desktop.zip'), 'darwin-arm64-zip');
    const expectedBytes = Buffer.from('darwin-arm64-dmg-A');
    const fragment = await stageFixtureArtifacts({
      makeDirectory,
      outputDirectory,
      platform: 'darwin',
      arch: 'arm64',
      version: '1.2.3',
      inspectArchitecture: async arguments_ => {
        if (arguments_.kind !== 'dmg') return architectureInspector(arguments_);
        assert.equal(arguments_.path, undefined, 'the mutable private pathname must not enter the callback API');
        assert.deepEqual(Object.keys(arguments_.heldArtifact), ['description']);
        assert.deepEqual(await readHeldDmgArtifactBytes(arguments_.heldArtifact), expectedBytes);
        const displaced = `${originalPath}.held-A`;
        await rename(originalPath, displaced);
        await writeFile(originalPath, 'darwin-arm64-dmg-B');
        await writeFile(destination, 'attacker-controlled-public-B');
        assert.equal(await readFile(destination, 'utf8'), 'attacker-controlled-public-B');
        await rm(destination);
        return architectureInspector(arguments_);
      },
    });
    const artifact = fragment.artifacts.find(candidate => candidate.kind === 'dmg');
    assert.equal(artifact.sha256, createHash('sha256').update(expectedBytes).digest('hex'));
    assert.equal(artifact.nativeDmgValidationEvidence.artifact.sha256, artifact.sha256);
    assert.ok(!JSON.stringify(fragment).includes('propr-dmg-snapshot-'), 'private snapshot path must not enter evidence');
    assert.deepEqual(await readFile(destination), expectedBytes);
    await rm(root, { recursive: true, force: true });
  });

  test('continues to reject a mutable pathname passed directly to DMG inspection', async () => {
    await assert.rejects(
      inspectArtifactArchitecture({ path: '/tmp/public.dmg', kind: 'dmg', platform: 'darwin', arch: 'arm64' }),
      /DMG inspection rejects mutable pathnames/,
    );
  });

  test('requires explicit fixture authority for Windows-hosted DMG evidence tests', {
    skip: process.platform !== 'win32',
  }, async () => {
    await assert.rejects(
      stageArtifacts({
        makeDirectory: 'unused',
        outputDirectory: 'unused',
        platform: 'darwin',
        arch: 'x64',
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /explicit scoped fixture authority/,
    );
  });

  test('accepts real Darwin mode-0700 directory and mode-0600 single-link file authority', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-private-accept-'));
    const makeDirectory = join(root, 'make');
    await mkdir(makeDirectory);
    await writeFile(join(makeDirectory, 'desktop.dmg'), `darwin-${nativeDarwinArch}-dmg`);
    await writeFile(join(makeDirectory, 'desktop.zip'), `darwin-${nativeDarwinArch}-zip`);
    const previousSnapshots = new Set(await privateDmgSnapshotPaths());
    try {
      await stageFixtureArtifacts({
        makeDirectory,
        outputDirectory: join(root, 'stage'),
        platform: 'darwin',
        arch: nativeDarwinArch,
        version: '1.2.3',
        inspectArchitecture: async arguments_ => {
          const inspection = await architectureInspector(arguments_);
          if (arguments_.kind === 'dmg') {
            const privatePath = await findNewPrivateDmgSnapshot(previousSnapshots);
            const directoryStats = await lstat(dirname(privatePath), { bigint: true });
            const fileStats = await lstat(privatePath, { bigint: true });
            assert.equal(directoryStats.mode & 0o777n, 0o700n);
            assert.equal(fileStats.mode & 0o777n, 0o600n);
            assert.equal(fileStats.nlink, 1n);
          }
          return inspection;
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects native Darwin broad mode, foreign owner, extra link, replacement type, and symlink with fixed authority codes', {
    skip: process.platform !== 'darwin',
  }, async t => {
    const cases = [
      ['broad-mode', 'file-mode'],
      ['foreign-owner', 'file-owner'],
      ['hardlink', 'file-link'],
      ['directory', 'file-type'],
      ['symlink', 'file-symlink'],
    ];
    for (const [scenario, code] of cases) await t.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), `propr-release-dmg-private-${scenario}-`));
      const makeDirectory = join(root, 'make');
      await mkdir(makeDirectory);
      await writeFile(join(makeDirectory, 'desktop.dmg'), `darwin-${nativeDarwinArch}-dmg`);
      await writeFile(join(makeDirectory, 'desktop.zip'), `darwin-${nativeDarwinArch}-zip`);
      const previousSnapshots = new Set(await privateDmgSnapshotPaths());
      await assert.rejects(
        stageFixtureArtifacts({
          makeDirectory,
          outputDirectory: join(root, 'stage'),
          platform: 'darwin',
          arch: nativeDarwinArch,
          version: '1.2.3',
          inspectArchitecture: async arguments_ => {
            const inspection = await architectureInspector(arguments_);
            if (arguments_.kind === 'dmg') {
              const privatePath = await findNewPrivateDmgSnapshot(previousSnapshots);
              if (scenario === 'broad-mode') await chmod(privatePath, 0o644);
              else if (scenario === 'foreign-owner') await execFile('/usr/bin/sudo', ['-n', 'chown', '0', privatePath]);
              else if (scenario === 'hardlink') await link(privatePath, `${privatePath}.link`);
              else {
                const displaced = `${privatePath}.displaced`;
                await rename(privatePath, displaced);
                if (scenario === 'directory') await mkdir(privatePath, { mode: 0o700 });
                else await symlink(displaced, privatePath);
              }
            }
            return inspection;
          },
        }),
        error => error instanceof Error
          && error.message === `Private DMG authority rejected [dmg-private:${code}]`,
      );
      await rm(root, { recursive: true, force: true });
    });
  });

  test('accepts native xattr/ctime-only change when held bytes and identity are unchanged', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-xattr-'));
    const makeDirectory = join(root, 'make');
    const outputDirectory = join(root, 'stage');
    await mkdir(makeDirectory);
    await writeFile(join(makeDirectory, 'desktop.dmg'), `darwin-${nativeDarwinArch}-dmg`);
    await writeFile(join(makeDirectory, 'desktop.zip'), `darwin-${nativeDarwinArch}-zip`);
    const previousSnapshots = new Set(await privateDmgSnapshotPaths());
    const fragment = await stageFixtureArtifacts({
      makeDirectory,
      outputDirectory,
      platform: 'darwin',
      arch: nativeDarwinArch,
      version: '1.2.3',
      inspectArchitecture: async arguments_ => {
        const inspection = await architectureInspector(arguments_);
        if (arguments_.kind === 'dmg') {
          const privatePath = await findNewPrivateDmgSnapshot(previousSnapshots);
          const before = await lstat(privatePath, { bigint: true });
          await execFile('xattr', ['-w', 'com.propr.descriptor-validation', 'verified', privatePath]);
          const after = await lstat(privatePath, { bigint: true });
          assert.notEqual(after.ctimeNs, before.ctimeNs, 'fixture must exercise an xattr-only ctime change');
        }
        return inspection;
      },
    });
    assert.equal(fragment.artifacts.find(artifact => artifact.kind === 'dmg').nativeDmgValidationEvidence.validatedNatively, true);
    await rm(root, { recursive: true, force: true });
  });

  test('does not emit claimed DMG layout evidence without the native-validation marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-no-native-marker-'));
    const makeDirectory = join(root, 'make');
    await mkdir(makeDirectory);
    await writeFile(join(makeDirectory, 'desktop.dmg'), 'darwin-arm64-dmg');
    await writeFile(join(makeDirectory, 'desktop.zip'), 'darwin-arm64-zip');
    await assert.rejects(
      stageFixtureArtifacts({
        makeDirectory,
        outputDirectory: join(root, 'stage'),
        platform: 'darwin',
        arch: 'arm64',
        version: '1.2.3',
        inspectArchitecture: async arguments_ => {
          const inspection = await architectureInspector(arguments_);
          delete inspection.nativeValidation;
          return inspection;
        },
      }),
      /Native DMG validation marker must be an object/,
    );
  });

  test('strictly rejects missing, mixed, stale, malformed, or fabricated native DMG evidence', async () => {
    const cases = [
      ['missing evidence', artifact => { delete artifact.nativeDmgValidationEvidence; }, /must be an object/],
      ['wrong filename', artifact => { artifact.nativeDmgValidationEvidence.artifact.fileName = 'foreign.dmg'; }, /exact canonical DMG bytes/],
      ['wrong version', artifact => { artifact.nativeDmgValidationEvidence.version = '1.2.4'; }, /mixed, stale, or cross-target/],
      ['wrong target', artifact => { artifact.nativeDmgValidationEvidence.target = 'darwin-x64'; }, /mixed, stale, or cross-target/],
      ['wrong architecture', artifact => { artifact.nativeDmgValidationEvidence.architecture = 'x64'; }, /mixed, stale, or cross-target/],
      ['wrong hash', artifact => { artifact.nativeDmgValidationEvidence.artifact.sha256 = '0'.repeat(64); }, /exact canonical DMG bytes/],
      ['wrong size', artifact => { artifact.nativeDmgValidationEvidence.artifact.size += 1; }, /exact canonical DMG bytes/],
      ['wrong size type', artifact => { artifact.nativeDmgValidationEvidence.artifact.size = `${artifact.size}`; }, /exact canonical DMG bytes/],
      ['missing layout field', artifact => { delete artifact.nativeDmgValidationEvidence.layout.mainExecutable; }, /missing or unknown keys/],
      ['unknown layout key', artifact => { artifact.nativeDmgValidationEvidence.layout.untrusted = true; }, /missing or unknown keys/],
      ['unknown record key', artifact => { artifact.nativeDmgValidationEvidence.untrusted = true; }, /missing or unknown keys/],
      ['unknown schema', artifact => { artifact.nativeDmgValidationEvidence.schemaVersion = 2; }, /unsupported schemaVersion/],
      ['symlink claim without native marker', artifact => { artifact.nativeDmgValidationEvidence.validatedNatively = false; }, /lacks the native-validation marker/],
    ];
    for (const [name, mutate, expected] of cases) {
      const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-evidence-'));
      const fragments = await createFragments(root);
      const fragmentPath = join(fragments, 'darwin-arm64', 'release-fragment.json');
      const fragment = JSON.parse(await readFile(fragmentPath, 'utf8'));
      const artifact = fragment.artifacts.find(candidate => candidate.kind === 'dmg');
      mutate(artifact);
      await writeFile(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
      await assert.rejects(
        finalizeArtifacts({
          inputDirectory: fragments,
          outputDirectory: join(root, 'final'),
          version: '1.2.3',
          inspectArchitecture: architectureInspector,
        }),
        expected,
        name,
      );
    }
  });

  test('rejects native DMG evidence copied between x64 and arm64 fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-dmg-cross-label-'));
    const fragments = await createFragments(root);
    const x64Fragment = JSON.parse(await readFile(join(fragments, 'darwin-x64', 'release-fragment.json'), 'utf8'));
    const arm64Path = join(fragments, 'darwin-arm64', 'release-fragment.json');
    const arm64Fragment = JSON.parse(await readFile(arm64Path, 'utf8'));
    arm64Fragment.artifacts.find(artifact => artifact.kind === 'dmg').nativeDmgValidationEvidence =
      x64Fragment.artifacts.find(artifact => artifact.kind === 'dmg').nativeDmgValidationEvidence;
    await writeFile(arm64Path, `${JSON.stringify(arm64Fragment, null, 2)}\n`);
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'final'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /mixed, stale, or cross-target|exact canonical DMG bytes/,
    );
  });

  test('rejects duplicate target fragments before aggregation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-duplicate-fragment-'));
    const fragments = await createFragments(root);
    const duplicate = join(fragments, 'duplicate');
    await mkdir(duplicate);
    await writeFile(
      join(duplicate, 'release-fragment.json'),
      await readFile(join(fragments, 'darwin-x64', 'release-fragment.json')),
    );
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'final'),
        version: '1.2.3',
        inspectArchitecture: architectureInspector,
      }),
      /Expected 6 release fragments, found 7/,
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
      stageFixtureArtifacts({
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
    assert.deepEqual(manifest.windowsSignerPins, windowsSignerPins.split(','));
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
    await writeFile(arm64Package, storedZip(windowsAuthorityFixtureEntries(
      'lib/net45/propr-desktop.exe', peFixture(0xaa64),
    )));

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
    await writeFile(arm64Package, storedZip(windowsAuthorityFixtureEntries(
      'lib/net45/propr-desktop.exe', Buffer.from('tampered payload'),
    )));
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
      const entries = kind === 'nupkg'
        ? windowsAuthorityFixtureEntries(executablePath, bytes)
        : [[executablePath, bytes]];
      await writeFile(path, storedZip(entries));
      const result = await inspectArtifactArchitecture({ path, kind, platform, arch });
      assert.equal(result.executable.architectures[0], arch);
    }
  });

  test('rejects missing, corrupt, mismatched, and ambiguous packaged Windows authority helpers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-windows-authority-'));
    const executablePath = 'lib/net45/propr-desktop.exe';
    const executable = peFixture(0x8664);
    const exact = windowsAuthorityFixtureEntries(executablePath, executable);
    const corruptManifest = exact.map(entry => [...entry]);
    const parsed = JSON.parse(corruptManifest[2][1].toString('utf8'));
    parsed.sha256 = '0'.repeat(64);
    corruptManifest[2][1] = Buffer.from(`${JSON.stringify(parsed)}\n`);
    const corruptHelper = exact.map(entry => [...entry]);
    corruptHelper[1][1] = Buffer.from(corruptHelper[1][1]);
    corruptHelper[1][1][0] = 0;
    const cases = [
      ['missing', [exact[0]], /missing its exact Windows authority helper binding/],
      ['manifest', corruptManifest, /does not match its bound manifest/],
      ['output', corruptHelper, /does not match its bound manifest|not the expected managed/],
      ['alternate', [...exact, ['tools/propr-windows-authority.exe', exact[1][1]]], /ambiguous Windows authority helper layout/],
    ];
    for (const [name, entries, pattern] of cases) {
      const path = join(root, `${name}.nupkg`);
      await writeFile(path, storedZip(entries));
      await assert.rejects(
        inspectArtifactArchitecture({ path, kind: 'nupkg', platform: 'win32', arch: 'x64' }),
        pattern,
      );
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
    const valid = storedZip(windowsAuthorityFixtureEntries('lib/net45/propr-desktop.exe', executable));
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
        if (kind === 'dmg') {
          const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            await assert.rejects(
              architectureInspector({ heldArtifact: createHeldDmgArtifact(handle, path), kind, platform, arch }),
              new RegExp(`${kind} packaged executable architecture mismatch`),
            );
          } finally {
            await handle.close();
          }
        } else {
          await assert.rejects(
            architectureInspector({ path, kind, platform, arch }),
            new RegExp(`${kind} packaged executable architecture mismatch`),
          );
        }
      }
    }

    const makeDirectory = join(root, 'make');
    await mkdir(makeDirectory, { recursive: true });
    for (const kind of kinds['linux-x64']) {
      const contents = kind === 'releases' ? '' : `linux-arm64-${kind}`;
      await writeFile(join(makeDirectory, sourceName(kind)), contents);
    }
    await assert.rejects(
      stageFixtureArtifacts({
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
