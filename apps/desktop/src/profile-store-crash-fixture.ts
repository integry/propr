import { ProfileStore, type EncryptionProvider, type ProfileStoreDurabilityStep } from './profile-store';

const [directory, crashStep] = process.argv.slice(2) as [string, ProfileStoreDurabilityStep];
const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  backend: () => 'keychain',
  encrypt: value => Buffer.from(Buffer.from(value, 'utf8').toString('base64url'), 'utf8'),
  decrypt: value => Buffer.from(value.toString(), 'base64url').toString('utf8'),
};
const store = new ProfileStore(directory, encryption, {
  afterDurabilityStep: step => {
    if (step === crashStep) process.kill(process.pid, 'SIGKILL');
  },
});
const baseline = await store.readProfileCredential('profile-1');
await store.commitPairedProfile(
  { id: 'profile-1', label: 'Replacement', apiBaseUrl: 'https://propr.example.com' },
  {
    version: 1,
    profileId: 'profile-1',
    origin: 'https://propr.example.com',
    token: `propr_it_${'B'.repeat(43)}`,
  },
  baseline,
  () => true,
);
