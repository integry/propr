import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { SetupActions } from '@propr/local-setup';
import { bindRootOperations, RootDirectoryAuthority, SetupFilesystemCapabilities } from './setup-capabilities';

describe('desktop setup root action binding', () => {
  it('preserves synchronous results while validating asynchronous results', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-capabilities-')));
    chmodSync(appData, 0o700);
    const root = join(appData, 'local-runtime');
    const authority = RootDirectoryAuthority.open(root, appData);
    const stackInit = { initialized: false, rootDir: root };
    const actions = {
      inspectStackInit: () => stackInit,
      isStackRunning: async () => true,
    } as unknown as SetupActions;
    const bound = bindRootOperations(actions, authority);

    try {
      const synchronous = bound.inspectStackInit(root);
      assert.strictEqual(synchronous, stackInit);
      assert.equal(synchronous instanceof Promise, false);

      const asynchronous = bound.isStackRunning(root);
      assert.ok(asynchronous instanceof Promise);
      assert.equal(await asynchronous, true);
    } finally {
      authority.close();
      rmSync(appData, { recursive: true, force: true });
    }
  });
});

describe('desktop setup private-key capability', () => {
  it('rejects a selected key that grows beyond the bound on the same inode before consumption', async () => {
    const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-setup-key-capability-')));
    chmodSync(appData, 0o700);
    const key = join(appData, 'github-app.pem');
    writeFileSync(key, 'fixture-key', { mode: 0o600 });
    const capabilities = new SetupFilesystemCapabilities();

    try {
      const selected = await capabilities.issue('session', key);
      appendFileSync(key, Buffer.alloc(1024 * 1024));
      await assert.rejects(
        capabilities.consume(selected.capability, 'session', join(appData, 'keys')),
        /no longer approved|no larger than 1 MiB/,
      );
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
