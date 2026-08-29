import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspectLinuxPackageLayout } from './release-architecture.mjs';

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
