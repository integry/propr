import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  ProfileStore,
  type EncryptionProvider,
  type ProfileStoreDurabilityStep,
} from './profile-store';

// Child-process crash fixtures for the profile store. They spawn one tsx child
// per durability boundary, so they live apart from profile-store.test.ts to keep
// each file well inside the full-suite per-unit timeout.

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
  version: 2 as const,
  profileId,
  origin: 'https://propr.example.com',
  publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
  token: `propr_it_${tokenCharacter.repeat(43)}`,
});
const legacyCredential = (profileId: string, tokenCharacter = 'A') => ({
  version: 1 as const,
  profileId,
  origin: 'https://propr.example.com',
  token: `propr_it_${tokenCharacter.repeat(43)}`,
});

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
      encryption().encrypt(JSON.stringify(legacyCredential(legacyProfile.id))),
    );
    return;
  }
  const slot = `${legacyProfile.id}.00000000-0000-4000-8000-000000000001.bin`;
  await writeFile(join(credentials, slot), encryption().encrypt(JSON.stringify(legacyCredential(legacyProfile.id))));
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

describe('desktop profile store crash recovery', () => {
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

  it('recovers profile deletion crashes as active A or detached pending A at the journal commit', async () => {
    const steps = RECOVERY_KILL_STEPS;
    let completed = 0;
    for (const step of steps) {
      const directory = await createDirectory();
      const setup = new ProfileStore(directory, encryption());
      const profile = await setup.save({
        id: 'profile-1', label: 'Original', apiBaseUrl: 'https://propr.example.com',
      });
      const credentialA = credential(profile.id, 'A');
      await setup.writeCredential(credentialA);
      await setup.setActive(profile.id);
      const child = spawn(process.execPath, [
        '--import', 'tsx', join(import.meta.dirname, 'profile-store-crash-fixture.ts'),
        directory, `detach:${step}`,
      ], { stdio: 'ignore' });
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(
        result.signal === 'SIGKILL' || (process.platform === 'win32' && result.code !== 0),
        true,
        `${step}: detach child did not crash at the requested boundary`,
      );
      const committed = step === 'journal-committed'
        || step === 'journal-commit-fsynced'
        || step === 'journal-commit-verified'
        || step === 'journal-commit-closed'
        || step === 'state-renamed'
        || step === 'state-directory-fsynced';
      const restarted = new ProfileStore(directory, encryption());
      const snapshot = await restarted.readProfileCredential(profile.id);
      assert.equal(snapshot.profile?.id ?? null, committed ? null : profile.id, step);
      assert.deepEqual(snapshot.credential, committed ? null : credentialA, step);
      const pending = await restarted.pendingRevocations();
      assert.equal(pending.length, committed ? 1 : 0, step);
      if (committed) assert.deepEqual(pending[0].credential, credentialA, step);
      console.log('NATIVE_SCENARIO detach-crash');
      completed += 1;
    }
    assert.equal(completed, steps.length);
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
            assert.equal(snapshot.credential, null, `${mode}/${step}/${restart}`);
            assert.equal(snapshot.activeProfileId, null, `${mode}/${step}/${restart}`);
            assert.equal(snapshot.identityEpoch, null, `${mode}/${step}/${restart}`);
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
});
