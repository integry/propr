import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProfileStore, type EncryptionProvider, type ProfileStoreDurabilityStep } from './profile-store';

const [directory, requestedStep] = process.argv.slice(2) as [string, string];
const crashStep = requestedStep.split(':').at(-1) as ProfileStoreDurabilityStep;
const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64url'), 'utf8'),
  decrypt: value => Buffer.from(value.toString(), 'base64url').toString('utf8'),
};
const store = new ProfileStore(directory, encryption, {
  afterDurabilityStep: step => {
    if (!requestedStep.startsWith('visibility:') && step === crashStep) process.kill(process.pid, 'SIGKILL');
  },
});
if (requestedStep.startsWith('recovery:')) {
  await store.list();
  throw new Error(`Recovery fixture did not reach ${crashStep}`);
}
const desktop = join(directory, 'desktop');
const stateA = requestedStep.startsWith('visibility:')
  ? await readFile(join(desktop, 'profiles.json'))
  : null;
const journalsA = requestedStep.startsWith('visibility:')
  ? await Promise.all([0, 1].map(async index => {
      try { return await readFile(join(desktop, `profiles.journal.${index}`)); } catch { return null; }
    }))
  : [];
const baseline = await store.readProfileCredential('profile-1');
if (requestedStep.startsWith('detach:')) {
  await store.detachProfile('profile-1');
  throw new Error(`Detach fixture did not reach ${crashStep}`);
}
await store.commitPairedProfile(
  { id: 'profile-1', label: 'Replacement', apiBaseUrl: 'https://propr.example.com' },
  {
    version: 2,
    profileId: 'profile-1',
    origin: 'https://propr.example.com',
    publicInstanceIdentity: '123e4567-e89b-42d3-a456-426614174000',
    token: `propr_it_${'B'.repeat(43)}`,
  },
  baseline,
  () => true,
);
if (requestedStep.startsWith('visibility:')) {
  const mode = requestedStep.slice('visibility:'.length);
  const stateB = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as {
    credentialSlots: Record<string, string>;
  };
  if (mode === 'pointer-rollback' && stateA) {
    await writeFile(join(desktop, 'profiles.json'), stateA);
  } else if (mode === 'pointer-corruption' || mode === 'mirror-malformed') {
    await writeFile(join(desktop, 'profiles.json'), '{corrupt');
  } else if (mode === 'mirror-missing') {
    await unlink(join(desktop, 'profiles.json'));
  } else if (mode === 'mirror-truncated') {
    await writeFile(join(desktop, 'profiles.json'), '{"version":3');
  } else if (mode === 'mirror-stale' && stateA) {
    await writeFile(join(desktop, 'profiles.json'), stateA);
  } else if (mode === 'mirror-schema-invalid') {
    const contents = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(desktop, 'profiles.json'), JSON.stringify({
      ...contents, version: 99,
    }));
  } else if (mode === 'mirror-attacker') {
    const contents = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as Record<string, unknown>;
    const profiles = contents.profiles as Array<Record<string, unknown>>;
    await writeFile(join(desktop, 'profiles.json'), JSON.stringify({
      ...contents, profiles: profiles.map(profile => ({ ...profile, label: 'Attacker' })),
    }));
  } else if (mode === 'missing-target') {
    await unlink(join(desktop, 'credentials', stateB.credentialSlots['profile-1']));
  } else if (mode === 'state-before-journal') {
    for (const [index, bytes] of journalsA.entries()) {
      const path = join(desktop, `profiles.journal.${index}`);
      if (bytes) await writeFile(path, bytes);
      else await unlink(path).catch(() => undefined);
    }
  } else if (mode === 'alternate-slot-rollback') {
    const state = JSON.parse(await readFile(join(desktop, 'profiles.json'), 'utf8')) as { generation: string };
    const newest = Number(BigInt(state.generation) % 2n);
    const older = (newest + 1) % 2;
    await writeFile(
      join(desktop, `profiles.journal.${newest}`),
      await readFile(join(desktop, `profiles.journal.${older}`)),
    );
  } else {
    throw new Error(`Unknown visibility mode: ${mode}`);
  }
  process.kill(process.pid, 'SIGKILL');
}
