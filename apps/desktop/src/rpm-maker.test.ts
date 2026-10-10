import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { portableRpmRequires, ProprMakerRpm } from './rpm-maker';

type RedhatDependenciesModule = {
  rpmSupportsBooleanDependencies: () => Promise<boolean>;
  forElectron: (electronVersion: string, logger: (message: string) => void) => Promise<{ requires: string[] }>;
};

const localRequire = createRequire(import.meta.url);
const makerRequire = createRequire(join(dirname(localRequire.resolve('@electron-forge/maker-rpm')), 'loader.cjs'));
const redhatDependencies = makerRequire('electron-installer-redhat/src/dependencies') as RedhatDependenciesModule;
const electronVersion = (localRequire('electron/package.json') as { version: string }).version;
const desktopLinuxIcon = fileURLToPath(new URL('../assets/icons/propr-desktop.png', import.meta.url));

// Every runtime requirement the published Electron RPM carries. Only the DRM
// requirement differs from the upstream electron-installer-redhat defaults.
const EXPECTED_RPM_REQUIRES = [
  '(kde-cli-tools or kde-cli-tools5 or kde-runtime or trash-cli or glib2 or gvfs-client)',
  '(libdrm or libdrm2)',
  '(libnotify or libnotify4)',
  '(libxcb or libxcb1)',
  '(mesa-libgbm or libgbm1)',
  '(nss or mozilla-nss)',
  'at-spi2-core',
  'gtk3',
  'xdg-utils',
];

async function upstreamRequires(): Promise<string[]> {
  const original = redhatDependencies.rpmSupportsBooleanDependencies;
  redhatDependencies.rpmSupportsBooleanDependencies = async () => true;
  try {
    return (await redhatDependencies.forElectron(electronVersion, () => undefined)).requires;
  } finally {
    redhatDependencies.rpmSupportsBooleanDependencies = original;
  }
}

describe('ProPR RPM runtime requirements', () => {
  test('accepts the openSUSE libdrm2 provider without dropping other Electron requirements', async () => {
    const upstream = await upstreamRequires();
    assert.ok(upstream.includes('libdrm'), 'upstream Fedora-only DRM default changed; revisit the RPM alternative');

    const portable = portableRpmRequires(upstream);
    assert.equal(portable.length, upstream.length);
    assert.ok(!portable.includes('libdrm'));
    assert.deepEqual(
      portable.filter(requirement => !upstream.includes(requirement)),
      ['(libdrm or libdrm2)'],
    );
    assert.deepEqual([...portable].sort(), EXPECTED_RPM_REQUIRES);
  });
});

const NATIVE_RPM_TOOLS = ['rpmbuild', 'rpm', 'rpms2solv', 'testsolv'];
const missingRpmTools = process.platform === 'linux'
  ? NATIVE_RPM_TOOLS.filter(tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error !== undefined)
  : NATIVE_RPM_TOOLS;

