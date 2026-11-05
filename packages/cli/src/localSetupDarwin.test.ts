import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreatePublicInstanceIdentity, assertOwnedLocalSetupRoot } from './connectIdentity.js';

// Real Darwin descriptors and the packaged ACL broker: never mock the platform.
// The ordinary Linux identity suite independently exercises the API adapter.
test('native Darwin local setup preserves identity and refuses linked or replaceable authority', {
  skip: process.platform !== 'darwin' ? 'requires native macOS and its packaged authority helpers' : false,
}, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'propr-darwin-identity-')));
  try {
    chmodSync(root, 0o700);
    await assertOwnedLocalSetupRoot(root);
    const data = join(root, 'data');
    mkdirSync(data, { mode: 0o700 });
    const identity = await getOrCreatePublicInstanceIdentity(data);
    assert.equal(await getOrCreatePublicInstanceIdentity(data), identity);
    const file = join(data, 'public-instance-identity.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).publicInstanceIdentity, identity);
    renameSync(file, join(data, '.public-instance-identity.json.ready-v1'));
    assert.equal(await getOrCreatePublicInstanceIdentity(data), identity, 'interrupted publication resumes the same identity');
    symlinkSync(data, join(root, 'alias'));
    await assert.rejects(getOrCreatePublicInstanceIdentity(join(root, 'alias')));
    linkSync(file, join(root, 'extra-link'));
    await assert.rejects(getOrCreatePublicInstanceIdentity(data));
    unlinkSync(join(root, 'extra-link'));
    renameSync(file, join(data, 'identity-target'));
    symlinkSync(join(data, 'identity-target'), file);
    await assert.rejects(getOrCreatePublicInstanceIdentity(data), 'a symlink child must fail closed when openAt returns ELOOP');
    chmodSync(root, 0o777);
    await assert.rejects(assertOwnedLocalSetupRoot(root), /require mode 0700/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
