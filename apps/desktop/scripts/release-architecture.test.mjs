import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import {
  inspectDmgLayout,
  inspectExtractedDmgArchitecture,
  inspectExtractedMsiLayout,
  inspectArtifactArchitecture,
  inspectLinuxPackageLayout,
  inspectMachineMsiForTest,
  msiExtractorInvocationForTest,
  runBoundedMsiExtractorForTest,
  validateMsiListingForTest,
} from './release-architecture.mjs';

test('machine-wide Windows artifacts require a real MSI compound file', async context => {
  const root = await mkdtemp(join(tmpdir(), 'propr-msi-layout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'ProPR-Desktop-Machine-Setup.msi');
  await writeFile(fake, Buffer.alloc(4096));
  await assert.rejects(
    inspectArtifactArchitecture({ path: fake, kind: 'msi', platform: 'win32', arch: 'x64' }),
    error => error?.message === 'MSI_INSPECTION_FAILED:MSI_HEADER',
  );
});

const peFixture = machine => {
  const bytes = Buffer.alloc(512);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
};

const msiTree = async (context, machine = 0x8664, prefixed = true) => {
  const root = await mkdtemp(join(tmpdir(), 'propr-msi-admin-image-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const application = join(root, ...(prefixed ? ['Program Files 64'] : []), 'ProPR Desktop');
  await mkdir(application, { recursive: true });
  await writeFile(join(application, 'propr-desktop.exe'), peFixture(machine));
  return root;
};

describe('administrative MSI payload inspection', () => {
  test('uses exact fixed native extractor argv and minimal environments', () => {
    assert.deepEqual(
      msiExtractorInvocationForTest('win32', String.raw`D:\input\app.msi`, String.raw`D:\private`, {
        msiexec: String.raw`C:\Windows\System32\msiexec.exe`,
        taskkill: String.raw`C:\Windows\System32\taskkill.exe`,
      }),
      {
        file: String.raw`C:\Windows\System32\msiexec.exe`,
        args: ['/a', String.raw`D:\input\app.msi`, '/qn', '/norestart', 'REBOOT=ReallySuppress', String.raw`TARGETDIR=D:\private`],
        env: { SystemRoot: String.raw`C:\Windows`, TEMP: String.raw`D:\private`, TMP: String.raw`D:\private` },
        treeKiller: String.raw`C:\Windows\System32\taskkill.exe`,
      },
    );
    assert.deepEqual(
      msiExtractorInvocationForTest('linux', '/input/app.msi', '/private', { msiextract: '/usr/bin/msiextract' }),
      {
        file: '/usr/bin/msiextract',
        args: ['--directory', '/private', '/input/app.msi'],
        env: { LANG: 'C', LC_ALL: 'C' },
      },
    );
    assert.throws(
      () => msiExtractorInvocationForTest('darwin', '/input/app.msi', '/private', {}),
      error => error?.message === 'MSI_INSPECTION_FAILED:UNSUPPORTED_HOST',
    );
  });

  test('accepts only the canonical application with the one administrative root prefix', async context => {
    for (const prefixed of [false, true]) {
      const root = await msiTree(context, 0x8664, prefixed);
      assert.deepEqual(
        await inspectExtractedMsiLayout({ root, platform: 'win32', arch: 'x64' }),
        { format: 'pe', architectures: ['x64'] },
      );
    }
  });

  test('rejects path escapes and case collisions from the Linux listing before extraction', () => {
    assert.doesNotThrow(() => validateMsiListingForTest(Buffer.from(
      'Program Files 64/ProPR Desktop/propr-desktop.exe\n',
    )));
    for (const listing of [
      '../escape.exe\n',
      '/absolute.exe\n',
      'C:/absolute.exe\n',
      'safe\\alternate.exe\n',
      'Folder/file\nfolder/FILE\n',
      Buffer.from([0xff]),
    ]) {
      assert.throws(
        () => validateMsiListingForTest(Buffer.isBuffer(listing) ? listing : Buffer.from(listing)),
        error => error?.message === 'MSI_INSPECTION_FAILED:UNSAFE_TREE',
      );
    }
  });

  test('uses fixed missing and duplicate canonical-app codes with bounded counts', async context => {
    const missing = await mkdtemp(join(tmpdir(), 'propr-msi-admin-missing-'));
    context.after(() => rm(missing, { recursive: true, force: true }));
    await assert.rejects(
      inspectExtractedMsiLayout({ root: missing, platform: 'win32', arch: 'x64' }),
      error => error?.message === 'MSI_INSPECTION_FAILED:CANONICAL_APP count=0',
    );

    const duplicate = await msiTree(context);
    const alternate = join(duplicate, 'Elsewhere');
    await mkdir(alternate);
    await writeFile(join(alternate, 'propr-desktop.exe'), peFixture(0x8664));
    await assert.rejects(
      inspectExtractedMsiLayout({ root: duplicate, platform: 'win32', arch: 'x64' }),
      error => error?.message === 'MSI_INSPECTION_FAILED:CANONICAL_APP count=2',
    );
  });

  test('distinguishes authority resources, unsafe trees, and architecture mismatch without path data', async context => {
    const authority = await msiTree(context);
    await writeFile(join(authority, 'Program Files 64', 'ProPR Desktop', 'propr-windows-launcher.node'), 'deferred');
    await assert.rejects(
      inspectExtractedMsiLayout({ root: authority, platform: 'win32', arch: 'x64' }),
      error => error?.message === 'MSI_INSPECTION_FAILED:AUTHORITY_RESOURCE count=1',
    );

    const unsafe = await msiTree(context);
    const canonical = join(unsafe, 'Program Files 64', 'ProPR Desktop', 'propr-desktop.exe');
    await link(canonical, join(unsafe, 'Program Files 64', 'ProPR Desktop', 'held-copy'));
    await assert.rejects(
      inspectExtractedMsiLayout({ root: unsafe, platform: 'win32', arch: 'x64' }),
      error => error?.message === 'MSI_INSPECTION_FAILED:UNSAFE_TREE',
    );

    const wrongArchitecture = await msiTree(context, 0xaa64);
    await assert.rejects(
      inspectExtractedMsiLayout({ root: wrongArchitecture, platform: 'win32', arch: 'x64' }),
      error => error?.message === 'MSI_INSPECTION_FAILED:ARCHITECTURE_MISMATCH',
    );
  });

  test('maps extractor failures to one redacted tool code', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-msi-extractor-failure-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const msi = join(root, 'fixture.msi');
    const bytes = Buffer.alloc(4096);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
    await writeFile(msi, bytes);
    await assert.rejects(
      inspectMachineMsiForTest(msi, 'win32', 'x64', async () => {
        throw new Error(`raw failure at ${root}`);
      }),
      error => error?.message === 'MSI_INSPECTION_FAILED:EXTRACTOR_TOOL',
    );
  });

  test('retains compound-file, per-machine scope, and canonical PE evidence across extraction', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-msi-evidence-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const msi = join(root, 'fixture.msi');
    const bytes = Buffer.alloc(4096);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
    await writeFile(msi, bytes);
    const inspection = await inspectMachineMsiForTest(msi, 'win32', 'x64', async (msiPath, extraction) => {
      assert.equal(msiPath, msi);
      const application = join(extraction, 'Program Files 64', 'ProPR Desktop');
      await mkdir(application, { recursive: true });
      await writeFile(join(application, 'propr-desktop.exe'), peFixture(0x8664));
    });
    assert.deepEqual(inspection, {
      format: 'windows-machine-msi',
      scope: 'per-machine',
      executable: { format: 'pe', architectures: ['x64'] },
    });
  });

  test('fails closed on extractor nonzero, stderr, output overflow, and timeout', {
    skip: process.platform === 'win32',
  }, async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-msi-process-boundary-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    for (const source of [
      'process.exit(7)',
      'process.stderr.write("diagnostic")',
      'process.stdout.write("x".repeat(65))',
      'setInterval(() => {}, 1000)',
    ]) {
      await assert.rejects(
        runBoundedMsiExtractorForTest({
          file: process.execPath,
          args: ['-e', source],
          cwd: root,
          env: {},
          hostPlatform: 'linux',
          timeoutMs: 50,
          outputLimit: 64,
        }),
        error => error?.message === 'MSI_INSPECTION_FAILED:EXTRACTOR_TOOL',
      );
    }
  });
});

const elfFixture = machine => {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
  bytes[5] = 1;
  bytes.writeUInt16LE(machine, 18);
  return bytes;
};

const createLayout = async (root, machine = 62, packageFormat = 'deb') => {
  const appDirectory = join(root, 'usr', 'lib', 'propr-desktop');
  const binDirectory = join(root, 'usr', 'bin');
  await mkdir(appDirectory, { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await writeFile(join(appDirectory, 'propr-desktop'), elfFixture(machine), { mode: 0o755 });
  await symlink('../lib/propr-desktop/propr-desktop', join(binDirectory, 'propr-desktop'));
  await mkdir(join(root, 'usr', 'share', 'doc', 'propr-desktop'), { recursive: true });
  if (packageFormat === 'deb') {
    const lintianDirectory = join(root, 'usr', 'share', 'lintian', 'overrides');
    await mkdir(lintianDirectory, { recursive: true });
    await writeFile(join(lintianDirectory, 'propr-desktop'), 'propr-desktop: expected-package-override\n');
  }
};

const fixture = async (context, machine = 62, packageFormat = 'deb') => {
  const root = await mkdtemp(join(tmpdir(), 'propr-linux-layout-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await createLayout(root, machine, packageFormat);
  return root;
};

describe('DEB and RPM executable layouts', () => {
  test('accept only the canonical regular ELF payload and documented launcher symlink', async context => {
    for (const [format, arch, machine] of [['DEB', 'x64', 62], ['RPM', 'arm64', 183]]) {
      const packageFormat = format.toLowerCase();
      const root = await fixture(context, machine, packageFormat);
      assert.deepEqual(
        await inspectLinuxPackageLayout({ root, packageFormat, platform: 'linux', arch, artifact: `${format} fixture` }),
        { format: 'elf', architectures: [arch] },
      );
    }
  });

  test('reject missing and extra payload names for both package formats', async context => {
    const missingRoot = await fixture(context);
    await rm(join(missingRoot, 'usr', 'lib', 'propr-desktop', 'propr-desktop'));
    await assert.rejects(
      inspectLinuxPackageLayout({ root: missingRoot, packageFormat: 'deb', platform: 'linux', arch: 'x64', artifact: 'DEB fixture' }),
      /only the canonical payload and launcher layout/,
    );

    const extraRoot = await fixture(context, 62, 'rpm');
    await mkdir(join(extraRoot, 'opt'), { recursive: true });
    await writeFile(join(extraRoot, 'opt', 'propr-desktop'), elfFixture(62));
    await assert.rejects(
      inspectLinuxPackageLayout({ root: extraRoot, packageFormat: 'rpm', platform: 'linux', arch: 'x64', artifact: 'RPM fixture' }),
      /opt\/propr-desktop \(regular file\)/,
    );

    const disguisedPayloadRoot = await fixture(context);
    await writeFile(
      join(disguisedPayloadRoot, 'usr', 'share', 'lintian', 'overrides', 'propr-desktop'),
      elfFixture(62),
    );
    await assert.rejects(
      inspectLinuxPackageLayout({ root: disguisedPayloadRoot, packageFormat: 'deb', platform: 'linux', arch: 'x64', artifact: 'DEB fixture' }),
      /lintian override must not contain an extra ELF payload/,
    );
  });

  test('reject unexpected same-name file types and non-ELF or cross-architecture payloads', async context => {
    const regularLauncherRoot = await fixture(context);
    const regularLauncher = join(regularLauncherRoot, 'usr', 'bin', 'propr-desktop');
    await rm(regularLauncher);
    await writeFile(regularLauncher, '#!/bin/sh\n');
    await assert.rejects(
      inspectLinuxPackageLayout({ root: regularLauncherRoot, packageFormat: 'deb', platform: 'linux', arch: 'x64', artifact: 'DEB fixture' }),
      /usr\/bin\/propr-desktop \(regular file\)/,
    );

    const wrongArchitectureRoot = await fixture(context, 183, 'rpm');
    await assert.rejects(
      inspectLinuxPackageLayout({ root: wrongArchitectureRoot, packageFormat: 'rpm', platform: 'linux', arch: 'x64', artifact: 'RPM fixture' }),
      /architecture mismatch.*elf\/x64.*elf\/arm64/,
    );

    const invalidPayloadRoot = await fixture(context);
    await writeFile(join(invalidPayloadRoot, 'usr', 'lib', 'propr-desktop', 'propr-desktop'), 'launcher text');
    await assert.rejects(
      inspectLinuxPackageLayout({ root: invalidPayloadRoot, packageFormat: 'deb', platform: 'linux', arch: 'x64', artifact: 'DEB fixture' }),
      /not a recognized.*binary/,
    );
  });

  test('reject launcher escapes, cycles, and targets other than the canonical payload', async context => {
    for (const [name, target, pattern] of [
      ['escape', '../../../outside-propr-desktop', /escapes the extraction root/],
      ['cycle', 'propr-desktop', /symbolic-link cycle/],
      ['mismatch', '../lib/propr-desktop/helper', /must resolve to usr\/lib\/propr-desktop\/propr-desktop/],
    ]) {
      const root = await fixture(context, 62, 'rpm');
      const launcher = join(root, 'usr', 'bin', 'propr-desktop');
      await rm(launcher);
      if (name === 'mismatch') {
        await writeFile(join(root, 'usr', 'lib', 'propr-desktop', 'helper'), elfFixture(62));
      }
      await symlink(target, launcher);
      await assert.rejects(
        inspectLinuxPackageLayout({ root, packageFormat: 'rpm', platform: 'linux', arch: 'x64', artifact: 'RPM fixture' }),
        pattern,
      );
    }
  });

  test('reject special files with the executable name', { skip: process.platform === 'win32' }, async context => {
    const root = await fixture(context);
    const specialDirectory = join(root, 'var');
    const special = join(specialDirectory, 'propr-desktop');
    await mkdir(specialDirectory, { recursive: true });
    execFileSync('mkfifo', [special]);
    await assert.rejects(
      inspectLinuxPackageLayout({ root, packageFormat: 'deb', platform: 'linux', arch: 'x64', artifact: 'DEB fixture' }),
      /var\/propr-desktop \(special file\)/,
    );
  });
});

describe('DMG application layout', { skip: process.platform === 'win32' }, () => {
  const createDmgLayout = async root => {
    const macos = join(root, 'propr-desktop.app', 'Contents', 'MacOS');
    const frameworks = join(root, 'propr-desktop.app', 'Contents', 'Frameworks');
    await mkdir(macos, { recursive: true });
    const executable = Buffer.alloc(32);
    executable.writeUInt32LE(0xfeedfacf, 0);
    executable.writeUInt32LE(0x0100000c, 4);
    await writeFile(join(macos, 'propr-desktop'), executable, { mode: 0o755 });
    for (const name of [
      'propr-desktop Helper',
      'propr-desktop Helper (GPU)',
      'propr-desktop Helper (Plugin)',
      'propr-desktop Helper (Renderer)',
    ]) {
      const helperMacos = join(frameworks, `${name}.app`, 'Contents', 'MacOS');
      await mkdir(helperMacos, { recursive: true });
      await writeFile(join(helperMacos, name), executable, { mode: 0o755 });
    }
    const framework = join(frameworks, 'Electron Framework.framework');
    const frameworkVersions = join(framework, 'Versions');
    await mkdir(join(frameworkVersions, 'A', 'Resources'), { recursive: true });
    await mkdir(join(frameworkVersions, 'A', 'Libraries'), { recursive: true });
    await mkdir(join(frameworkVersions, 'A', 'Helpers'), { recursive: true });
    await writeFile(join(frameworkVersions, 'A', 'Electron Framework'), executable, { mode: 0o755 });
    await symlink('A', join(frameworkVersions, 'Current'));
    await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
    await symlink('Versions/Current/Resources', join(framework, 'Resources'));
    await symlink('Versions/Current/Libraries', join(framework, 'Libraries'));
    await symlink('Versions/Current/Helpers', join(framework, 'Helpers'));
    await symlink('/Applications', join(root, 'Applications'));
  };

  test('accepts the real Forge tree with its install link and nested Electron helper bundles', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-dmg-layout-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await createDmgLayout(root);
    assert.deepEqual(
      await inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      { format: 'mach-o', architectures: ['arm64'] },
    );
  });

  test('rejects a symbolic-link canonical helper bundle', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-dmg-helper-link-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await createDmgLayout(root);
    const frameworks = join(root, 'propr-desktop.app', 'Contents', 'Frameworks');
    const helper = join(frameworks, 'propr-desktop Helper.app');
    await rename(helper, `${helper}.real`);
    await symlink('propr-desktop Helper.app.real', helper);
    await assert.rejects(
      inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /canonical .*Helper\.app must be a real directory, found symbolic link/,
    );
  });

  test('rejects a symbolic-link canonical helper executable ancestor', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-dmg-helper-ancestor-link-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await createDmgLayout(root);
    const helper = join(root, 'propr-desktop.app', 'Contents', 'Frameworks', 'propr-desktop Helper (GPU).app');
    const contents = join(helper, 'Contents');
    await rename(contents, join(helper, 'RealContents'));
    await symlink('RealContents', contents);
    await assert.rejects(
      inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /Helper \(GPU\)\.app\/Contents must be a real directory, found symbolic link/,
    );
  });

  test('rejects every symbolic link outside canonical framework internals', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-dmg-non-framework-link-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await createDmgLayout(root);
    const resources = join(root, 'propr-desktop.app', 'Contents', 'Resources');
    await mkdir(resources);
    await symlink('../MacOS', join(resources, 'MacOS'));
    await assert.rejects(
      inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /outside canonical macOS framework internals/,
    );
  });

  test('rejects escaping, cyclic, missing, and case-mismatched framework symbolic links', async context => {
    for (const [name, alter, pattern] of [
      ['escape', async framework => {
        await rm(join(framework, 'Resources'));
        await symlink('../../../../MacOS', join(framework, 'Resources'));
      }, /unsafe relative target/],
      ['cycle', async framework => {
        const versions = join(framework, 'Versions');
        await rm(join(versions, 'Current'));
        await symlink('B', join(versions, 'Current'));
        await symlink('Current', join(versions, 'B'));
      }, /contains a cycle/],
      ['missing', async framework => {
        await rm(join(framework, 'Resources'));
        await symlink('Versions/B/Resources', join(framework, 'Resources'));
      }, /missing target/],
      ['case-mismatched', async framework => {
        await rm(join(framework, 'Resources'));
        await symlink('Versions/a/Resources', join(framework, 'Resources'));
      }, /missing target/],
    ]) {
      const root = await mkdtemp(join(tmpdir(), `propr-dmg-framework-${name}-`));
      context.after(() => rm(root, { recursive: true, force: true }));
      await createDmgLayout(root);
      await alter(join(root, 'propr-desktop.app', 'Contents', 'Frameworks', 'Electron Framework.framework'));
      await assert.rejects(
        inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
        pattern,
        name,
      );
    }
  });

  test('never treats Linux 7z sanitized install-link output as native layout evidence', async context => {
    const root = await mkdtemp(join(tmpdir(), 'propr-dmg-sanitized-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    await createDmgLayout(root);
    await rm(join(root, 'Applications'));
    await writeFile(join(root, 'Applications'), '/Applications');
    await assert.rejects(
      inspectDmgLayout({ root, platform: 'darwin', arch: 'arm64', artifact: '7z DMG fixture' }),
      /exact \/Applications symbolic link/,
    );
    assert.deepEqual(
      await inspectExtractedDmgArchitecture({ root, platform: 'darwin', arch: 'arm64', artifact: '7z DMG fixture' }),
      { format: 'mach-o', architectures: ['arm64'] },
    );
  });

  test('rejects wrong bundles, alternate same-name executables, and canonical symlink escapes', async context => {
    const wrongBundle = await mkdtemp(join(tmpdir(), 'propr-dmg-wrong-bundle-'));
    context.after(() => rm(wrongBundle, { recursive: true, force: true }));
    await mkdir(join(wrongBundle, 'Wrong.app', 'Contents', 'MacOS'), { recursive: true });
    await assert.rejects(
      inspectDmgLayout({ root: wrongBundle, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /missing canonical propr-desktop\.app/,
    );

    const alternate = await mkdtemp(join(tmpdir(), 'propr-dmg-alternate-'));
    context.after(() => rm(alternate, { recursive: true, force: true }));
    await createDmgLayout(alternate);
    const resources = join(alternate, 'propr-desktop.app', 'Contents', 'Resources');
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, 'propr-desktop'), 'alternate');
    await assert.rejects(
      inspectDmgLayout({ root: alternate, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /alternate same-name executable/,
    );

    const escaped = await mkdtemp(join(tmpdir(), 'propr-dmg-symlink-'));
    context.after(() => rm(escaped, { recursive: true, force: true }));
    await mkdir(join(escaped, 'propr-desktop.app', 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(escaped, 'outside'), 'outside');
    await symlink('/Applications', join(escaped, 'Applications'));
    await symlink('../../../outside', join(escaped, 'propr-desktop.app', 'Contents', 'MacOS', 'propr-desktop'));
    await assert.rejects(
      inspectDmgLayout({ root: escaped, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /must be a real regular file.*symbolic link/,
    );
  });

  test('rejects alternate top-level application bundles', async context => {
    const alternateRoot = await mkdtemp(join(tmpdir(), 'propr-dmg-extra-root-'));
    context.after(() => rm(alternateRoot, { recursive: true, force: true }));
    await createDmgLayout(alternateRoot);
    await mkdir(join(alternateRoot, 'Other.app'));
    await assert.rejects(
      inspectDmgLayout({ root: alternateRoot, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /unclaimed or alternate top-level payload/,
    );
  });

  test('rejects unsafe links inside the canonical application bundle', async context => {
    const unsafeLink = await mkdtemp(join(tmpdir(), 'propr-dmg-unsafe-link-'));
    context.after(() => rm(unsafeLink, { recursive: true, force: true }));
    await createDmgLayout(unsafeLink);
    await symlink('/tmp/escape', join(unsafeLink, 'propr-desktop.app', 'Contents', 'escape'));
    await assert.rejects(
      inspectDmgLayout({ root: unsafeLink, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /outside canonical macOS framework internals/,
    );
  });

  test('rejects non-helper nested application bundles', async context => {
    const nestedApp = await mkdtemp(join(tmpdir(), 'propr-dmg-nested-app-'));
    context.after(() => rm(nestedApp, { recursive: true, force: true }));
    await createDmgLayout(nestedApp);
    await mkdir(join(nestedApp, 'propr-desktop.app', 'Contents', 'Resources', 'Alternate.app'), { recursive: true });
    await assert.rejects(
      inspectDmgLayout({ root: nestedApp, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /alternate application bundle/,
    );
  });

  test('rejects case-colliding top-level entries when the filesystem permits them', async context => {
    const caseCollision = await mkdtemp(join(tmpdir(), 'propr-dmg-case-collision-'));
    context.after(() => rm(caseCollision, { recursive: true, force: true }));
    await createDmgLayout(caseCollision);
    try {
      await symlink('/Applications', join(caseCollision, 'applications'));
    } catch (error) {
      if (error?.code === 'EEXIST') {
        context.skip('filesystem does not permit distinct case-colliding entries');
        return;
      }
      throw error;
    }
    await assert.rejects(
      inspectDmgLayout({ root: caseCollision, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /duplicate or case-colliding top-level entry/,
    );
  });

  test('rejects special files inside the canonical application bundle', async context => {
    const special = await mkdtemp(join(tmpdir(), 'propr-dmg-special-'));
    context.after(() => rm(special, { recursive: true, force: true }));
    await createDmgLayout(special);
    execFileSync('mkfifo', [join(special, 'propr-desktop.app', 'Contents', 'special')]);
    await assert.rejects(
      inspectDmgLayout({ root: special, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /special file/,
    );
  });
});
