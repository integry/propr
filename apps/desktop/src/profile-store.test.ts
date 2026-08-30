import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  flushFileData,
  ProfileStore,
  type EncryptionProvider,
  type ProfileStoreDurabilityStep,
  type ProfileStoreIOOperation,
} from './profile-store';

const temporaryDirectories: string[] = [];
const NATIVE_VISIBILITY_SCENARIOS = [
  'pointer-rollback', 'pointer-corruption', 'missing-target', 'state-before-journal',
  'mirror-missing', 'mirror-truncated', 'mirror-malformed', 'mirror-stale',
  'mirror-schema-invalid', 'mirror-attacker', 'alternate-slot-rollback',
] as const;
const RECOVERY_KILL_STEPS: ProfileStoreDurabilityStep[] = [
  'state-written', 'state-fsynced',
  'journal-written', 'journal-fsynced', 'journal-closed', 'journal-reopened',
  'journal-prepared-verified', 'journal-committed', 'journal-commit-fsynced',
  'journal-commit-verified', 'journal-commit-closed', 'state-renamed',
  ...(process.platform === 'win32' ? [] : ['state-directory-fsynced'] as const),
];
const RECOVERY_KILL_MODES = ['bootstrap', 'migration-v1', 'migration-v2'] as const;

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

const legacyProfile = {
  id: 'profile-1', label: 'Legacy', apiBaseUrl: 'https://propr.example.com',
  createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
};

