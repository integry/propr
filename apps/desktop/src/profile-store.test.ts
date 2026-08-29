import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ProfileStore, type EncryptionProvider } from './profile-store';

const temporaryDirectories: string[] = [];

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-desktop-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

const encryption = (available = true, backend = 'keychain'): EncryptionProvider => ({
  isEncryptionAvailable: () => available,
  backend: () => backend,
  encrypt: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64url'), 'utf8'),
  decrypt: value => Buffer.from(value.toString(), 'base64url').toString('utf8'),
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('desktop profile store', () => {
  it('persists validated profiles and active selection', async () => {
    const directory = await createDirectory();
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({ label: ' Local ', apiBaseUrl: 'http://localhost:4000///' });
    const ipv6Profile = await store.save({ label: 'IPv6', apiBaseUrl: 'http://[::1]:4000/' });
    await store.setActive(profile.id);
    assert.deepEqual(await store.list(), { profiles: [profile, ipv6Profile], activeProfileId: profile.id });
    assert.equal(profile.label, 'Local');
    assert.equal(profile.apiBaseUrl, 'http://localhost:4000');
    assert.equal(ipv6Profile.apiBaseUrl, 'http://[::1]:4000');
  });

  it('encrypts credentials before writing app-owned storage', async () => {
    const directory = await createDirectory();
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({ label: 'Secure', apiBaseUrl: 'https://propr.example.com' });
    assert.deepEqual(await store.writeCredential(profile.id, 'top-secret'), { stored: true });
    assert.deepEqual(await store.readCredential(profile.id), { available: true, value: 'top-secret' });
    const onDisk = await readFile(join(directory, 'desktop', 'credentials', `${profile.id}.bin`), 'utf8');
    assert.equal(onDisk, Buffer.from('top-secret', 'utf8').toString('base64url'));
    assert.equal(onDisk.includes('top-secret'), false);
    assert.notEqual(onDisk, 'top-secret');
  });

  it('serializes concurrent credential writes with last-write semantics', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());

    const first = store.writeCredential('profile-1', 'first');
    const second = store.writeCredential('profile-1', 'second');
    assert.deepEqual(await Promise.all([first, second]), [{ stored: true }, { stored: true }]);
    assert.deepEqual(await store.readCredential('profile-1'), { available: true, value: 'second' });
  });

  it('orders concurrent credential writes and removals by invocation', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());

    await Promise.all([
      store.writeCredential('profile-1', 'remove-me'),
      store.removeCredential('profile-1'),
    ]);
    assert.deepEqual(await store.readCredential('profile-1'), { available: true, value: null });

    await Promise.all([
      store.removeCredential('profile-1'),
      store.writeCredential('profile-1', 'keep-me'),
    ]);
    assert.deepEqual(await store.readCredential('profile-1'), { available: true, value: 'keep-me' });
  });

  it('refuses plaintext fallback when encryption is unavailable or basic_text', async () => {
    for (const provider of [encryption(false, 'unavailable'), encryption(true, 'basic_text')]) {
      const directory = await createDirectory();
      const store = new ProfileStore(directory, provider);
      assert.equal(store.security().available, false);
      assert.deepEqual(await store.writeCredential('profile-1', 'secret'), {
        stored: false,
        reason: 'encryption-unavailable',
      });
      assert.deepEqual(await store.readCredential('profile-1'), { available: false, value: null });
    }
  });

  it('rejects unsafe endpoints and path-like profile identifiers', async () => {
    const directory = await createDirectory();
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({ label: 'Remote', apiBaseUrl: 'https://propr.example.com/' });
    await assert.rejects(
      store.save({ label: 'Remote HTTP', apiBaseUrl: 'http://example.com' }),
      /HTTPS/,
    );
    await assert.rejects(
      store.save({ id: profile.id, label: 'Path bearing', apiBaseUrl: 'https://propr.example.com/base' }),
      /HTTPS/,
    );
    await assert.rejects(
      store.save({ label: 'Encoded Connect', apiBaseUrl: 'https://t-%69nstance123.propr.dev' }),
      /HTTPS/,
    );
    await assert.rejects(
      store.save({ label: 'Port Connect', apiBaseUrl: 'https://t-instance123.propr.dev:443' }),
      /HTTPS/,
    );
    assert.deepEqual((await store.list()).profiles, [profile]);
    assert.doesNotMatch(await readFile(join(directory, 'desktop', 'profiles.json'), 'utf8'), /\/base/);
    await assert.rejects(store.writeCredential('../escape', 'secret'), /Invalid desktop profile id/);
  });
});
