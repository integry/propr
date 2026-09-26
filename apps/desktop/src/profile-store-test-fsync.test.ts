import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DESKTOP_TEST_FSYNC_VARIABLE, applyDesktopTestFsyncPolicy } from './profile-store-test-fsync';

const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-fsync-policy-'));
const probePath = join(directory, 'probe');
await writeFile(probePath, 'probe');
const probe = await open(probePath, 'r');
const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void>; datasync(): Promise<void> };
await probe.close();
const original = { sync: prototype.sync, datasync: prototype.datasync };
let nativeCalls = 0;
prototype.sync = async function (this: unknown) { nativeCalls += 1; return original.sync.call(this); };
prototype.datasync = async function (this: unknown) { nativeCalls += 1; return original.datasync.call(this); };

after(async () => {
  prototype.sync = original.sync;
  prototype.datasync = original.datasync;
  await rm(directory, { recursive: true, force: true });
});

const flush = async (): Promise<void> => {
  // Writable on purpose: Windows refuses FlushFileBuffers on a read-only handle.
  const handle = await open(probePath, 'r+');
  try {
    await handle.sync();
    await handle.datasync();
  } finally {
    await handle.close();
  }
};

describe('desktop test fsync policy', () => {
  it('keeps native fsync unless the variable is exactly "off"', async () => {
    for (const env of [{}, { [DESKTOP_TEST_FSYNC_VARIABLE]: '' }, { [DESKTOP_TEST_FSYNC_VARIABLE]: 'native' }]) {
      const policy = await applyDesktopTestFsyncPolicy(env);
      assert.equal(policy.mode, 'native');
      nativeCalls = 0;
      await flush();
      assert.equal(nativeCalls, 2, JSON.stringify(env));
      assert.equal(await policy.withNativeFsync(async () => 'ran'), 'ran');
    }
  });

  it('replaces fsync with a no-op for the process and restores it inside withNativeFsync', async () => {
    const policy = await applyDesktopTestFsyncPolicy({ [DESKTOP_TEST_FSYNC_VARIABLE]: 'off' });
    assert.equal(policy.mode, 'off');
    nativeCalls = 0;
    await flush();
    assert.equal(nativeCalls, 0, 'fsync must not reach the native implementation');

    await assert.rejects(policy.withNativeFsync(async () => {
      await flush();
      throw new Error('inner failure');
    }), /inner failure/);
    assert.equal(nativeCalls, 2, 'the native implementation runs inside withNativeFsync');

    nativeCalls = 0;
    await flush();
    assert.equal(nativeCalls, 0, 'the no-op policy is restored after withNativeFsync, also on failure');
  });
});