const seedRecoveryMode = async (
  directory: string,
  mode: (typeof RECOVERY_KILL_MODES)[number],
): Promise<void> => {
  if (mode === 'bootstrap') return;
  const desktop = join(directory, 'desktop');
  const credentials = join(desktop, 'credentials');
  await mkdir(credentials, { recursive: true });
  if (mode === 'migration-v1') {
    await writeFile(join(desktop, 'profiles.json'), JSON.stringify({
      version: 1, activeProfileId: legacyProfile.id, profiles: [legacyProfile],
    }));
    await writeFile(
      join(credentials, `${legacyProfile.id}.bin`),
      encryption().encrypt(JSON.stringify(credential(legacyProfile.id))),
    );
    return;
  }
  const slot = `${legacyProfile.id}.00000000-0000-4000-8000-000000000001.bin`;
  await writeFile(join(credentials, slot), encryption().encrypt(JSON.stringify(credential(legacyProfile.id))));
  await writeFile(join(desktop, 'profiles.json'), JSON.stringify({
    version: 2,
    activeProfileId: legacyProfile.id,
    profiles: [legacyProfile],
    credentialSlots: { [legacyProfile.id]: slot },
  }));
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
    const barrierProof = join(directory, 'writable-file-barrier-proof');
    const barrierBytes = Buffer.from('native writable fsync proof');
    await writeFile(barrierProof, barrierBytes);
    await flushFileData(barrierProof);
    assert.deepEqual(await readFile(barrierProof), barrierBytes);

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
      (await store.readProfileCredential(profile.id)).identityEpoch!,
      profile.apiBaseUrl,
      null,
      () => true,
    );

    assert.equal(activated, null);
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

  it('commits encrypted pending revocation material atomically with B and unlinks A only after durable completion', async () => {
    const directory = await createDirectory();
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    const credentialA = credential(profile.id, 'A');
    await store.writeCredential(credentialA);
    const baseline = await store.readProfileCredential(profile.id);

    const committed = await store.commitPairedProfile(
      { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
      credential(profile.id, 'B'), baseline, () => true,
    );
    assert.ok(committed && !('stored' in committed));
    if (!committed || 'stored' in committed) return;
    assert.notEqual(committed.identityEpoch, baseline.identityEpoch);

    const pending = await store.pendingRevocations();
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].credential, credentialA);
    assert.deepEqual(await store.readCredential(profile.id), credential(profile.id, 'B'));
    const desktop = join(directory, 'desktop');
    for (const file of await readdir(desktop)) {
      if (!file.startsWith('profiles.')) continue;
      const contents = await readFile(join(desktop, file), 'utf8');
      assert.equal(contents.includes(credentialA.token), false);
      assert.equal(contents.includes(credential(profile.id, 'B').token), false);
    }
    assert.equal((await readdir(join(desktop, 'credentials'))).length, 2);

    assert.equal(await store.completePendingRevocation(pending[0].id, credentialA), true);
    assert.deepEqual(await store.pendingRevocations(), []);
    assert.equal((await readdir(join(desktop, 'credentials'))).length, 1);
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
    const migrated = await store.readProfileCredential(profile.id);
    assert.deepEqual({ ...migrated, identityEpoch: undefined }, {
      profile, credential: legacyCredential, identityEpoch: undefined, activeProfileId: profile.id,
    });
    assert.match(migrated.identityEpoch ?? '', /^[A-Za-z0-9_-]{22}$/);
    const state = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as {
      version: number; credentialSlots: Record<string, string>;
    };
    assert.equal(state.version, 3);
    assert.match(state.credentialSlots[profile.id], /^profile-1\.[0-9a-f-]{36}\.bin$/);
    assert.deepEqual(await readdir(credentials), [state.credentialSlots[profile.id]]);
  });

  it('migrates the exact-head numeric unsealed journal only when its valid mirror matches exactly', async () => {
    const directory = await createDirectory();
    const desktop = join(directory, 'desktop');
    await mkdir(join(desktop, 'credentials'), { recursive: true });
    const profile = {
      id: 'profile-1', label: 'Legacy journal', apiBaseUrl: 'https://propr.example.com',
      createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
    };
    const state = {
      version: 3, generation: 7, activeProfileId: null, profiles: [profile],
      credentialSlots: {}, credentialEpochs: {}, pendingRevocations: {},
    };
    const payload = { version: 1, state, encryptedSlots: {} };
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
    await writeFile(join(desktop, 'profiles.json'), JSON.stringify(state));
    await writeFile(join(desktop, 'profiles.journal.1'), JSON.stringify({ ...payload, checksum }));

    const restarted = new ProfileStore(directory, encryption());
    assert.deepEqual(await restarted.list(), { profiles: [profile], activeProfileId: null });
    const migrated = await readFile(join(desktop, 'profiles.journal.0'), 'utf8');
    assert.equal(migrated.startsWith('C{"version":2'), true);
    assert.equal(migrated.includes(profile.label), false);
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
      let rejectCredential = false;
      const provider: EncryptionProvider = {
        ...encryption(),
        decrypt: value => {
          const plaintext = Buffer.from(value.toString(), 'base64url').toString('utf8');
          if (rejectCredential && plaintext.includes('"token":"propr_it_')) {
            if (failure === 'decrypt') throw new Error('keychain decrypt failed');
            return '{not-json';
          }
          return plaintext;
        },
      };
      const store = new ProfileStore(directory, provider);
      const profile = await store.save({ id: 'profile-1', label: 'Remote', apiBaseUrl: 'https://propr.example.com' });
      await store.writeCredential(credential(profile.id));
      await store.setActive(profile.id);
      rejectCredential = true;

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
      'credential-renamed',
      ...(process.platform === 'win32' ? [] : ['credential-directory-fsynced'] as const),
      'state-written', 'state-fsynced',
      'journal-written', 'journal-fsynced', 'journal-closed', 'journal-reopened',
      'journal-prepared-verified',
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

  it('fails closed before C and preserves fully verified B when the C flush fails', async () => {
    const failures: ProfileStoreIOOperation[] = [
      'credential-write', 'credential-flush', 'credential-replace',
      'mirror-write', 'mirror-flush', 'metadata-flush',
      'journal-write', 'journal-flush', 'journal-reopen', 'journal-verify', 'journal-commit',
    ];
    let completedFailures = 0;
    for (const operation of failures) {
      const directory = await createDirectory();
      let injected: ProfileStoreIOOperation | null = null;
      let published = false;
      const store = new ProfileStore(directory, encryption(), {
        beforeIO: current => {
          if (current === injected) throw new Error(`injected ${current} failure`);
        },
      });
      const profile = await store.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      const credentialA = credential(profile.id, 'A');
      await store.writeCredential(credentialA);
      await store.setActive(profile.id);
      const baseline = await store.readProfileCredential(profile.id);
      injected = operation;
      await assert.rejects(store.commitPairedProfile(
        { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true, undefined, () => { published = true; },
      ), /injected/);
      injected = null;
      assert.equal(published, false, operation);
      const restarted = new ProfileStore(directory, encryption());
      assert.equal((await restarted.list()).profiles[0].label, 'Original', operation);
      assert.deepEqual(await restarted.readCredential(profile.id), credentialA, operation);
      assert.deepEqual(await restarted.pendingRevocations(), [], operation);
      completedFailures += 1;
    }

    const directory = await createDirectory();
    let injected: ProfileStoreIOOperation | null = null;
    let published = false;
    const store = new ProfileStore(directory, encryption(), {
      beforeIO: current => {
        if (current === injected) throw new Error(`injected ${current} failure`);
      },
    });
    const profile = await store.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    await store.writeCredential(credential(profile.id, 'A'));
    const baseline = await store.readProfileCredential(profile.id);
    injected = 'journal-commit-flush';
    await assert.rejects(store.commitPairedProfile(
      { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
      credential(profile.id, 'B'), baseline, () => true, undefined, () => { published = true; },
    ), /injected journal-commit-flush/);
    injected = null;
    assert.equal(published, true);
    const restarted = new ProfileStore(directory, encryption());
    assert.equal((await restarted.list()).profiles[0].label, 'Replacement');
    assert.deepEqual(await restarted.readCredential(profile.id), credential(profile.id, 'B'));
    assert.equal((await restarted.pendingRevocations()).length, 1);
    completedFailures += 1;

    const corruptDirectory = await createDirectory();
    const corruptDesktop = join(corruptDirectory, 'desktop');
    let corruptPrepared = false;
    const corruptingStore = new ProfileStore(corruptDirectory, encryption(), {
      afterDurabilityStep: async step => {
        if (!corruptPrepared || step !== 'journal-closed') return;
        corruptPrepared = false;
        for (const name of ['profiles.journal.0', 'profiles.journal.1']) {
          const path = join(corruptDesktop, name);
          try {
            const bytes = await readFile(path);
            if (bytes[0] !== 'P'.charCodeAt(0)) continue;
            bytes[Math.min(20, bytes.length - 1)] ^= 1;
            await writeFile(path, bytes);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        throw new Error('prepared journal was not found');
      },
    });
    const corruptProfile = await corruptingStore.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    const corruptA = credential(corruptProfile.id, 'A');
    await corruptingStore.writeCredential(corruptA);
    const corruptBaseline = await corruptingStore.readProfileCredential(corruptProfile.id);
    corruptPrepared = true;
    await assert.rejects(corruptingStore.commitPairedProfile(
      { id: corruptProfile.id, label: 'Replacement', apiBaseUrl: corruptProfile.apiBaseUrl },
      credential(corruptProfile.id, 'B'), corruptBaseline, () => true,
    ), /Desktop profile recovery state is unavailable/);
    const corruptRestart = new ProfileStore(corruptDirectory, encryption());
    assert.equal((await corruptRestart.list()).profiles[0].label, 'Original');
    assert.deepEqual(await corruptRestart.readCredential(corruptProfile.id), corruptA);
    completedFailures += 1;
    console.log(`NATIVE_CATEGORY barriers expected=${failures.length + 2} executed=${completedFailures}`);
  });

  it('treats mirror replace and directory-flush failures after the journal commit as recoverable mirror failures', async () => {
    for (const operation of ['mirror-replace', 'metadata-flush'] as const) {
      const directory = await createDirectory();
      let injected: ProfileStoreIOOperation | null = null;
      let journalCommitted = false;
      const store = new ProfileStore(directory, encryption(), {
        afterDurabilityStep: step => { if (step === 'journal-commit-fsynced') journalCommitted = true; },
        beforeIO: current => {
          if (journalCommitted && current === injected) throw new Error(`injected ${current} failure`);
        },
      });
      const profile = await store.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      await store.writeCredential(credential(profile.id, 'A'));
      const baseline = await store.readProfileCredential(profile.id);
      journalCommitted = false;
      injected = operation;
      const result = await store.commitPairedProfile(
        { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true,
      );
      assert.ok(result && !('stored' in result), operation);
      injected = null;
      const restarted = new ProfileStore(directory, encryption());
      assert.equal((await restarted.list()).profiles[0].label, 'Replacement', operation);
      assert.deepEqual(await restarted.readCredential(profile.id), credential(profile.id, 'B'), operation);
    }
  });

  it('recovers real process crashes as complete A before the pointer commit and complete B after it', async () => {
    const steps: ProfileStoreDurabilityStep[] = [
      'credential-encrypted', 'credential-written', 'credential-fsynced', 'credential-renamed',
      ...(process.platform === 'win32' ? [] : ['credential-directory-fsynced'] as const),
      'state-written', 'state-fsynced', 'journal-written', 'journal-fsynced',
      'journal-closed', 'journal-reopened', 'journal-prepared-verified',
      'journal-committed', 'journal-commit-fsynced', 'journal-commit-verified',
      'journal-commit-closed', 'state-renamed',
      ...(process.platform === 'win32' ? [] : ['state-directory-fsynced'] as const),
    ];
    assert.equal(steps.length, process.platform === 'win32' ? 16 : 18);
    let completed = 0;
    for (const step of steps) {
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
      assert.equal(
        result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0),
        true,
        `${step}: child did not crash at the requested boundary`,
      );

      const restarted = new ProfileStore(directory, encryption());
      const snapshot = await restarted.readProfileCredential(profileA.id);
      const committed = step === 'journal-committed'
        || step === 'journal-commit-fsynced'
        || step === 'journal-commit-verified'
        || step === 'journal-commit-closed'
        || step === 'state-renamed'
        || step === 'state-directory-fsynced';
      assert.equal(snapshot.profile?.label, committed ? 'Replacement' : 'Original', step);
      assert.deepEqual(snapshot.credential, credential(profileA.id, committed ? 'B' : 'A'), step);
      assert.equal((await restarted.pendingRevocations()).length, committed ? 1 : 0, step);
      const files = await readdir(join(directory, 'desktop', 'credentials'));
      assert.equal(files.length, committed ? 2 : 1, `${step}: recovery did not retain exactly the authoritative and pending slots`);
      const desktopFiles = await readdir(join(directory, 'desktop'));
      assert.equal(desktopFiles.some(file => file.endsWith('.tmp')), false, `${step}: recovery left staging files`);
      completed += 1;
    }
    assert.equal(completed, steps.length, 'a native durability boundary fixture was skipped');
    console.log(`NATIVE_CATEGORY transaction-boundaries expected=${steps.length} executed=${completed}`);
  });

  it('recovers every first bootstrap and v1/v2 migration child-process kill without activating prepared B', async () => {
    let completed = 0;
    for (const mode of RECOVERY_KILL_MODES) {
      for (const step of RECOVERY_KILL_STEPS) {
        const directory = await createDirectory();
        await seedRecoveryMode(directory, mode);
        const child = spawn(process.execPath, [
          '--import', 'tsx', join(import.meta.dirname, 'profile-store-crash-fixture.ts'),
          directory, `recovery:${mode}:${step}`,
        ], { stdio: 'ignore' });
        const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        assert.equal(
          result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0),
          true,
          `${mode}/${step}: child did not crash at the requested boundary`,
        );

        const desktop = join(directory, 'desktop');
        const committed = step === 'journal-committed'
          || step === 'journal-commit-fsynced'
          || step === 'journal-commit-verified'
          || step === 'journal-commit-closed'
          || step === 'state-renamed'
          || step === 'state-directory-fsynced';
        const journals = await Promise.all([0, 1].map(async index => {
          try { return await readFile(join(desktop, `profiles.journal.${index}`), 'utf8'); } catch { return null; }
        }));
        if (committed) assert.equal(journals.some(value => value?.startsWith('C')), true, `${mode}/${step}`);
        else assert.equal(journals.some(value => value?.startsWith('C')), false, `${mode}/${step}`);

        for (let restart = 0; restart < 3; restart += 1) {
          const recovered = new ProfileStore(directory, encryption());
          if (mode === 'bootstrap') {
            assert.deepEqual(await recovered.list(), { profiles: [], activeProfileId: null }, `${mode}/${step}/${restart}`);
          } else {
            const snapshot = await recovered.readProfileCredential(legacyProfile.id);
            assert.deepEqual(snapshot.profile, legacyProfile, `${mode}/${step}/${restart}`);
            assert.deepEqual(snapshot.credential, credential(legacyProfile.id), `${mode}/${step}/${restart}`);
            assert.equal(snapshot.activeProfileId, legacyProfile.id, `${mode}/${step}/${restart}`);
            assert.match(snapshot.identityEpoch ?? '', /^[A-Za-z0-9_-]{22}$/, `${mode}/${step}/${restart}`);
          }
          const state = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as { version: number };
          assert.equal(state.version, 3, `${mode}/${step}/${restart}`);
        }
        completed += 1;
      }
    }
    assert.equal(completed, RECOVERY_KILL_MODES.length * RECOVERY_KILL_STEPS.length);
    console.log(`NATIVE_CATEGORY bootstrap-migration expected=${completed} executed=${completed}`);
  });

  it('binds verified prepared bytes to one handle across same-size swaps and path-restoration ABA', async () => {
    let completed = 0;
    for (const restoreOriginalPath of [false, true]) {
      const directory = await createDirectory();
      const desktop = join(directory, 'desktop');
      let swapPrepared = false;
      let attackerPath = '';
      const store = new ProfileStore(directory, encryption(), {
        afterDurabilityStep: async step => {
          if (!swapPrepared || step !== 'journal-prepared-verified') return;
          swapPrepared = false;
          const state = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as { generation: string };
          const preparedPath = join(desktop, `profiles.journal.${Number((BigInt(state.generation) + 1n) % 2n)}`);
          const preparedContents = await readFile(preparedPath, 'utf8');
          assert.equal(preparedContents[0], 'P');
          const envelope = JSON.parse(preparedContents.slice(1)) as {
            version: 2; generation: string; encryptedPayload: string; checksum: string;
          };
          const payload = JSON.parse(encryption().decrypt(Buffer.from(envelope.encryptedPayload, 'base64url'))) as {
            state: { profiles: Array<{ label: string }>; credentialSlots: Record<string, string> };
            encryptedSlots: Record<string, string>;
          };
          payload.state.profiles[0].label = 'Attacker!!!';
          const slot = payload.state.credentialSlots['profile-1'];
          const attackerCredential = JSON.parse(
            encryption().decrypt(Buffer.from(payload.encryptedSlots[slot], 'base64url')),
          ) as ReturnType<typeof credential>;
          attackerCredential.token = `propr_it_${'X'.repeat(43)}`;
          payload.encryptedSlots[slot] = encryption().encrypt(JSON.stringify(attackerCredential)).toString('base64url');
          const encryptedPayload = encryption().encrypt(JSON.stringify(payload)).toString('base64url');
          const attackerContents = `P${JSON.stringify({
            ...envelope,
            encryptedPayload,
            checksum: createHash('sha256').update(encryptedPayload).digest('base64url'),
          })}\n`;
          assert.equal(Buffer.byteLength(attackerContents), Buffer.byteLength(preparedContents));
          const heldPath = `${preparedPath}.held`;
          attackerPath = restoreOriginalPath ? `${preparedPath}.attacker` : preparedPath;
          await rename(preparedPath, heldPath);
          await writeFile(preparedPath, attackerContents, { mode: 0o600 });
          if (restoreOriginalPath) {
            await rename(preparedPath, attackerPath);
            await rename(heldPath, preparedPath);
          }
        },
      });
      const profile = await store.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      const credentialA = credential(profile.id, 'A');
      await store.writeCredential(credentialA);
      const baseline = await store.readProfileCredential(profile.id);
      swapPrepared = true;
      const transaction = store.commitPairedProfile(
        { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true,
      );
      if (restoreOriginalPath) {
        const committed = await transaction;
        assert.ok(committed && !('stored' in committed));
      } else {
        await assert.rejects(transaction, /Desktop profile recovery state is unavailable/);
      }
      assert.equal((await readFile(attackerPath, 'utf8')).startsWith('P'), true);

      const restarted = new ProfileStore(directory, encryption());
      const snapshot = await restarted.readProfileCredential(profile.id);
      assert.equal(snapshot.profile?.label, restoreOriginalPath ? 'Replacement' : 'Original');
      assert.deepEqual(snapshot.credential, credential(profile.id, restoreOriginalPath ? 'B' : 'A'));
      assert.notEqual(snapshot.profile?.label, 'Attacker!!!');
      assert.notDeepEqual(snapshot.credential, credential(profile.id, 'X'));
      completed += 1;
    }
    assert.equal(completed, 2);
    console.log(`NATIVE_CATEGORY verified-handle-swap expected=2 executed=${completed}`);
  });

  for (const visibility of ['pointer-rollback', 'missing-target', 'state-before-journal'] as const) {
    it(`recovers a ${visibility} durability view as complete A or complete B`, async () => {
      const directory = await createDirectory();
      const desktop = join(directory, 'desktop');
      const credentialsDirectory = join(desktop, 'credentials');
      const store = new ProfileStore(directory, encryption());
      const profileA = await store.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      const credentialA = credential(profileA.id, 'A');
      await store.writeCredential(credentialA);
      const stateA = await readFile(join(desktop, 'profiles.json'));
      const journalsA = await Promise.all([0, 1].map(async index => {
        try { return await readFile(join(desktop, `profiles.journal.${index}`)); } catch { return null; }
      }));
      const baseline = await store.readProfileCredential(profileA.id);
      await store.commitPairedProfile(
        { id: profileA.id, label: 'Replacement', apiBaseUrl: profileA.apiBaseUrl },
        credential(profileA.id, 'B'), baseline, () => true,
      );
      const stateB = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as {
        credentialSlots: Record<string, string>;
      };

      if (visibility === 'pointer-rollback') {
        await writeFile(join(desktop, 'profiles.json'), stateA);
      } else if (visibility === 'missing-target') {
        await unlink(join(credentialsDirectory, stateB.credentialSlots[profileA.id]));
      } else {
        for (const [index, bytes] of journalsA.entries()) {
          const path = join(desktop, `profiles.journal.${index}`);
          if (bytes) await writeFile(path, bytes);
          else await unlink(path).catch(() => undefined);
        }
      }

      const restarted = new ProfileStore(directory, encryption());
      const recovered = await restarted.readProfileCredential(profileA.id);
      const expectsB = visibility !== 'state-before-journal';
      assert.equal(recovered.profile?.label, expectsB ? 'Replacement' : 'Original');
      assert.deepEqual(recovered.credential, credential(profileA.id, expectsB ? 'B' : 'A'));
      const activeSlotFiles = (await readdir(credentialsDirectory)).filter(file => file.endsWith('.bin'));
      assert.equal(activeSlotFiles.length, expectsB ? 2 : 1);
    });
  }

  for (const mirrorView of [
    'missing', 'truncated', 'malformed', 'stale', 'schema-invalid', 'attacker-modified',
  ] as const) {
    it(`recovers the authoritative encrypted journal before a ${mirrorView} mirror`, async () => {
      const directory = await createDirectory();
      const desktop = join(directory, 'desktop');
      const mirror = join(desktop, 'profiles.json');
      const store = new ProfileStore(directory, encryption());
      const profile = await store.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      await store.writeCredential(credential(profile.id, 'A'));
      const stale = await readFile(mirror);
      const baseline = await store.readProfileCredential(profile.id);
      await store.commitPairedProfile(
        { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
        credential(profile.id, 'B'), baseline, () => true,
      );
      const current = JSON.parse(await readFile(mirror, 'utf8')) as Record<string, unknown>;
      if (mirrorView === 'missing') await unlink(mirror);
      else if (mirrorView === 'truncated') await writeFile(mirror, '{"version":3');
      else if (mirrorView === 'malformed') await writeFile(mirror, 'not-json');
      else if (mirrorView === 'stale') await writeFile(mirror, stale);
      else if (mirrorView === 'schema-invalid') {
        await writeFile(mirror, JSON.stringify({
          ...current, version: 99,
        }));
      } else {
        const profiles = current.profiles as Array<Record<string, unknown>>;
        await writeFile(mirror, JSON.stringify({
          ...current,
          profiles: profiles.map(value => ({ ...value, label: 'Attacker' })),
        }));
      }

      const restarted = new ProfileStore(directory, encryption());
      assert.equal((await restarted.list()).profiles[0].label, 'Replacement', mirrorView);
      assert.deepEqual(await restarted.readCredential(profile.id), credential(profile.id, 'B'), mirrorView);
      assert.equal((await restarted.pendingRevocations()).length, 1, mirrorView);
      assert.equal((await readFile(mirror, 'utf8')).includes('Attacker'), false, mirrorView);
      console.log('NATIVE_SCENARIO mirror-repair');
    });
  }

  it('fails with one fixed redacted error when neither mirror nor journal authenticates', async () => {
    const directory = await createDirectory();
    const desktop = join(directory, 'desktop');
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    await store.writeCredential(credential(profile.id, 'A'));
    for (const name of ['profiles.journal.0', 'profiles.journal.1']) {
      const path = join(desktop, name);
      try {
        const bytes = await readFile(path);
        if (bytes[0] === 'C'.charCodeAt(0)) bytes[Math.min(20, bytes.length - 1)] ^= 1;
        await writeFile(path, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await assert.rejects(
      new ProfileStore(directory, encryption()).list(),
      error => (error as Error).message === 'Desktop profile recovery state is unavailable',
    );
    await writeFile(join(desktop, 'profiles.json'), '{attacker');
    const restarted = new ProfileStore(directory, encryption());
    await assert.rejects(restarted.list(), error => {
      assert.equal((error as Error).message, 'Desktop profile recovery state is unavailable');
      assert.equal((error as Error).message.includes(profile.id), false);
      return true;
    });

    const ioDirectory = await createDirectory();
    const ioStore = new ProfileStore(ioDirectory, encryption());
    await ioStore.save({
      id: 'profile-io', label: 'I/O failure', apiBaseUrl: 'https://propr.example.com',
    });
    const ioMirror = join(ioDirectory, 'desktop', 'profiles.json');
    await unlink(ioMirror);
    await mkdir(ioMirror);
    await assert.rejects(new ProfileStore(ioDirectory, encryption()).list(), error => {
      assert.equal((error as Error).message, 'Desktop profile recovery state is unavailable');
      assert.equal((error as Error).message.includes('EISDIR'), false);
      assert.equal((error as Error).message.includes(ioMirror), false);
      return true;
    });
  });

  it('selects a lossless newest valid generation and survives alternate-slot rollback', async () => {
    const directory = await createDirectory();
    const desktop = join(directory, 'desktop');
    const store = new ProfileStore(directory, encryption());
    const profile = await store.save({
      id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
    });
    await store.writeCredential(credential(profile.id, 'A'));
    const baseline = await store.readProfileCredential(profile.id);
    await store.commitPairedProfile(
      { id: profile.id, label: 'Replacement', apiBaseUrl: profile.apiBaseUrl },
      credential(profile.id, 'B'), baseline, () => true,
    );
    const mirror = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as { generation: string };
    const newest = Number(BigInt(mirror.generation) % 2n);
    const older = (newest + 1) % 2;
    await writeFile(
      join(desktop, `profiles.journal.${newest}`),
      await readFile(join(desktop, `profiles.journal.${older}`)),
    );
    const restarted = new ProfileStore(directory, encryption());
    const recovered = await restarted.readProfileCredential(profile.id);
    assert.equal(recovered.profile?.label, 'Original');
    assert.deepEqual(recovered.credential, credential(profile.id, 'A'));
  });

  it('runs every native child-termination visibility fixture with an explicit scenario count', async () => {
    assert.equal(NATIVE_VISIBILITY_SCENARIOS.length, 11);
    if (process.env.PROPR_NATIVE_WINDOWS_DURABILITY_REQUIRED === '1') {
      assert.equal(process.platform, 'win32', 'native Windows durability cannot run on a non-Windows host');
      assert.equal(process.arch, 'x64', 'native Windows durability must execute x64 production Node');
    }
    let completed = 0;
    for (const visibility of NATIVE_VISIBILITY_SCENARIOS) {
      const directory = await createDirectory();
      const setup = new ProfileStore(directory, encryption());
      const profileA = await setup.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      await setup.writeCredential(credential(profileA.id, 'A'));
      const child = spawn(process.execPath, [
        '--import', 'tsx', join(import.meta.dirname, 'profile-store-crash-fixture.ts'),
        directory, `visibility:${visibility}`,
      ], { stdio: 'ignore' });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.code === 0, false, `${visibility}: Windows child did not terminate`);

      const restarted = new ProfileStore(directory, encryption());
      const snapshot = await restarted.readProfileCredential(profileA.id);
      const expectsB = visibility !== 'state-before-journal' && visibility !== 'alternate-slot-rollback';
      assert.equal(snapshot.profile?.label, expectsB ? 'Replacement' : 'Original', visibility);
      assert.deepEqual(snapshot.credential, credential(profileA.id, expectsB ? 'B' : 'A'), visibility);
      assert.equal((await restarted.pendingRevocations()).length, expectsB ? 1 : 0, visibility);
      completed += 1;
    }
    assert.equal(completed, NATIVE_VISIBILITY_SCENARIOS.length, 'a native visibility fixture was skipped');
    console.log(
      `NATIVE_CATEGORY reordered-visibility expected=${NATIVE_VISIBILITY_SCENARIOS.length} executed=${completed}`,
    );
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
