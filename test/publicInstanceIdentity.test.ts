import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConnectRootError,
  getOrCreatePublicInstanceIdentity as getCliIdentity,
  resolveOwnedConnectRoot,
} from '../packages/cli/src/connectIdentity.js';
import { getOrCreatePublicInstanceIdentity as getApiIdentity } from '../packages/api/publicInstanceIdentity.js';

test('public identity persists across CLI/API restart and changes with replaced stack data', () => {
  const root = mkdtempSync(join(tmpdir(), 'propr-public-identity-'));
  const data = join(root, 'data');
  mkdirSync(data);
  try {
    const first = getCliIdentity(data, () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    assert.equal(getApiIdentity(data, () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), first);
    assert.equal(getCliIdentity(data, () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'), first);

    rmSync(data, { recursive: true });
    mkdirSync(data);
    const replacement = getApiIdentity(data, () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    assert.notEqual(replacement, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Connect discovery accepts only an explicit non-symlink stack root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'propr-connect-root-'));
  const root = join(parent, 'stack');
  const alias = join(parent, 'stack-alias');
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, '.env'), 'PROPR_INSTANCE_ID=abc123\n', { mode: 0o600 });
  symlinkSync(root, alias, 'dir');
  try {
    assert.equal(resolveOwnedConnectRoot(root), root);
    assert.throws(() => resolveOwnedConnectRoot(undefined), ConnectRootError);
    assert.throws(() => resolveOwnedConnectRoot(alias), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
