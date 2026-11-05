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

it('normalizes an older root at acquisition and rejects mode changes across awaited actions', async () => {
  const { mkdirSync, statSync } = await import('node:fs');
  const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-root-modes-')));
  const root = join(appData, 'local-runtime');
  mkdirSync(root);
  chmodSync(root, 0o755);
  const authority = RootDirectoryAuthority.open(root, appData);
  try {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    authority.validate();
    const { scaffoldStack } = await import('../../../packages/cli/src/commands/initStack.js');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await scaffoldStack({ root }, { persistStackRoot: async () => {} });
      authority.validate();
      assert.equal(statSync(root).mode & 0o777, 0o700);
    }
    const bound = bindRootOperations({
      isStackRunning: async () => { await Promise.resolve(); chmodSync(root, 0o755); return true; },
    } as unknown as SetupActions, authority);
    await assert.rejects(bound.isStackRunning(root), /no longer private/);
    chmodSync(root, 0o700);
    authority.validate();
  } finally { authority.close(); rmSync(appData, { recursive: true, force: true }); }
});

it('creates a first-use root before checks and validates startup across awaited boundaries', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-first-root-')));
  const root = join(appData, 'nested', 'local-runtime');
  assert.equal(existsSync(root), false);
  const authority = RootDirectoryAuthority.open(root, appData);
  let checks = false;
  const bound = bindRootOperations({
    runChecks: async () => {
      assert.equal(statSync(root).mode & 0o777, 0o700);
      checks = true;
      return { rootDir: root, anyFail: false, results: [] };
    },
    startStack: async () => { await Promise.resolve(); assert.equal(checks, true); },
  } as unknown as SetupActions, authority);
  try {
    await bound.runChecks({ root });
    await bound.startStack({ rootDir: root });
    authority.validate();
    for (const operation of ['startStack', 'replaceRunningStack'] as const) {
      const changed = bindRootOperations({
        [operation]: async () => { await Promise.resolve(); chmodSync(root, 0o755); },
      } as unknown as SetupActions, authority);
      await assert.rejects(changed[operation]!({ rootDir: root }), /no longer private/);
      chmodSync(root, 0o700);
    }
  } finally { authority.close(); rmSync(appData, { recursive: true, force: true }); }
});
