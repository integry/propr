import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createPackageWithOptions, extractFile } from '@electron/asar';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerZIP } from '@electron-forge/maker-zip';
import { LINUX_DIRECTORY_OPERATION_SHA256, verifyDirectoryOperationArtifact } from '../../../packages/cli/src/utils/directoryDescriptor';
import { copyPackagedNativeAuthority } from './package-native-authority';
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

// These are real maker outputs with real pinned ELF addons, not just staging
// assertions. Keep independent of libsolv so missing solver tools cannot hide
// a payload integrity regression.
describe('Linux package native payload preservation', () => {
  for (const kind of ['rpm', 'deb', 'zip'] as const) {
    // RPM's brp-strip silently does nothing without `file`; require it so the
    // native-build regression would fail under the original spec.
    const required = kind === 'rpm' ? ['rpmbuild', 'rpm2cpio', 'cpio', 'file', 'strip']
      : kind === 'deb' ? ['dpkg-deb', 'fakeroot'] : ['zip', 'unzip'];
    const missing = required.filter(tool => spawnSync(tool, ['--version'], { stdio: 'ignore' }).error);
    for (const targetArch of ['x64', 'arm64'] as const) {
      test(`${kind} ${targetArch} preserves pinned bytes and supports host identity publication`, {
        skip: process.platform !== 'linux' ? 'Linux packaging required'
          : missing.length > 0 && `packaging tools unavailable: ${missing.join(', ')}`,
        timeout: 120_000,
      }, async t => {
        const root = mkdtempSync(join(tmpdir(), 'propr-native-payload-'));
        try {
          const appDir = createPackagedAppFixture(root);
          const resources = join(appDir, 'resources');
          const nativeRoot = fileURLToPath(new URL('../../../packages/cli/native/prebuilds', import.meta.url));
          copyPackagedNativeAuthority({
            arch: targetArch, platform: 'linux', sourceRoot: nativeRoot,
            resourcesPath: join(resources, 'app'),
          });
          // Bundle the production CLI path alongside the unpacked addon. Using
          // an app.asar logical path exercises the physical-path remapping and
          // runtime hash/type/ancestry checks, with no loader override or mock.
          const probeRelative = 'resources/app.asar/.vite/build/identity-probe.mjs';
          await build({
            stdin: {
              resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
              contents: `
                import assert from 'node:assert/strict';
                import { closeSync, constants, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
                import { join } from 'node:path';
                import { getOrCreatePublicInstanceIdentity } from './packages/cli/src/connectIdentity.ts';
                import { renameAt } from './packages/cli/src/utils/directoryDescriptor.ts';
                assert.notEqual(process.getuid(), 0, 'identity acceptance must run as a normal user');
                const data = join(process.argv[2], 'data');
                const identity = await getOrCreatePublicInstanceIdentity(data);
                assert.equal(await getOrCreatePublicInstanceIdentity(data), identity);
                for (const path of [process.argv[2], data]) {
                  const info = lstatSync(path);
                  assert.equal(info.uid, process.getuid());
                  assert.equal(info.mode & 0o777, 0o700);
                }
                const file = join(data, 'public-instance-identity.json');
                assert.equal(JSON.parse(readFileSync(file, 'utf8')).publicInstanceIdentity, identity);
                const info = lstatSync(file);
                assert.equal(info.uid, process.getuid());
                assert.equal(info.mode & 0o777, 0o644);
                assert.equal(info.nlink, 1);
                // Directly prove native no-replace semantics, too.
                writeFileSync(join(data, 'source'), 'source');
                writeFileSync(join(data, 'destination'), 'destination');
                const fd = openSync(data, constants.O_RDONLY | constants.O_DIRECTORY);
                try { assert.throws(() => renameAt(fd, 'source', 'destination'), { code: 'EEXIST' }); }
                finally { closeSync(fd); }
                assert.equal(readFileSync(join(data, 'source'), 'utf8'), 'source');
                assert.equal(readFileSync(join(data, 'destination'), 'utf8'), 'destination');
                console.log(identity);
              `,
            },
            outfile: join(resources, 'app/.vite/build/identity-probe.mjs'),
            bundle: true, platform: 'node', format: 'esm', target: 'node22',
          });
          await createPackageWithOptions(join(resources, 'app'), join(resources, 'app.asar'), {
            unpack: '**/.vite/native/prebuilds/**',
          });
          rmSync(join(resources, 'app'), { recursive: true, force: true });
          const options = { options: {
            name: 'propr-desktop', productName: 'ProPR Desktop', version: '0.9.0',
            bin: 'propr-desktop', icon: desktopLinuxIcon,
          } };
          const maker = kind === 'rpm' ? new ProprMakerRpm(options)
            : kind === 'deb' ? new MakerDeb(options) : new MakerZIP({});
          const [artifact] = await maker.make({
            dir: appDir, makeDir: join(root, 'make'), appName: 'ProPR Desktop',
            targetPlatform: 'linux', targetArch, forgeConfig: {} as never,
            packageJSON: { version: '0.9.0' },
          });
          const extracted = join(root, 'extracted');
          mkdirSync(extracted);
          if (kind === 'rpm') {
            const archive = spawnSync('rpm2cpio', [artifact], { maxBuffer: 16 * 1024 * 1024 });
            assert.equal(archive.status, 0, String(archive.stderr));
            const extraction = spawnSync('cpio', ['-idm', '--quiet', '--no-absolute-filenames'], {
              cwd: extracted, input: archive.stdout, encoding: 'utf8',
            });
            assert.equal(extraction.status, 0, extraction.stderr);
          } else if (kind === 'deb') {
            run('dpkg-deb', ['-x', artifact, extracted]);
          } else {
            run('unzip', ['-q', artifact, '-d', extracted]);
          }
          const payload = kind === 'zip' ? join(extracted, basename(appDir)) : join(extracted, 'usr/lib/propr-desktop');
          const addon = join(payload, 'resources/app.asar.unpacked/.vite/native/prebuilds',
            `linux-${targetArch}`, 'directory-operations.node');
          verifyDirectoryOperationArtifact(addon, LINUX_DIRECTORY_OPERATION_SHA256[targetArch], targetArch);
          assert.deepEqual(readFileSync(addon), readFileSync(join(nativeRoot, `linux-${targetArch}`, 'directory-operations.node')));
          t.diagnostic(`${kind} linux-${targetArch} payload SHA256 ${LINUX_DIRECTORY_OPERATION_SHA256[targetArch]}`);
          // Remove staging before execution: a source-tree fallback cannot make
          // this pass. Two fresh processes prove durable identity persistence.
          rmSync(appDir, { recursive: true, force: true });
          if (targetArch !== process.arch || process.getuid?.() === 0) {
            t.diagnostic(`Native execution NOT performed: requires non-root Linux ${targetArch}; host is ${process.arch}, uid ${process.getuid?.()}`);
          } else {
            const stack = join(root, 'stack');
            mkdirSync(stack, { mode: 0o700 });
            // Node does not read ASARs. Extract only the bundled JS to its
            // logical location; leave the actual unpacked native payload intact.
            const asar = join(payload, 'resources/app.asar');
            const code = extractFile(asar, '.vite/build/identity-probe.mjs');
            rmSync(asar);
            const probe = join(payload, probeRelative);
            mkdirSync(dirname(probe), { recursive: true });
            writeFileSync(probe, code);
            const first = run(process.execPath, [probe, stack]);
            assert.match(first.trim(), /^[0-9a-f-]{36}$/);
            assert.equal(run(process.execPath, [probe, stack]), first);
            t.diagnostic(`Native publication and fresh-process persistence passed as uid ${process.getuid?.()}`);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
});
