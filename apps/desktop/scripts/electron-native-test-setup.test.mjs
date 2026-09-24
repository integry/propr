import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

describe('native Electron test setup', () => {
  it('keeps native probe modules free of eager Electron resolution', async () => {
    const probeSources = await Promise.all([
      'electron-fixture-runner.mjs',
      'electron-frame-semantics.test.mjs',
      'electron-pairing-zstd.test.mjs',
    ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));

    for (const source of probeSources) {
      assert.doesNotMatch(source, /['"]electron['"]/u);
    }
  });

  it('does not resolve Electron for an unsupported platform', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      linuxOnly: true,
      platform: 'darwin',
      resolveElectron: () => { resolutions += 1; },
      unsupportedPlatformReason: 'unsupported',
    });

    assert.deepEqual(setup, { skipReason: 'unsupported' });
    assert.equal(resolutions, 0);
  });

  it('does not resolve Electron for a headless Linux worker', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      environment: { PATH: '/missing' },
      findExecutable: () => undefined,
      headlessReason: 'headless',
      platform: 'linux',
      resolveElectron: () => { resolutions += 1; },
    });

    assert.deepEqual(setup, { skipReason: 'headless' });
    assert.equal(resolutions, 0);
  });

  it('uses Chromium headless mode only when a session-only probe opts in', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      allowHeadlessLinux: true,
      environment: { PATH: '/missing' },
      findExecutable: () => undefined,
      platform: 'linux',
      probeLaunch: () => undefined,
      resolveElectron: () => {
        resolutions += 1;
        return '/electron';
      },
    });

    assert.deepEqual(setup, {
      electronExecutable: '/electron',
      headlessLinux: true,
      xvfbRun: undefined,
    });
    assert.equal(resolutions, 1);
  });

  it('resolves Electron once for a supported native worker', () => {
    let resolutions = 0;
    const setup = prepareNativeElectronTest({
      environment: {},
      findExecutable: () => assert.fail('macOS must not look for xvfb-run'),
      platform: 'darwin',
      probeLaunch: () => undefined,
      resolveElectron: () => {
        resolutions += 1;
        return '/electron';
      },
    });

    assert.deepEqual(setup, {
      electronExecutable: '/electron',
      xvfbRun: undefined,
    });
    assert.equal(resolutions, 1);
  });

  it('preserves xvfb-run for a supported headless Linux worker', () => {
    const probes = [];
    const setup = prepareNativeElectronTest({
      environment: { PATH: '/tools' },
      findExecutable: () => '/tools/xvfb-run',
      platform: 'linux',
      probeLaunch: probe => {
        probes.push(probe);
        return undefined;
      },
      resolveElectron: () => '/electron',
    });

    assert.deepEqual(setup, {
      electronExecutable: '/electron',
      xvfbRun: '/tools/xvfb-run',
    });
    assert.deepEqual(probes, [{
      electronExecutable: '/electron',
      platform: 'linux',
      xvfbRun: '/tools/xvfb-run',
    }]);
  });

  it('skips when the resolved Electron binary cannot start on the worker', () => {
    const setup = prepareNativeElectronTest({
      environment: { PATH: '/tools' },
      findExecutable: () => '/tools/xvfb-run',
      platform: 'linux',
      probeLaunch: () => 'Electron cannot start on this worker (exit 127)',
      resolveElectron: () => '/electron',
    });

    assert.deepEqual(setup, {
      skipReason: 'Electron cannot start on this worker (exit 127)',
    });
  });

  it('skips a headless session-only probe when Electron cannot start', () => {
    const probes = [];
    const setup = prepareNativeElectronTest({
      allowHeadlessLinux: true,
      environment: { PATH: '/missing' },
      findExecutable: () => undefined,
      platform: 'linux',
      probeLaunch: probe => {
        probes.push(probe);
        return 'Electron cannot start on this worker (exit 127)';
      },
      resolveElectron: () => '/electron',
    });

    assert.deepEqual(setup, {
      skipReason: 'Electron cannot start on this worker (exit 127)',
    });
    assert.deepEqual(probes, [{
      electronExecutable: '/electron',
      platform: 'linux',
      xvfbRun: undefined,
    }]);
  });

  it('fails instead of skipping when the worker is required to launch Electron', () => {
    const required = { PATH: '/tools', PROPR_REQUIRE_NATIVE_ELECTRON: '1' };
    assert.throws(() => prepareNativeElectronTest({
      environment: required,
      findExecutable: () => '/tools/xvfb-run',
      platform: 'linux',
      probeLaunch: () => 'Electron cannot start on this worker (exit 127)',
      resolveElectron: () => '/electron',
    }), /PROPR_REQUIRE_NATIVE_ELECTRON=1 but Electron cannot start on this worker \(exit 127\)/);
    assert.throws(() => prepareNativeElectronTest({
      allowHeadlessLinux: true,
      environment: { ...required, PATH: '/missing' },
      findExecutable: () => undefined,
      platform: 'linux',
      probeLaunch: () => 'Electron cannot start on this worker (exit 127)',
      resolveElectron: () => '/electron',
    }), /PROPR_REQUIRE_NATIVE_ELECTRON=1 but Electron cannot start/);
    assert.throws(() => prepareNativeElectronTest({
      environment: { ...required, PATH: '/missing' },
      findExecutable: () => undefined,
      platform: 'linux',
      resolveElectron: () => assert.fail('headless workers must not resolve Electron'),
    }), /PROPR_REQUIRE_NATIVE_ELECTRON=1 but Electron needs DISPLAY or xvfb-run on Linux/);
    // Platform scoping is not a worker defect and still skips.
    assert.deepEqual(prepareNativeElectronTest({
      environment: required,
      linuxOnly: true,
      platform: 'darwin',
    }), { skipReason: 'This native Electron probe is Linux-specific' });
    assert.deepEqual(prepareNativeElectronTest({
      environment: { ...required, PROPR_REQUIRE_NATIVE_ELECTRON: '0' },
      findExecutable: () => '/tools/xvfb-run',
      platform: 'linux',
      probeLaunch: () => 'Electron cannot start on this worker (exit 127)',
      resolveElectron: () => '/electron',
    }), { skipReason: 'Electron cannot start on this worker (exit 127)' });
  });

  it('runs one Electron preflight before starting parallel test workers', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const testCommand = packageJson.scripts.test;
    const preflight = 'node scripts/electron-native-test-preflight.mjs';
    const workers = 'tsx --test';

    assert.equal(testCommand.split(preflight).length - 1, 1);
    assert.ok(testCommand.indexOf(preflight) < testCommand.indexOf(workers));
    assert.match(testCommand, /^node scripts\/electron-native-test-preflight\.mjs && tsx --test /u);
  });
});
