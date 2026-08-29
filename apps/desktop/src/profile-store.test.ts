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

const credential = (profileId: string, tokenCharacter = 'A') => ({
  version: 1 as const,
  profileId,
  origin: 'https://propr.example.com',
  token: `propr_it_${tokenCharacter.repeat(43)}`,
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
    const storedCredential = credential(profile.id);
    assert.deepEqual(await store.writeCredential(storedCredential), { stored: true });
    assert.deepEqual(await store.readCredential(profile.id), storedCredential);
    const onDisk = await readFile(join(directory, 'desktop', 'credentials', `${profile.id}.bin`), 'utf8');
    assert.equal(onDisk.includes(storedCredential.token), false);
  });

  it('serializes concurrent credential writes with last-write semantics', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());

    const first = store.writeCredential(credential('profile-1', 'A'));
    const secondCredential = credential('profile-1', 'B');
    const second = store.writeCredential(secondCredential);
    assert.deepEqual(await Promise.all([first, second]), [{ stored: true }, { stored: true }]);
    assert.deepEqual(await store.readCredential('profile-1'), secondCredential);
  });

  it('orders concurrent credential writes and removals by invocation', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());

    await Promise.all([
      store.writeCredential(credential('profile-1')),
      store.removeCredential('profile-1'),
    ]);
    assert.equal(await store.readCredential('profile-1'), null);

    await Promise.all([
      store.removeCredential('profile-1'),
      store.writeCredential(credential('profile-1', 'B')),
    ]);
    assert.deepEqual(await store.readCredential('profile-1'), credential('profile-1', 'B'));
  });

  it('refuses plaintext fallback when encryption is unavailable or basic_text', async () => {
    for (const provider of [encryption(false, 'unavailable'), encryption(true, 'basic_text')]) {
      const directory = await createDirectory();
      const store = new ProfileStore(directory, provider);
      assert.equal(store.security().available, false);
      assert.deepEqual(await store.writeCredential(credential('profile-1')), {
        stored: false,
        reason: 'encryption-unavailable',
      });
      assert.equal(await store.readCredential('profile-1'), null);
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
    assert.deepEqual((await store.list()).profiles, [profile]);
    assert.doesNotMatch(await readFile(join(directory, 'desktop', 'profiles.json'), 'utf8'), /\/base/);
    await assert.rejects(store.writeCredential(credential('../escape')), /Invalid desktop profile id/);
  });
});
