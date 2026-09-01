import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import {
  assertPackagedLayout,
  assertPackagedNativeWindowSizing,
  createPrivateSmokeProfile,
  createSmokeChildEnvironment,
  MINIMUM_WINDOW_SIZE,
  removePrivateSmokeProfile,
  validateWindowsSystemRoot,
} from './packaged-smoke-support.mjs';
import {
  CONNECT_DEEP_LINK,
  createPackagedSmokeLaunch,
  PACKAGED_SMOKE_LAUNCH_MODES,
  TRANSPORT_SMOKE_ENVIRONMENT_NAMES,
} from './packaged-smoke-plan.mjs';

const assertPackagedSpawnOptions = (source) => {
  const normalizedSource = source.replace(/\r\n?/g, '\n');
  assert.match(normalizedSource, /cwd: smokeProfile\.root,\n\s+env: childEnvironment,\n\s+shell: false,/);
};

const layoutFixture = ({ windowWidth, windowHeight, workWidth, workHeight }) => {
  const viewport = { width: windowWidth - 16, height: windowHeight - 65 };
  const cardWidth = 560;
  const cardLeft = (viewport.width - cardWidth) / 2;
  const control = (top, bottom) => ({
    top,
    bottom,
    height: bottom - top,
    left: cardLeft + 24,
    right: cardLeft + cardWidth - 24,
  });
  return {
    windowBounds: { width: windowWidth, height: windowHeight },
    minimumSize: {
      width: Math.min(MINIMUM_WINDOW_SIZE.width, workWidth),
      height: Math.min(MINIMUM_WINDOW_SIZE.height, workHeight),
    },
    contentBounds: viewport,
    viewport,
    screen: { width: Math.max(workWidth, windowWidth), height: Math.max(workHeight, windowHeight) },
    workArea: { width: workWidth, height: workHeight },
    titlebar: { top: 0, bottom: 60 },
    logo: { top: 20, bottom: 40, height: 20, width: 72 },
    card: {
      top: 80,
      bottom: viewport.height - 12,
      left: cardLeft,
      right: cardLeft + cardWidth,
    },
    connectionName: control(110, 150),
    apiUrl: control(180, 220),
    apiHelp: control(226, 240),
    submit: control(256, 296),
    footer: control(316, 336),
  };
};

describe('packaged smoke native window layout', () => {
  for (const scenario of [
    { name: 'preferred size', windowWidth: 1280, windowHeight: 820, workWidth: 1920, workHeight: 1040 },
    { name: '1024x720-clamped size', windowWidth: 1024, windowHeight: 720, workWidth: 1024, workHeight: 720 },
    { name: 'configured minimum size', windowWidth: 880, windowHeight: 620, workWidth: 880, workHeight: 620 },
    { name: 'undersized work area', windowWidth: 800, windowHeight: 560, workWidth: 800, workHeight: 560 },
  ]) {
    test(`accepts the ${scenario.name} while retaining responsive containment`, () => {
      assert.doesNotThrow(() => assertPackagedLayout(layoutFixture(scenario)));
    });
  }

  test('rejects an unclamped window or a viewport inconsistent with native content chrome', () => {
    const unclamped = layoutFixture({
      windowWidth: 1280,
      windowHeight: 820,
      workWidth: 1024,
      workHeight: 720,
    });
    assert.throws(() => assertPackagedLayout(unclamped), /preferred size clamped/);

    const inconsistentViewport = layoutFixture({
      windowWidth: 1024,
      windowHeight: 720,
      workWidth: 1024,
      workHeight: 720,
    });
    inconsistentViewport.viewport = { width: 1007, height: 655 };
    assert.throws(() => assertPackagedLayout(inconsistentViewport), /actual native content bounds/);
  });

  test('accepts actual reduced native sizing only when both minimum constraints are exercised', () => {
    assert.doesNotThrow(() => assertPackagedNativeWindowSizing({
      displayWorkArea: { x: -1600, y: 0, width: 1600, height: 900 },
      workArea: { x: -1200, y: 170, width: 800, height: 560 },
      windowBounds: { x: -1200, y: 170, width: 800, height: 560 },
      minimumSize: { width: 800, height: 560 },
    }, { requireReducedWorkArea: true }));
    assert.throws(() => assertPackagedNativeWindowSizing({
      displayWorkArea: { x: 0, y: 0, width: 1920, height: 1040 },
      workArea: { x: 520, y: 240, width: 880, height: 560 },
      windowBounds: { x: 520, y: 240, width: 880, height: 560 },
      minimumSize: { width: 880, height: 560 },
    }, { requireReducedWorkArea: true }), /both clamped minimum dimensions/);
  });
});

