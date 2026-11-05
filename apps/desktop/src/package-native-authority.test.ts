import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import {
  copyPackagedNativeAuthority,
  PACKAGED_NATIVE_AUTHORITY_MODE,
} from './package-native-authority';

// Use the same ASAR implementation as Forge's packager, including its glob semantics.
const packagerRequire = createRequire(createRequire(import.meta.url).resolve('@electron/packager'));
const { createPackageWithOptions, statFile } = await import(packagerRequire.resolve('@electron/asar'));

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('packaged native authority permissions', () => {
  test('normalizes group-writable Linux and macOS inputs under a 0002 build umask', {
    skip: process.platform === 'win32',
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'propr-native-package-mode-'));
    const sourceRoot = join(root, 'source');
    const originalUmask = process.umask(0o002);
    try {
      for (const fixture of [
        { platform: 'linux', arch: 'x64', artifacts: ['directory-operations.node'] },
        {
          platform: 'darwin',
          arch: 'arm64',
          artifacts: ['directory-operations.node', 'connect-authority-broker'],
        },
      ]) {
        const platformArch = `${fixture.platform}-${fixture.arch}`;
        const resourcesPath = join(root, `resources-${platformArch}`);
        for (const name of fixture.artifacts) {
          const source = join(sourceRoot, platformArch, name);
          const generatedTarget = join(resourcesPath, '.vite/native/prebuilds', platformArch, name);
          mkdirSync(dirname(source), { recursive: true });
          mkdirSync(dirname(generatedTarget), { recursive: true });
          writeFileSync(source, `${platformArch}:${name}\n`, { mode: 0o777 });
          writeFileSync(generatedTarget, 'generated target\n', { mode: 0o777 });
          assert.equal(statSync(source).mode & 0o777, 0o775);
          assert.equal(statSync(generatedTarget).mode & 0o777, 0o775);
        }

        const targets = copyPackagedNativeAuthority({
          arch: fixture.arch,
          platform: fixture.platform,
          resourcesPath,
          sourceRoot,
        });

        assert.equal(targets.length, fixture.artifacts.length);
        for (const name of fixture.artifacts) {
          const source = join(sourceRoot, platformArch, name);
          const target = join(resourcesPath, '.vite/native/prebuilds', platformArch, name);
          assert.equal(statSync(target).mode & 0o777, PACKAGED_NATIVE_AUTHORITY_MODE);
          assert.equal(statSync(target).mode & 0o111, 0o111);
          assert.equal(digest(target), digest(source));
        }
      }
    } finally {
      process.umask(originalUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const arch of ['arm64', 'x64']) {
    test(`unpacks both Darwin ${arch} authority artifacts with the production ASAR options`, async () => {
      const { default: config } = await import('../forge.config');
      const options = config.packagerConfig?.asar;
      assert.ok(options && typeof options === 'object');
      const root = mkdtempSync(join(tmpdir(), 'propr-darwin-asar-'));
      try {
        const sourceRoot = join(root, 'source');
        const resourcesPath = join(root, 'app');
        const artifacts = ['directory-operations.node', 'connect-authority-broker'];
        for (const name of artifacts) {
          const source = join(sourceRoot, `darwin-${arch}`, name);
          mkdirSync(dirname(source), { recursive: true });
          writeFileSync(source, `darwin-${arch}:${name}`);
        }
        copyPackagedNativeAuthority({ platform: 'darwin', arch, resourcesPath, sourceRoot });
        const archive = join(root, 'app.asar');
        await createPackageWithOptions(resourcesPath, archive, options);
        for (const name of artifacts) {
          const relative = `.vite/native/prebuilds/darwin-${arch}/${name}`;
          const entry = statFile(archive, relative);
          assert.ok('unpacked' in entry && entry.unpacked, relative);
          assert.equal(digest(join(`${archive}.unpacked`, relative)), digest(join(sourceRoot, `darwin-${arch}`, name)));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('does not add native authority artifacts to Windows packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'propr-native-package-windows-'));
    try {
      assert.deepEqual(copyPackagedNativeAuthority({
        arch: 'x64',
        platform: 'win32',
        resourcesPath: join(root, 'resources'),
        sourceRoot: join(root, 'source'),
      }), []);
      assert.equal(existsSync(join(root, 'resources')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
