import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPackagedConnectProfileIsolation, createPackagedConnectAccountConfirmation } from './packaged-connect-account-confirmation';

const endpoint = 'http://127.0.0.1:44123';
const account = { id: '2290', username: 'packaged-owner', avatarUrl: null };

test('synthetic Connect confirmation is single-use and required only in the pair process', async () => {
  const confirmation = createPackagedConnectAccountConfirmation(endpoint, 'pair');
  const signal = new AbortController().signal;
  assert.throws(() => confirmation.assertComplete());
  assert.equal(await confirmation.confirm(account, endpoint, signal), true);
  confirmation.assertComplete();
  assert.equal(await confirmation.confirm(account, endpoint, signal), false);
  const reprobe = createPackagedConnectAccountConfirmation(endpoint, 'reprobe');
  assert.equal(await reprobe.confirm(account, endpoint, signal), false);
  reprobe.assertComplete();
});

test('synthetic confirmation rejects another endpoint, account, avatar, and aborted pairing', async () => {
  const signal = new AbortController().signal;
  for (const [candidate, origin, candidateSignal] of [
    [{ ...account, id: '123' }, endpoint, signal],
    [{ ...account, username: 'another-user' }, endpoint, signal],
    [{ ...account, avatarUrl: 'https://avatars.githubusercontent.com/u/2290' }, endpoint, signal],
    [account, 'http://127.0.0.1:44124', signal],
    [account, 'https://real.example.test', signal],
    [account, endpoint, AbortSignal.abort()],
  ] as const) {
    const confirmation = createPackagedConnectAccountConfirmation(endpoint, 'pair');
    assert.equal(await confirmation.confirm(candidate, origin, candidateSignal), false);
    assert.throws(() => confirmation.assertComplete());
  }
  for (const origin of ['https://real.example.test', 'http://localhost:44123', 'http://127.0.0.1',
    `${endpoint}/path`, `${endpoint}?query=1`, 'http://user:password@127.0.0.1:44123']) {
    assert.throws(() => createPackagedConnectAccountConfirmation(origin, 'pair'));
  }
});


test('synthetic confirmation requires the runner store and rejects a real store or symlink', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'propr-desktop-connect-smoke-'));
  const configRoot = join(root, 'config');
  const userData = join(root, 'desktop-user-data');
  const ordinaryStore = join(root, 'ordinary-profile');
  try {
    await mkdir(configRoot);
    await mkdir(userData);
    await mkdir(ordinaryStore);
    assert.doesNotThrow(() => assertPackagedConnectProfileIsolation(configRoot, userData));
    assert.throws(() => assertPackagedConnectProfileIsolation(configRoot, ordinaryStore));
    assert.throws(() => assertPackagedConnectProfileIsolation(ordinaryStore, userData));
    await rm(userData, { recursive: true });
    // Junctions are available to ordinary Windows users; the journey itself is non-Windows.
    await symlink(ordinaryStore, userData, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertPackagedConnectProfileIsolation(configRoot, userData));
  } finally { await rm(root, { recursive: true, force: true }); }
});