describe('packaged smoke child environment', () => {
  test('defines four isolated launches with exact per-mode environment, argv, and marker contracts', () => {
    const firstOrigin = 'http://127.0.0.1:41001';
    const secondOrigin = 'http://127.0.0.1:41002';
    const dbusSessionAddress = 'unix:path=/run/user/1000/bus';
    const connectDeepLink = 'propr://connect?api=https%3A%2F%2Fconnect.propr.dev';
    assert.equal(CONNECT_DEEP_LINK, connectDeepLink);
    assert.deepEqual(TRANSPORT_SMOKE_ENVIRONMENT_NAMES, [
      'PROPR_DESKTOP_SMOKE_FIRST_ORIGIN',
      'PROPR_DESKTOP_SMOKE_SECOND_ORIGIN',
      'PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE',
    ]);
    const launches = PACKAGED_SMOKE_LAUNCH_MODES.map((mode, index) => {
      const userDataPath = `/private/propr-desktop-smoke-${mode}`;
      const baseChildEnvironment = {
        HOME: `${userDataPath}/home`,
        PROPR_DESKTOP_SMOKE_PROFILE_API_URL: `http://127.0.0.1:${42000 + index}`,
        PROPR_DESKTOP_SMOKE_TEST: '1',
      };
      return createPackagedSmokeLaunch({
        mode,
        platform: 'linux',
        userDataPath,
        baseChildEnvironment,
        firstOrigin,
        secondOrigin,
        dbusSessionAddress,
      });
    });

    assert.deepEqual(launches.map(launch => launch.mode), [
      'release-guard', 'success', 'retry', 'forced-timeout',
    ]);
    for (const [index, launch] of launches.entries()) {
      const mode = PACKAGED_SMOKE_LAUNCH_MODES[index];
      const userDataPath = `/private/propr-desktop-smoke-${mode}`;
      const baseEnvironment = {
        HOME: `${userDataPath}/home`,
        PROPR_DESKTOP_SMOKE_PROFILE_API_URL: `http://127.0.0.1:${42000 + index}`,
        PROPR_DESKTOP_SMOKE_TEST: '1',
      };
      const commonMarkers = [
        'desktop.renderer.ready',
        '"preloadBridgeExposed":true',
      ];
      const layoutMarkers = [
        'desktop.renderer.mvp_flows.ready',
        'desktop.renderer.layout.ready',
        'desktop.native.reduced_window.ready',
      ];
      if (mode === 'release-guard') {
        assert.equal(launch.transport, false);
        assert.deepEqual(launch.launchArguments, [
          '--disable-gpu',
          '--propr-smoke-test',
          `--user-data-dir=${userDataPath}`,
          connectDeepLink,
        ]);
        assert.deepEqual(launch.childEnvironment, baseEnvironment);
        assert.deepEqual(launch.requiredMarkers, [
          ...commonMarkers,
          'desktop.renderer.profile_api.ready',
          ...layoutMarkers,
        ]);
        for (const name of TRANSPORT_SMOKE_ENVIRONMENT_NAMES) {
          assert.equal(Object.hasOwn(launch.childEnvironment, name), false);
        }
      } else {
        assert.equal(launch.transport, true);
        assert.deepEqual(launch.launchArguments, [
          '--disable-gpu',
          '--propr-smoke-test',
          `--user-data-dir=${userDataPath}`,
          '--password-store=gnome-libsecret',
        ]);
        assert.deepEqual(launch.childEnvironment, {
          ...baseEnvironment,
          DBUS_SESSION_BUS_ADDRESS: dbusSessionAddress,
          PROPR_DESKTOP_SMOKE_FIRST_ORIGIN: firstOrigin,
          PROPR_DESKTOP_SMOKE_SECOND_ORIGIN: secondOrigin,
          PROPR_DESKTOP_SMOKE_SHUTDOWN_MODE: mode,
        });
        assert.deepEqual(launch.requiredMarkers, [
          ...commonMarkers,
          'desktop.renderer.transport_smoke.ready',
          ...layoutMarkers,
        ]);
        assert.equal(launch.launchArguments.includes(connectDeepLink), false);
      }
    }
  });

  test('passes only platform launch inputs and private profile paths from a hostile parent', async () => {
    const parent = await createPrivateSmokeProfile(tmpdir());
    const xAuthority = join(parent.root, 'Xauthority');
    await writeFile(xAuthority, 'xvfb-cookie');
    if (process.platform !== 'win32') await chmod(xAuthority, 0o600);
    const hostileValues = new Set([
      'hostile-certificate-file',
      'hostile-signing-password',
      'hostile-private-key',
      'hostile-github-token',
      'hostile-github-app-token',
      'hostile-azure-client',
      'hostile-azure-secret',
      'hostile-unrelated-propr-value',
      'hostile-path',
    ]);
    const hostileParent = {
      WINDOWS_CERTIFICATE_FILE: 'hostile-certificate-file',
      CSC_KEY_PASSWORD: 'hostile-signing-password',
      PROPR_DESKTOP_UPDATE_PRIVATE_KEY: 'hostile-private-key',
      GITHUB_TOKEN: 'hostile-github-token',
      GH_TOKEN: 'hostile-github-app-token',
      AZURE_CLIENT_ID: 'hostile-azure-client',
      AZURE_CLIENT_SECRET: 'hostile-azure-secret',
      PROPR_DESKTOP_UNRELATED: 'hostile-unrelated-propr-value',
      PATH: 'hostile-path',
      DISPLAY: ':77',
      XAUTHORITY: xAuthority,
      SystemRoot: process.env.SystemRoot,
    };

    try {
      assert.equal(parent.userData, parent.root);
      assert.match(basename(parent.userData), /^propr-desktop-smoke-[A-Za-z0-9]+$/);
      const environment = await createSmokeChildEnvironment({
        profile: parent,
        profileApiUrl: 'http://127.0.0.1:43123',
        parentEnvironment: hostileParent,
      });
      const expectedKeys = process.platform === 'win32'
        ? ['APPDATA', 'LOCALAPPDATA', 'PROPR_DESKTOP_SMOKE_PROFILE_API_URL', 'PROPR_DESKTOP_SMOKE_TEST', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE']
        : process.platform === 'linux'
          ? ['DISPLAY', 'HOME', 'PROPR_DESKTOP_SMOKE_PROFILE_API_URL', 'PROPR_DESKTOP_SMOKE_TEST', 'TEMP', 'TMP', 'TMPDIR', 'XAUTHORITY', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']
          : ['HOME', 'PROPR_DESKTOP_SMOKE_PROFILE_API_URL', 'PROPR_DESKTOP_SMOKE_TEST', 'TEMP', 'TMP', 'TMPDIR'];
      assert.deepEqual(Object.keys(environment), expectedKeys);
      assert.equal(environment.PROPR_DESKTOP_SMOKE_TEST, '1');
      for (const [name, value] of Object.entries(environment)) {
        assert.ok(!hostileValues.has(value), `${name} inherited a hostile parent value`);
        if (!['DISPLAY', 'XAUTHORITY', 'SystemRoot', 'PROPR_DESKTOP_SMOKE_PROFILE_API_URL', 'PROPR_DESKTOP_SMOKE_TEST'].includes(name)) {
          const pathFromRoot = relative(parent.root, value);
          assert.ok(pathFromRoot && !pathFromRoot.startsWith('..'), `${name} escaped the private smoke root`);
        }
      }
      for (const name of [
        'WINDOWS_CERTIFICATE_FILE',
        'CSC_KEY_PASSWORD',
        'PROPR_DESKTOP_UPDATE_PRIVATE_KEY',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET',
        'PROPR_DESKTOP_UNRELATED',
        'PATH',
      ]) {
        assert.equal(Object.hasOwn(environment, name), false);
      }
    } finally {
      await removePrivateSmokeProfile(parent);
    }
  });

  test('keeps cleanup bounded to the generated profile root', async () => {
    const outer = await createPrivateSmokeProfile(tmpdir());
    const sibling = join(outer.root, 'cleanup-must-not-touch.txt');
    await writeFile(sibling, 'retained');
    const nested = await createPrivateSmokeProfile(outer.root);
    await removePrivateSmokeProfile(nested);
    assert.equal(await readFile(sibling, 'utf8'), 'retained');
    await removePrivateSmokeProfile(outer);
  });

  test('accepts only a normalized absolute Windows SystemRoot directory', async () => {
    const directoryStats = { isDirectory: () => true, isSymbolicLink: () => false };
    const inspectedPaths = [];
    const inspectDirectory = async value => {
      inspectedPaths.push(value);
      return directoryStats;
    };
    const validRoots = [
      String.raw`C:\Windows`,
      String.raw`z:\Windows\System32`,
      String.raw`D:\Program Files\Windows`,
      `C:\\${'a'.repeat(257)}`,
    ];
    for (const value of validRoots) {
      assert.equal(await validateWindowsSystemRoot(value, inspectDirectory), value);
    }
    assert.deepEqual(inspectedPaths, validRoots);

    const repeatedDotPath = `C:\\${'.\\'.repeat(128)}.`;
    assert.equal(repeatedDotPath.length, 260);
    const invalidRoots = [
      repeatedDotPath,
      String.raw`C:\Windows\\System32`,
      `${String.raw`C:\Windows`}\\`,
      String.raw`C:\Windows/System32`,
      `C:\\Windows\0System32`,
      'Windows',
      String.raw`C:\Windows\.\System32`,
      String.raw`C:\Windows\..\secrets`,
      String.raw`\\server\share`,
      String.raw`1:\Windows`,
      String.raw`é:\Windows`,
      `C:\\${'a'.repeat(258)}`,
    ];
    let invalidInspectionCount = 0;
    for (const value of invalidRoots) {
      await assert.rejects(
        validateWindowsSystemRoot(value, async () => {
          invalidInspectionCount += 1;
          return directoryStats;
        }),
        {
          name: 'Error',
          message: 'Packaged smoke Windows system root is invalid',
        },
      );
    }
    assert.equal(invalidInspectionCount, 0);

    await assert.rejects(
      validateWindowsSystemRoot(String.raw`C:\Windows`, async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => true,
      })),
      /system root is invalid/,
    );
  });

  test('contains no parent environment spread, enumeration, denylist, PATH, or shell launch', async () => {
    const smokeSource = await readFile(new URL('./smoke-packaged.mjs', import.meta.url), 'utf8');
    const supportSource = await readFile(new URL('./packaged-smoke-support.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(smokeSource, /\.\.\.process\.env|Object\.(?:keys|values|entries)\(process\.env\)/);
    assert.doesNotMatch(supportSource, /Object\.(?:keys|values|entries)\(parentEnvironment\)|\bPATH\b/);
    assertPackagedSpawnOptions(smokeSource);
    assert.doesNotMatch(smokeSource, /env:\s*\{[\s\S]*process\.env/);
  });

  test('requires the adjacent packaged spawn options with LF or CRLF source', () => {
    const options = [
      '    cwd: smokeProfile.root,',
      '    env: childEnvironment,',
      '    shell: false,',
    ];
    assert.doesNotThrow(() => assertPackagedSpawnOptions(options.join('\n')));
    assert.doesNotThrow(() => assertPackagedSpawnOptions(options.join('\r\n')));

    for (const invalidOptions of [
      options.slice(1),
      [options[0], options[2]],
      options.slice(0, 2),
      [options[1], options[0], options[2]],
      [options[0], options[2], options[1]],
      ['    cwd: process.cwd(),', options[1], options[2]],
      [options[0], '    env: process.env,', options[2]],
      [options[0], options[1], '    shell: true,'],
    ]) {
      assert.throws(() => assertPackagedSpawnOptions(invalidOptions.join('\n')));
    }
  });
});
