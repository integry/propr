import { mkdtempSync, mkdirSync, realpathSync, rmSync, chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPackagedSmokeLaunch, PACKAGED_SMOKE_LAUNCH_MODES } from './packaged-smoke-plan.mjs';

test('native capture preserves every smoke mode, environment, and required marker', t => {
  // macOS temporary directories can have symlinked ancestors; valid evidence must be canonical.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crash-preflight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const evidence = join(root, 'evidence');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  for (const mode of PACKAGED_SMOKE_LAUNCH_MODES) {
    const options = {
      mode, platform: 'linux', userDataPath: profile,
      baseChildEnvironment: { PROPR_DESKTOP_SMOKE_TEST: '1' },
      firstOrigin: 'http://127.0.0.1:41001', secondOrigin: 'http://127.0.0.1:41002',
      dbusSessionAddress: 'unix:path=/tmp/synthetic-bus',
    };
    const ordinary = createPackagedSmokeLaunch(options);
    const captured = createPackagedSmokeLaunch({ ...options, nativeCrashDirectory: evidence });
    const diagnosticSwitch = `--propr-native-crash-directory=${evidence}`;
    assert.deepEqual(captured.launchArguments.filter(value => value !== diagnosticSwitch), ordinary.launchArguments);
    assert.equal(captured.launchArguments.filter(value => value === diagnosticSwitch).length, 1);
    assert.deepEqual(captured.childEnvironment, ordinary.childEnvironment);
    assert.deepEqual(captured.requiredMarkers, ordinary.requiredMarkers);
    assert.throws(() => createPackagedSmokeLaunch({ ...options, nativeCrashDirectory: 'relative' }));
    assert.throws(() => createPackagedSmokeLaunch({ ...options, platform: 'win32', nativeCrashDirectory: evidence }));
  }
});

test('crash capture preflight rejects invalid directories before launch', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crash-preflight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const evidence = join(root, 'evidence');
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(join(profile, 'nested'), { mode: 0o700 });
  symlinkSync(evidence, join(root, 'link'));
  symlinkSync(root, join(root, 'parent-link'));
  writeFileSync(join(root, 'file'), 'synthetic');
  const launch = directory => createPackagedSmokeLaunch({ mode: 'success', platform: 'linux',
    userDataPath: profile, baseChildEnvironment: {}, nativeCrashDirectory: directory });
  for (const directory of [join(root, 'missing'), join(root, 'file'), join(root, 'link'),
    join(root, 'parent-link', 'evidence'), `${evidence}/../evidence`, root, profile, join(profile, 'nested')]) {
    assert.throws(() => launch(directory), /Native crash capture directory preflight failed/);
  }
  chmodSync(evidence, 0o755);
  assert.throws(() => launch(evidence), /owned 0700/);
  chmodSync(evidence, 0o700);
  assert.doesNotThrow(() => launch(evidence));
  const uid = t.mock.method(process, 'getuid', () => -1);
  assert.throws(() => launch(evidence), /owned 0700/);
  uid.mock.restore();
});
