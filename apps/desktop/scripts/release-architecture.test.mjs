import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspectDmgLayout, inspectLinuxPackageLayout } from './release-architecture.mjs';

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

describe('DMG application layout', () => {
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
    const frameworkVersions = join(frameworks, 'Electron Framework.framework', 'Versions');
    await mkdir(join(frameworkVersions, 'A', 'Resources'), { recursive: true });
    await symlink('A', join(frameworkVersions, 'Current'));
    await symlink('Versions/Current/Resources', join(frameworks, 'Electron Framework.framework', 'Resources'));
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

  test('rejects alternate roots, unsafe links, special files, and non-helper nested apps', async context => {
    const alternateRoot = await mkdtemp(join(tmpdir(), 'propr-dmg-extra-root-'));
    context.after(() => rm(alternateRoot, { recursive: true, force: true }));
    await createDmgLayout(alternateRoot);
    await mkdir(join(alternateRoot, 'Other.app'));
    await assert.rejects(
      inspectDmgLayout({ root: alternateRoot, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /unclaimed or alternate top-level payload/,
    );

    const unsafeLink = await mkdtemp(join(tmpdir(), 'propr-dmg-unsafe-link-'));
    context.after(() => rm(unsafeLink, { recursive: true, force: true }));
    await createDmgLayout(unsafeLink);
    await symlink('/tmp/escape', join(unsafeLink, 'propr-desktop.app', 'Contents', 'escape'));
    await assert.rejects(
      inspectDmgLayout({ root: unsafeLink, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /unsafe absolute symbolic link/,
    );

    const nestedApp = await mkdtemp(join(tmpdir(), 'propr-dmg-nested-app-'));
    context.after(() => rm(nestedApp, { recursive: true, force: true }));
    await createDmgLayout(nestedApp);
    await mkdir(join(nestedApp, 'propr-desktop.app', 'Contents', 'Resources', 'Alternate.app'), { recursive: true });
    await assert.rejects(
      inspectDmgLayout({ root: nestedApp, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /alternate application bundle/,
    );

    const caseCollision = await mkdtemp(join(tmpdir(), 'propr-dmg-case-collision-'));
    context.after(() => rm(caseCollision, { recursive: true, force: true }));
    await createDmgLayout(caseCollision);
    await symlink('/Applications', join(caseCollision, 'applications'));
    await assert.rejects(
      inspectDmgLayout({ root: caseCollision, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
      /duplicate or case-colliding top-level entry/,
    );

    if (process.platform !== 'win32') {
      const special = await mkdtemp(join(tmpdir(), 'propr-dmg-special-'));
      context.after(() => rm(special, { recursive: true, force: true }));
      await createDmgLayout(special);
      execFileSync('mkfifo', [join(special, 'propr-desktop.app', 'Contents', 'special')]);
      await assert.rejects(
        inspectDmgLayout({ root: special, platform: 'darwin', arch: 'arm64', artifact: 'DMG fixture' }),
        /special file/,
      );
    }
  });
});
