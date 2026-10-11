import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPackagedSmokeLaunch, PACKAGED_SMOKE_LAUNCH_MODES } from './packaged-smoke-plan.mjs';

test('native capture preserves every smoke mode, environment, and required marker', () => {
  for (const mode of PACKAGED_SMOKE_LAUNCH_MODES) {
    const options = {
      mode, platform: 'linux', userDataPath: '/tmp/propr-desktop-smoke-fixture',
      baseChildEnvironment: { PROPR_DESKTOP_SMOKE_TEST: '1' },
      firstOrigin: 'http://127.0.0.1:41001', secondOrigin: 'http://127.0.0.1:41002',
      dbusSessionAddress: 'unix:path=/tmp/synthetic-bus',
    };
    const ordinary = createPackagedSmokeLaunch(options);
    const captured = createPackagedSmokeLaunch({ ...options, nativeCrashDirectory: '/tmp/private-evidence' });
    const diagnosticSwitch = '--propr-native-crash-directory=/tmp/private-evidence';
    assert.deepEqual(captured.launchArguments.filter(value => value !== diagnosticSwitch), ordinary.launchArguments);
    assert.equal(captured.launchArguments.filter(value => value === diagnosticSwitch).length, 1);
    assert.deepEqual(captured.childEnvironment, ordinary.childEnvironment);
    assert.deepEqual(captured.requiredMarkers, ordinary.requiredMarkers);
    assert.throws(() => createPackagedSmokeLaunch({ ...options, nativeCrashDirectory: 'relative' }));
    assert.throws(() => createPackagedSmokeLaunch({ ...options, platform: 'win32', nativeCrashDirectory: '/tmp/private-evidence' }));
  }
});
