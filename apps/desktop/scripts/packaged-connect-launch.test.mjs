import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import {
  createPackagedConnectLaunchArguments,
  spawnPackagedConnectBinary,
} from './packaged-connect-launch.mjs';

describe('packaged Connect launch boundary', () => {
  test('passes the one effective Linux argv through the actual binary spawn', () => {
    const launchArguments = createPackagedConnectLaunchArguments({
      platform: 'linux',
      userDataPath: '/tmp/propr-connect-smoke',
    });
    let invocation;
    const child = {};
    assert.equal(spawnPackagedConnectBinary({
      binaryPath: '/package/propr-desktop',
      launchArguments,
      options: { shell: false },
      spawn: (file, args, options) => {
        invocation = { file, args, options };
        return child;
      },
    }), child);
    assert.deepEqual(invocation, {
      file: '/package/propr-desktop',
      args: [
        '--disable-gpu',
        '--user-data-dir=/tmp/propr-connect-smoke',
        '--password-store=gnome-libsecret',
      ],
      options: { shell: false },
    });
    assert.equal(invocation.args, launchArguments);
  });

  test('does not add the Linux password-store selection on Darwin', () => {
    assert.deepEqual(createPackagedConnectLaunchArguments({
      platform: 'darwin',
      userDataPath: '/tmp/propr-connect-smoke',
    }), [
      '--disable-gpu',
      '--user-data-dir=/tmp/propr-connect-smoke',
    ]);
  });

  test('the lifecycle and real binary spawn share the derived argv source', async () => {
    const source = await readFile(new URL('./smoke-packaged-connect.mjs', import.meta.url), 'utf8');
    assert.match(source, /const launchArguments = createPackagedConnectLaunchArguments\(\{/u);
    assert.match(source, /spawnPackagedConnectBinary\(\{[\s\S]*?launchArguments: args,/u);
    assert.match(source, /runPackagedConnectLifecycle\(\{[\s\S]*?args: launchArguments,/u);
    assert.doesNotMatch(source, /spawn\(binaryPath, \['--disable-gpu'/u);
  });
});