const SUSE_SYSTEM: Record<string, string[]> = {
  'at-spi2-core': [],
  glib2: [],
  gtk3: [],
  libgbm1: [],
  libnotify4: [],
  libxcb1: [],
  'mozilla-nss': [],
  'xdg-utils': [],
};
const FEDORA_SYSTEM: Record<string, string[]> = {
  'at-spi2-core': [],
  glib2: [],
  gtk3: [],
  libnotify: [],
  libxcb: [],
  'mesa-libgbm': [],
  nss: [],
  'xdg-utils': [],
};
// Mirrors `rpm -q --provides libdrm2` on openSUSE Leap 15.6: no `libdrm` name.
const SUSE_LIBDRM2 = { libdrm2: ['libdrm.so.2()(64bit)', 'libkms1'] };
const FEDORA_LIBDRM = { libdrm: ['libdrm.so.2()(64bit)'] };

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${command} failed to start`);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function createPackagedAppFixture(root: string): string {
  const appDir = join(root, 'propr-desktop-linux');
  mkdirSync(join(appDir, 'resources', 'app'), { recursive: true });
  writeFileSync(join(appDir, 'version'), `${electronVersion}\n`);
  writeFileSync(join(appDir, 'LICENSE'), 'Apache-2.0\n');
  writeFileSync(join(appDir, 'resources', 'app', 'package.json'), JSON.stringify({
    name: 'propr-desktop',
    version: '0.9.0',
    description: 'Secure ProPR desktop application',
    license: 'Apache-2.0',
    homepage: 'https://github.com/integry/propr',
  }));
  writeFileSync(join(appDir, 'propr-desktop'), '#!/bin/sh\n');
  writeFileSync(join(appDir, 'chrome-sandbox'), '');
  chmodSync(join(appDir, 'propr-desktop'), 0o755);
  chmodSync(join(appDir, 'chrome-sandbox'), 0o4755);
  return appDir;
}

function solve(workDir: string, packageSolv: string, arch: string, system: Record<string, string[]>): string {
  const lines = ['repo system 0 testtags <inline>'];
  for (const [name, provides] of Object.entries(system)) {
    lines.push(`#>=Pkg: ${name} 1 1 ${arch}`, `#>=Prv: ${name} = 1-1`, ...provides.map(provide => `#>=Prv: ${provide}`));
  }
  lines.push(
    `repo available 0 solv ${basename(packageSolv)}`,
    `system ${arch} rpm system`,
    'job install name propr-desktop',
  );
  const testcase = join(workDir, `${arch}-${Object.keys(system).join('-')}.t`);
  writeFileSync(testcase, `${lines.join('\n')}\n`);
  const result = spawnSync('testsolv', [testcase], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  return `${result.stdout}${result.stderr}`;
}

describe('ProPR RPM native generation', () => {
  for (const [targetArch, rpmArch] of [['x64', 'x86_64'], ['arm64', 'aarch64']] as const) {
    test(`generates ${targetArch} metadata that libsolv resolves with libdrm or libdrm2`, {
      skip: missingRpmTools.length > 0 && `native RPM tools unavailable: ${missingRpmTools.join(', ')}`,
      timeout: 120_000,
    }, async () => {
      const root = mkdtempSync(join(tmpdir(), 'propr-rpm-maker-'));
      try {
        const maker = new ProprMakerRpm({
          options: {
            name: 'propr-desktop',
            productName: 'ProPR Desktop',
            version: '0.9.0',
            bin: 'propr-desktop',
            icon: desktopLinuxIcon,
            mimeType: ['x-scheme-handler/propr'],
          },
        });
        const [rpmPath] = await maker.make({
          dir: createPackagedAppFixture(root),
          makeDir: join(root, 'make'),
          appName: 'ProPR Desktop',
          targetPlatform: 'linux',
          targetArch,
          forgeConfig: {} as never,
          packageJSON: {},
        });
        assert.ok(rpmPath);

        assert.equal(run('rpm', ['-qp', '--queryformat', '%{ARCH}', rpmPath]), rpmArch);
        const requires = run('rpm', ['-qp', '--requires', rpmPath])
          .split('\n')
          .filter(requirement => requirement && !requirement.startsWith('rpmlib('))
          .sort();
        assert.deepEqual(requires, EXPECTED_RPM_REQUIRES);

        const sandbox = run('rpm', ['-qp', '--dump', rpmPath])
          .split('\n')
          .find(line => line.startsWith('/usr/lib/propr-desktop/chrome-sandbox '));
        assert.ok(sandbox, 'chrome-sandbox is missing from the RPM payload');
        const [, , , , mode, owner, group] = sandbox.split(' ');
        assert.deepEqual([mode, owner, group], ['0104755', 'root', 'root']);

        const packageSolv = join(root, 'propr-desktop.solv');
        writeFileSync(packageSolv, spawnSync('rpms2solv', [rpmPath]).stdout);

        const installed = `- propr-desktop-0.9.0-1.${rpmArch}`;
        assert.match(solve(root, packageSolv, rpmArch, { ...SUSE_SYSTEM, ...SUSE_LIBDRM2 }), new RegExp(installed));
        assert.match(solve(root, packageSolv, rpmArch, { ...FEDORA_SYSTEM, ...FEDORA_LIBDRM }), new RegExp(installed));
        assert.match(
          solve(root, packageSolv, rpmArch, SUSE_SYSTEM),
          /nothing provides \(libdrm or libdrm2\) needed by propr-desktop/,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
