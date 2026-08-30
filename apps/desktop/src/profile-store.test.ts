import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

const bounded = <T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Profile store operation did not settle')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

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
    const files = await readdir(join(directory, 'desktop', 'credentials'));
    assert.equal(files.length, 1);
    const onDisk = await readFile(join(directory, 'desktop', 'credentials', files[0]), 'utf8');
    assert.equal(onDisk.includes(storedCredential.token), false);
  });

  it('atomically refuses activation when the credential origin differs from the profile origin', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());
    const profile = await store.save({
      id: 'profile-b', label: 'B', apiBaseUrl: 'https://b.example.test',
    });
    const staleCredential = {
      ...credential(profile.id),
      origin: 'https://a.example.test',
    };
    await store.writeCredential(staleCredential);

    const activated = await store.activateProfile(
      staleCredential,
      profile.apiBaseUrl,
      null,
      () => true,
    );

    assert.equal(activated, false);
    assert.equal((await store.list()).activeProfileId, null);
    assert.deepEqual(await store.readCredential(profile.id), staleCredential);
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

  it('serializes concurrent paired replacements without mixing profile and credential generations', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());
    const profile = await store.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    await store.writeCredential(credential(profile.id, 'A'));
    const baseline = await store.readProfileCredential(profile.id);
    const [first, second] = await Promise.all([
      store.commitPairedProfile(
        { id: profile.id, label: 'Replacement B', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true,
      ),
      store.commitPairedProfile(
        { id: profile.id, label: 'Replacement C', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'C'), baseline, () => true,
      ),
    ]);
    assert.equal(first && !('stored' in first) ? first.profile.label : null, 'Replacement B');
    assert.equal(second, null);
    assert.equal((await store.list()).profiles[0].label, 'Replacement B');
    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, 'B'));
  });

  it('migrates legacy fixed credentials through the atomic state pointer and removes the old slot', async () => {
    const directory = await createDirectory();
    const desktop = join(directory, 'desktop');
    const credentials = join(desktop, 'credentials');
    await mkdir(credentials, { recursive: true });
    const profile = {
      id: 'profile-1', label: 'Legacy', apiBaseUrl: 'https://propr.example.com',
      createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    };
    await writeFile(join(desktop, 'profiles.json'), JSON.stringify({
      version: 1, activeProfileId: profile.id, profiles: [profile],
    }));
    const legacyCredential = credential(profile.id, 'A');
    await writeFile(join(credentials, `${profile.id}.bin`), encryption().encrypt(JSON.stringify(legacyCredential)));

    const store = new ProfileStore(directory, encryption());
    assert.deepEqual(await store.readProfileCredential(profile.id), {
      profile, credential: legacyCredential, activeProfileId: profile.id,
    });
    const state = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as {
      version: number; credentialSlots: Record<string, string>;
    };
    assert.equal(state.version, 2);
    assert.match(state.credentialSlots[profile.id], /^profile-1\.[0-9a-f-]{36}\.bin$/);
    assert.deepEqual(await readdir(credentials), [state.credentialSlots[profile.id]]);
  });

  it('settles conditional credential removal and profile removal in the former lock-order interleaving', async () => {
    const store = new ProfileStore(await createDirectory(), encryption());
    const profile = await store.save({
      id: 'profile-1', label: 'Remote', apiBaseUrl: 'https://propr.example.com',
    });
    const storedCredential = credential(profile.id);
    await store.writeCredential(storedCredential);

    // Both calls are deliberately made in one turn. Previously the conditional
    // removal could own the state queue while remove() owned the credential
    // queue and awaited the state operation queued behind it.
    const conditional = store.removeCredentialIfCurrent(
      storedCredential,
      profile.apiBaseUrl,
      () => true,
    );
    const removal = store.remove(profile.id);

    assert.deepEqual(await bounded(Promise.all([conditional, removal])), [true, undefined]);
    assert.deepEqual(await store.list(), { profiles: [], activeProfileId: null });
    assert.equal(await store.readCredential(profile.id), null);
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

  for (const failure of ['corrupt-json', 'decrypt'] as const) {
    it(`removes an active profile despite a ${failure} credential failure`, async () => {
      const directory = await createDirectory();
      let rejectDecrypt = false;
      const provider: EncryptionProvider = {
        ...encryption(),
        decrypt: value => {
          if (rejectDecrypt) throw new Error('keychain decrypt failed');
          return failure === 'corrupt-json' ? '{not-json' : Buffer.from(value.toString(), 'base64url').toString('utf8');
        },
      };
      const store = new ProfileStore(directory, provider);
      const profile = await store.save({ id: 'profile-1', label: 'Remote', apiBaseUrl: 'https://propr.example.com' });
      await store.writeCredential(credential(profile.id));
      await store.setActive(profile.id);
      rejectDecrypt = failure === 'decrypt';

      const detached = await store.detachProfile(profile.id);

      assert.equal(detached?.profile.id, profile.id);
      assert.equal(detached?.credential, null);
      assert.deepEqual(await store.list(), { profiles: [], activeProfileId: null });
      assert.equal(await store.readCredential(profile.id), null);
    });
  }

  it('preserves the complete profile and credential when state publication fails before commit', async () => {
    const directory = await createDirectory();
    let failStateFsync = false;
    const store = new ProfileStore(directory, encryption(), {
      afterDurabilityStep: step => {
        if (failStateFsync && step === 'state-fsynced') throw new Error('injected state fsync failure');
      },
    });
    const profile = await store.save({ id: 'profile-1', label: 'Remote', apiBaseUrl: 'https://propr.example.com' });
    const storedCredential = credential(profile.id);
    await store.writeCredential(storedCredential);
    await store.setActive(profile.id);
    failStateFsync = true;

    await assert.rejects(store.detachProfile(profile.id), /injected state fsync failure/);
    failStateFsync = false;
    assert.deepEqual(await store.list(), { profiles: [profile], activeProfileId: profile.id });
    assert.deepEqual(await store.readCredential(profile.id), storedCredential);
  });

  it('keeps A authoritative across every injected pre-commit paired replacement failure', async () => {
    const directory = await createDirectory();
    let failure: string | null = null;
    const store = new ProfileStore(directory, encryption(), {
      afterDurabilityStep: step => {
        if (step === failure) throw new Error(`injected ${step}`);
      },
    });
    const profile = await store.save({ id: 'profile-1', label: 'Remote', apiBaseUrl: 'https://propr.example.com' });
    const credentialA = credential(profile.id, 'A');
    await store.writeCredential(credentialA);
    await store.setActive(profile.id);
    const baseline = await store.readProfileCredential(profile.id);
    for (const step of [
      'credential-encrypted', 'credential-written', 'credential-fsynced',
      'credential-renamed', 'credential-directory-fsynced', 'state-written', 'state-fsynced',
    ]) {
      failure = step;
      await assert.rejects(store.commitPairedProfile(
        { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true,
      ), /injected/);
      failure = null;
      const restarted = new ProfileStore(directory, encryption());
      assert.deepEqual(await restarted.readCredential(profile.id), credentialA, step);
      assert.deepEqual(await restarted.list(), { profiles: [profile], activeProfileId: profile.id }, step);
    }
  });

  it('recovers real process crashes as complete A before the pointer commit and complete B after it', async () => {
    for (const step of [
      'credential-encrypted', 'credential-written', 'credential-fsynced', 'credential-renamed',
      'credential-directory-fsynced', 'state-written', 'state-fsynced', 'state-renamed',
      'state-directory-fsynced', 'old-credential-removed',
    ] as const) {
      const directory = await createDirectory();
      const setup = new ProfileStore(directory, encryption());
      const profileA = await setup.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      const credentialA = credential(profileA.id, 'A');
      await setup.writeCredential(credentialA);
      const child = spawn(process.execPath, [
        '--import', 'tsx', join(import.meta.dirname, 'profile-store-crash-fixture.ts'), directory, step,
      ], { stdio: 'ignore' });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.signal, 'SIGKILL', `${step}: child did not crash at the requested boundary`);

      const restarted = new ProfileStore(directory, encryption());
      const snapshot = await restarted.readProfileCredential(profileA.id);
      const committed = step === 'state-renamed'
        || step === 'state-directory-fsynced'
        || step === 'old-credential-removed';
      assert.equal(snapshot.profile?.label, committed ? 'Replacement' : 'Original', step);
      assert.deepEqual(snapshot.credential, credential(profileA.id, committed ? 'B' : 'A'), step);
      const files = await readdir(join(directory, 'desktop', 'credentials'));
      assert.equal(files.length, 1, `${step}: recovery did not remove orphan slots`);
      const desktopFiles = await readdir(join(directory, 'desktop'));
      assert.equal(desktopFiles.some(file => file.endsWith('.tmp')), false, `${step}: recovery left staging files`);
    }
  });

  it('removes an orphan credential before allowing same-ID recreation', async () => {
    const directory = await createDirectory();
    const store = new ProfileStore(directory, encryption());
    await store.writeCredential(credential('profile-1'));

    assert.equal(await store.detachProfile('profile-1'), null);
    const recreated = await store.save({ id: 'profile-1', label: 'Recreated', apiBaseUrl: 'https://propr.example.com' });

    assert.equal(recreated.id, 'profile-1');
    assert.equal(await store.readCredential('profile-1'), null);
  });
});
