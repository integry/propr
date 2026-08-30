import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DesktopProfile,
  DesktopProfileInput,
  DesktopProfileList,
  StorageSecurity,
} from './shared/contract';
import { normalizeApiBaseUrl } from './security';

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_CREDENTIAL_LENGTH = 65_536;

export interface StoredCredential {
  version: 1;
  profileId: string;
  origin: string;
  token: string;
}

export interface DetachedProfile {
  profile: DesktopProfile;
  credential: StoredCredential | null;
}

export interface SavedProfileTransaction {
  profile: DesktopProfile;
  detachedCredential: StoredCredential | null;
  originChanged: boolean;
}

export interface PairedProfileTransaction {
  profile: DesktopProfile;
  identityEpoch: string;
  originChanged: boolean;
}

export interface ProfileCredentialSnapshot {
  profile: DesktopProfile | null;
  credential: StoredCredential | null;
  identityEpoch: string | null;
  activeProfileId: string | null;
}

interface LegacyPersistedState {
  version: 1;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
}

interface VersionTwoPersistedState {
  version: 2;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
  credentialSlots: Record<string, string>;
}

interface PendingRevocationRecord {
  version: 1;
  profileId: string;
  origin: string;
  slot: string;
}

interface PersistedState {
  version: 3;
  generation: number;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
  credentialSlots: Record<string, string>;
  credentialEpochs: Record<string, string>;
  pendingRevocations: Record<string, PendingRevocationRecord>;
}

interface JournalPayload {
  version: 1;
  state: PersistedState;
  encryptedSlots: Record<string, string>;
}

interface JournalRecord extends JournalPayload {
  checksum: string;
}

export interface PendingCredentialRevocation {
  id: string;
  credential: StoredCredential;
}

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  backend(): string;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export type ProfileStoreDurabilityStep =
  | 'credential-encrypted'
  | 'credential-written'
  | 'credential-fsynced'
  | 'credential-renamed'
  | 'credential-directory-fsynced'
  | 'state-written'
  | 'state-fsynced'
  | 'journal-written'
  | 'journal-fsynced'
  | 'state-renamed'
  | 'state-directory-fsynced'
  | 'old-credential-removed';

export interface ProfileStoreOptions {
  afterDurabilityStep?(step: ProfileStoreDurabilityStep): void | Promise<void>;
}

const emptyState = (): PersistedState => ({
  version: 3,
  generation: 0,
  activeProfileId: null,
  profiles: [],
  credentialSlots: {},
  credentialEpochs: {},
  pendingRevocations: {},
});

const SLOT_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.[0-9a-f-]{36}\.bin$/i;
const IDENTITY_EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_PENDING_REVOCATIONS = 64;

const validDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const validProfile = (value: unknown): value is DesktopProfile => {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Record<string, unknown>;
  return typeof profile.id === 'string'
    && PROFILE_ID_PATTERN.test(profile.id)
    && typeof profile.label === 'string'
    && profile.label.length > 0
    && profile.label.length <= 80
    && typeof profile.apiBaseUrl === 'string'
    && normalizeApiBaseUrl(profile.apiBaseUrl) === profile.apiBaseUrl
    && validDate(profile.createdAt)
    && validDate(profile.updatedAt);
};

const validCredentialSlots = (value: unknown): value is Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const slots = new Set<string>();
  for (const [profileId, slot] of Object.entries(value as Record<string, unknown>)) {
    if (!PROFILE_ID_PATTERN.test(profileId) || typeof slot !== 'string'
      || SLOT_PATTERN.exec(slot)?.[1] !== profileId || slots.has(slot)) return false;
    slots.add(slot);
  }
  return true;
};

const parseState = (contents: string): PersistedState | VersionTwoPersistedState | LegacyPersistedState => {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Desktop profile store is invalid');
  const state = value as Record<string, unknown>;
  if ((state.version !== 1 && state.version !== 2 && state.version !== 3)
    || !Array.isArray(state.profiles) || !state.profiles.every(validProfile)) {
    throw new Error('Desktop profile store is invalid');
  }
  if (state.activeProfileId !== null && (
    typeof state.activeProfileId !== 'string'
    || !state.profiles.some((profile: DesktopProfile) => profile.id === state.activeProfileId)
  )) {
    throw new Error('Desktop active profile is invalid');
  }
  if (state.version === 2 && !validCredentialSlots(state.credentialSlots)) {
    throw new Error('Desktop credential state is invalid');
  }
  if (state.version === 3) {
    if (!Number.isSafeInteger(state.generation) || (state.generation as number) < 0
      || !validCredentialSlots(state.credentialSlots)
      || !state.credentialEpochs || typeof state.credentialEpochs !== 'object'
      || Array.isArray(state.credentialEpochs)
      || !state.pendingRevocations || typeof state.pendingRevocations !== 'object'
      || Array.isArray(state.pendingRevocations)) throw new Error('Desktop credential state is invalid');
    const slots = state.credentialSlots as Record<string, string>;
    const epochs = state.credentialEpochs as Record<string, unknown>;
    if (Object.keys(slots).length !== Object.keys(epochs).length
      || Object.entries(epochs).some(([profileId, epoch]) => !(profileId in slots)
        || typeof epoch !== 'string' || !IDENTITY_EPOCH_PATTERN.test(epoch))) {
      throw new Error('Desktop credential identity state is invalid');
    }
    const pending = Object.entries(state.pendingRevocations as Record<string, unknown>);
    if (pending.length > MAX_PENDING_REVOCATIONS) throw new Error('Desktop revocation state is invalid');
    const pendingSlots = new Set<string>();
    for (const [id, raw] of pending) {
      if (!/^[0-9a-f-]{36}$/i.test(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Desktop revocation state is invalid');
      }
      const record = raw as Record<string, unknown>;
      if (record.version !== 1 || typeof record.profileId !== 'string'
        || !PROFILE_ID_PATTERN.test(record.profileId) || typeof record.origin !== 'string'
        || normalizeApiBaseUrl(record.origin) !== record.origin || typeof record.slot !== 'string'
        || SLOT_PATTERN.exec(record.slot)?.[1] !== record.profileId
        || Object.values(slots).includes(record.slot) || pendingSlots.has(record.slot)) {
        throw new Error('Desktop revocation state is invalid');
      }
      pendingSlots.add(record.slot);
    }
  }
  return state as unknown as PersistedState | VersionTwoPersistedState | LegacyPersistedState;
};

const journalChecksum = (payload: JournalPayload): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('base64url');

const parseJournal = (contents: string): JournalRecord => {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Desktop transaction journal is invalid');
  const record = value as JournalRecord;
  const state = parseState(JSON.stringify(record.state));
  if (record.version !== 1 || state.version !== 3 || !record.encryptedSlots
    || typeof record.encryptedSlots !== 'object' || Array.isArray(record.encryptedSlots)
    || Object.entries(record.encryptedSlots).some(([slot, bytes]) => !SLOT_PATTERN.test(slot)
      || typeof bytes !== 'string' || !/^[A-Za-z0-9_-]*$/.test(bytes))) {
    throw new Error('Desktop transaction journal is invalid');
  }
  const payload: JournalPayload = { version: 1, state, encryptedSlots: record.encryptedSlots };
  if (record.checksum !== journalChecksum(payload)) throw new Error('Desktop transaction journal checksum failed');
  return { ...payload, checksum: record.checksum };
};

const encryptionStatus = (encryption: EncryptionProvider): StorageSecurity => {
  const backend = encryption.backend();
  if (!encryption.isEncryptionAvailable()) {
    return { available: false, backend, reason: 'os-encryption-unavailable' };
  }
  if (backend === 'basic_text') {
    return { available: false, backend, reason: 'insecure-basic-text-backend' };
  }
  return { available: true, backend };
};

const assertProfileId: (profileId: unknown) => asserts profileId is string = (profileId) => {
  if (typeof profileId !== 'string' || !PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('Invalid desktop profile id');
  }
};

const normalizedProfileInput = (input: DesktopProfileInput): Omit<DesktopProfile, 'createdAt' | 'updatedAt'> => {
  if (!input || typeof input !== 'object') throw new Error('Invalid desktop profile');
  const label = input.label?.trim();
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl ?? '');
  if (!label || label.length > 80) throw new Error('Profile label must contain 1 to 80 characters');
  if (!apiBaseUrl) throw new Error('Use HTTPS, or HTTP on localhost, for the ProPR API URL');
  const id = input.id ?? randomUUID();
  assertProfileId(id);
  return { id, label, apiBaseUrl };
};

export class ProfileStore {
  readonly #directory: string;
  readonly #statePath: string;
  readonly #journalPaths: readonly [string, string];
  readonly #credentialsDirectory: string;
  readonly #encryption: EncryptionProvider;
  readonly #options: ProfileStoreOptions;
  #mutation = Promise.resolve();

  constructor(userDataPath: string, encryption: EncryptionProvider, options: ProfileStoreOptions = {}) {
    this.#directory = join(userDataPath, 'desktop');
    this.#statePath = join(this.#directory, 'profiles.json');
    this.#journalPaths = [
      join(this.#directory, 'profiles.journal.0'),
      join(this.#directory, 'profiles.journal.1'),
    ];
    this.#credentialsDirectory = join(this.#directory, 'credentials');
    this.#encryption = encryption;
    this.#options = options;
  }

  security(): StorageSecurity {
    return encryptionStatus(this.#encryption);
  }

  list(): Promise<DesktopProfileList> {
    return this.#mutate(async () => {
      const state = await this.#readState();
      return {
        profiles: state.profiles.map(profile => ({ ...profile })),
        activeProfileId: state.activeProfileId,
      };
    });
  }

  save(input: DesktopProfileInput): Promise<DesktopProfile> {
    return this.saveAndDetachCredential(input).then(result => result.profile);
  }

  saveAndDetachCredential(input: DesktopProfileInput): Promise<SavedProfileTransaction> {
    return this.#mutate(async () => {
      const normalized = normalizedProfileInput(input);
      const state = await this.#readState();
      const existing = state.profiles.find(profile => profile.id === normalized.id);
      const originChanged = existing !== undefined && existing.apiBaseUrl !== normalized.apiBaseUrl;
      let detachedCredential: StoredCredential | null = null;
      let detachedSlot: string | undefined;
      if (!existing || originChanged) {
        detachedCredential = await this.#captureCredentialFile(state, normalized.id);
        detachedSlot = state.credentialSlots[normalized.id];
        delete state.credentialSlots[normalized.id];
        delete state.credentialEpochs[normalized.id];
        if (originChanged && state.activeProfileId === normalized.id) state.activeProfileId = null;
      }
      const now = new Date().toISOString();
      const profile: DesktopProfile = {
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.profiles = [...state.profiles.filter(item => item.id !== profile.id), profile];
      const durable = await this.#writeState(state);
      if (durable && detachedSlot) await this.#unlinkSlot(detachedSlot).catch(() => undefined);
      return { profile: { ...profile }, detachedCredential: durable ? detachedCredential : null, originChanged };
    });
  }

  commitPairedProfile(
    input: DesktopProfileInput,
    credential: StoredCredential,
    expected: ProfileCredentialSnapshot,
    isCurrent: () => boolean,
    beginPublish?: () => (() => void) | null,
    onPublished?: () => void,
  ): Promise<PairedProfileTransaction | null | { stored: false; reason: 'encryption-unavailable' }> {
    const normalized = normalizedProfileInput(input);
    if (credential.version !== 1
      || credential.profileId !== normalized.id
      || credential.origin !== normalized.apiBaseUrl
      || typeof credential.token !== 'string'
      || credential.token.length > MAX_CREDENTIAL_LENGTH
      || !/^propr_it_[A-Za-z0-9_-]{43}$/.test(credential.token)) {
      throw new Error('Credential does not match the paired desktop profile');
    }
    if (!this.security().available) return Promise.resolve({ stored: false, reason: 'encryption-unavailable' });

    return this.#mutate(async () => {
      const state = await this.#readState();
      const existing = state.profiles.find(profile => profile.id === normalized.id) ?? null;
      const existingCredential = await this.#readCredentialFile(state, normalized.id);
      const existingEpoch = state.credentialEpochs[normalized.id] ?? null;
      if (!isCurrent()
        || state.activeProfileId !== expected.activeProfileId
        || !this.#sameProfile(existing, expected.profile)
        || !this.#sameOptionalCredential(existingCredential, expected.credential)
        || existingEpoch !== expected.identityEpoch) return null;

      const now = new Date().toISOString();
      const profile: DesktopProfile = {
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const originChanged = existing !== null && existing.apiBaseUrl !== profile.apiBaseUrl;
      state.profiles = [...state.profiles.filter(item => item.id !== profile.id), profile];
      if (originChanged && state.activeProfileId === profile.id) state.activeProfileId = null;

      const previousSlot = state.credentialSlots[profile.id];
      const stagedSlot = await this.#stageCredential(credential);
      const identityEpoch = randomBytes(16).toString('base64url');
      let committed = false;
      try {
        if (!isCurrent()) return null;
        // The staged slot is durable while the old state still names A. This
        // single atomic state-file rename is the only A -> B commit point.
        state.credentialSlots[profile.id] = stagedSlot;
        state.credentialEpochs[profile.id] = identityEpoch;
        if (previousSlot && existingCredential) {
          if (Object.keys(state.pendingRevocations).length >= MAX_PENDING_REVOCATIONS) {
            throw new Error('Pending desktop credential revocations must complete before pairing again.');
          }
          const revocationId = randomUUID();
          state.pendingRevocations[revocationId] = {
            version: 1,
            profileId: existingCredential.profileId,
            origin: existingCredential.origin,
            slot: previousSlot,
          };
        }
        const durable = await this.#writeState(state, isCurrent, beginPublish, onPublished);
        if (durable === null) return null;
        committed = true;
        return {
          profile: { ...profile },
          identityEpoch,
          originChanged,
        };
      } finally {
        if (!committed) {
          await this.#unlinkSlot(stagedSlot).catch(() => undefined);
        }
      }
    });
  }

  remove(profileId: string): Promise<void> {
    return this.detachProfile(profileId).then(() => undefined);
  }

  detachProfile(profileId: string): Promise<DetachedProfile | null> {
    assertProfileId(profileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const profile = state.profiles.find(item => item.id === profileId);
      const credential = await this.#captureCredentialFile(state, profileId);
      const previousSlot = state.credentialSlots[profileId];
      delete state.credentialSlots[profileId];
      delete state.credentialEpochs[profileId];
      if (!profile && !previousSlot) return null;
      state.profiles = state.profiles.filter(profile => profile.id !== profileId);
      if (state.activeProfileId === profileId) state.activeProfileId = null;
      const durable = await this.#writeState(state);
      if (durable && previousSlot) await this.#unlinkSlot(previousSlot).catch(() => undefined);
      if (!profile) return null;
      return { profile: { ...profile }, credential: durable ? credential : null };
    });
  }

  activateProfile(
    expected: StoredCredential,
    expectedIdentityEpoch: string,
    expectedProfileOrigin: string,
    expectedActiveProfileId: string | null,
    isCurrent: () => boolean,
  ): Promise<string | null> {
    const profileId = expected?.profileId;
    assertProfileId(profileId);
    if (normalizeApiBaseUrl(expectedProfileOrigin) !== expectedProfileOrigin) {
      throw new Error('Invalid desktop API URL');
    }
    if (expectedActiveProfileId !== null) assertProfileId(expectedActiveProfileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const profile = state.profiles.find(item => item.id === profileId);
      const credential = await this.#readCredentialFile(state, profileId);
      if (!isCurrent()
        || state.activeProfileId !== expectedActiveProfileId
        || profile?.apiBaseUrl !== expectedProfileOrigin
        || expected.origin !== expectedProfileOrigin
        || credential?.origin !== profile.apiBaseUrl
        || state.credentialEpochs[profileId] !== expectedIdentityEpoch
        || !this.#sameCredential(credential, expected)) return null;

      const previousActiveProfileId = state.activeProfileId;
      state.activeProfileId = profileId;
      await this.#writeState(state);
      if (isCurrent()) return expectedIdentityEpoch;

      // A generation/selection change that occurred during the atomic file
      // replacement must not leave the candidate selected.
      state.activeProfileId = previousActiveProfileId;
      await this.#writeState(state);
      return null;
    });
  }

  setActive(profileId: string | null): Promise<void> {
    if (profileId !== null) assertProfileId(profileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (profileId !== null && !state.profiles.some(profile => profile.id === profileId)) {
        throw new Error('Desktop profile does not exist');
      }
      state.activeProfileId = profileId;
      await this.#writeState(state);
    });
  }

  readCredential(profileId: string): Promise<StoredCredential | null> {
    assertProfileId(profileId);
    if (!this.security().available) return Promise.resolve(null);
    return this.#mutate(async () => this.#readCredentialFile(await this.#readState(), profileId));
  }

  readProfileCredential(profileId: string): Promise<ProfileCredentialSnapshot> {
    assertProfileId(profileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const profile = state.profiles.find(item => item.id === profileId) ?? null;
      const credential = this.security().available
        ? await this.#readCredentialFile(state, profileId)
        : null;
      return {
        profile: profile ? { ...profile } : null,
        credential,
        identityEpoch: state.credentialEpochs[profileId] ?? null,
        activeProfileId: state.activeProfileId,
      };
    });
  }

  async #readCredentialFile(state: PersistedState, profileId: string): Promise<StoredCredential | null> {
    const slot = state.credentialSlots[profileId];
    if (!slot) return null;
    return this.#readCredentialSlot(slot, profileId);
  }

  async #readCredentialSlot(slot: string, profileId: string): Promise<StoredCredential | null> {
    try {
      const encrypted = await readFile(join(this.#credentialsDirectory, slot));
      const value = JSON.parse(this.#encryption.decrypt(encrypted)) as unknown;
      if (!value || typeof value !== 'object') return null;
      const credential = value as Record<string, unknown>;
      if (credential.version !== 1 || credential.profileId !== profileId
        || typeof credential.origin !== 'string'
        || normalizeApiBaseUrl(credential.origin) !== credential.origin
        || typeof credential.token !== 'string'
        || !/^propr_it_[A-Za-z0-9_-]{43}$/.test(credential.token)) return null;
      return credential as unknown as StoredCredential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async #captureCredentialFile(state: PersistedState, profileId: string): Promise<StoredCredential | null> {
    try {
      return await this.#readCredentialFile(state, profileId);
    } catch {
      // Removal is the security boundary. Decrypt/keychain/read failures only
      // prevent the optional remote revoke, never explicit local detachment.
      return null;
    }
  }

  #sameCredential(actual: StoredCredential | null, expected: StoredCredential): boolean {
    return actual !== null
      && actual.version === expected.version
      && actual.profileId === expected.profileId
      && actual.origin === expected.origin
      && actual.token === expected.token;
  }

  #sameOptionalCredential(actual: StoredCredential | null, expected: StoredCredential | null): boolean {
    return expected === null ? actual === null : this.#sameCredential(actual, expected);
  }

  #sameProfile(actual: DesktopProfile | null, expected: DesktopProfile | null): boolean {
    return expected === null ? actual === null : actual !== null
      && actual.id === expected.id
      && actual.label === expected.label
      && actual.apiBaseUrl === expected.apiBaseUrl
      && actual.createdAt === expected.createdAt
      && actual.updatedAt === expected.updatedAt;
  }

  async writeCredential(credential: StoredCredential): Promise<{ stored: true } | { stored: false; reason: 'encryption-unavailable' }> {
    const profileId = credential?.profileId;
    assertProfileId(profileId);
    if (credential.version !== 1 || normalizeApiBaseUrl(credential.origin) !== credential.origin
      || typeof credential.token !== 'string' || credential.token.length > MAX_CREDENTIAL_LENGTH
      || !/^propr_it_[A-Za-z0-9_-]{43}$/.test(credential.token)) {
      throw new Error('Credential must contain 1 to 65536 characters');
    }
    if (!this.security().available) return { stored: false, reason: 'encryption-unavailable' };
    return this.#mutate(async () => {
      const state = await this.#readState();
      const previousSlot = state.credentialSlots[profileId];
      const stagedSlot = await this.#stageCredential(credential);
      let committed = false;
      try {
        state.credentialSlots[profileId] = stagedSlot;
        state.credentialEpochs[profileId] = randomBytes(16).toString('base64url');
        const durable = await this.#writeState(state);
        committed = true;
        if (!durable) return { stored: true };
      } finally {
        if (!committed) {
          await this.#unlinkSlot(stagedSlot).catch(() => undefined);
        }
      }
      if (previousSlot) {
        await this.#unlinkSlot(previousSlot).catch(() => undefined);
        await this.#step('old-credential-removed').catch(() => undefined);
      }
      return { stored: true };
    });
  }

  removeCredential(profileId: string): Promise<void> {
    assertProfileId(profileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const previousSlot = state.credentialSlots[profileId];
      if (!previousSlot) return;
      delete state.credentialSlots[profileId];
      delete state.credentialEpochs[profileId];
      const durable = await this.#writeState(state);
      if (durable) await this.#unlinkSlot(previousSlot).catch(() => undefined);
    });
  }

  removeCredentialIfCurrent(
    expected: StoredCredential,
    expectedProfileOrigin: string,
    isCurrent: () => boolean,
  ): Promise<boolean> {
    const profileId = expected?.profileId;
    assertProfileId(profileId);
    if (normalizeApiBaseUrl(expectedProfileOrigin) !== expectedProfileOrigin) {
      throw new Error('Invalid desktop API URL');
    }
    return this.#mutate(async () => {
      const state = await this.#readState();
      const profile = state.profiles.find(item => item.id === profileId);
      const credential = await this.#readCredentialFile(state, profileId);
      if (!isCurrent()
        || profile?.apiBaseUrl !== expectedProfileOrigin
        || !credential
        || credential.version !== expected.version
        || credential.profileId !== expected.profileId
        || credential.origin !== expected.origin
        || credential.token !== expected.token) return false;
      const previousSlot = state.credentialSlots[profileId];
      delete state.credentialSlots[profileId];
      delete state.credentialEpochs[profileId];
      const durable = await this.#writeState(state);
      if (durable && previousSlot) await this.#unlinkSlot(previousSlot).catch(() => undefined);
      return true;
    });
  }

  pendingRevocations(): Promise<PendingCredentialRevocation[]> {
    if (!this.security().available) return Promise.resolve([]);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const pending: PendingCredentialRevocation[] = [];
      for (const [id, record] of Object.entries(state.pendingRevocations)) {
        const credential = await this.#readCredentialSlot(record.slot, record.profileId);
        if (!credential || credential.origin !== record.origin) {
          throw new Error('Desktop pending revocation material is unavailable');
        }
        pending.push({ id, credential });
      }
      return pending;
    });
  }

  completePendingRevocation(id: string, expected: StoredCredential): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop revocation id');
    return this.#mutate(async () => {
      const state = await this.#readState();
      const record = state.pendingRevocations[id];
      if (!record || record.profileId !== expected.profileId || record.origin !== expected.origin) return false;
      const actual = await this.#readCredentialSlot(record.slot, record.profileId);
      if (!this.#sameCredential(actual, expected)) return false;
      delete state.pendingRevocations[id];
      await this.#writeState(state);
      await this.#unlinkSlot(record.slot);
      await this.#step('old-credential-removed').catch(() => undefined);
      return true;
    });
  }

  async #readState(): Promise<PersistedState> {
    try {
      const state = parseState(await readFile(this.#statePath, 'utf8'));
      if (state.version !== 3) throw new Error('Desktop profile store recovery was not completed');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #writeState(
    state: PersistedState,
    isCurrent?: () => boolean,
    beginPublish?: () => (() => void) | null,
    onPublished?: () => void,
  ): Promise<true | null> {
    await this.#ensureDirectories();
    state.generation += 1;
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    let releasePublish: (() => void) | undefined;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#step('state-written');
      await this.#fsyncFile(temporary);
      await this.#step('state-fsynced');
      if (beginPublish) {
        const release = beginPublish();
        if (!release) {
          state.generation -= 1;
          return null;
        }
        releasePublish = release;
      } else if (isCurrent && !isCurrent()) {
        state.generation -= 1;
        return null;
      }

      // The alternating, self-contained journal is the durable commit point.
      // It uses a write-through file handle supported by Windows and embeds only
      // already OS-encrypted credential bytes, so recovery does not depend on a
      // directory flush, rename visibility, or the new slot directory entry.
      await this.#writeJournal(state, onPublished);

      // profiles.json is a convenient atomic mirror. Once the journal is synced,
      // failure or rollback of this rename cannot make the prior state authoritative.
      try {
        await rename(temporary, this.#statePath);
        await this.#step('state-renamed').catch(() => undefined);
        const directoryDurable = await this.#fsyncDirectory(this.#directory).then(() => true, () => false);
        if (directoryDurable) await this.#step('state-directory-fsynced').catch(() => undefined);
      } catch {
        // The journal is authoritative and #recover repairs this mirror before
        // the next read or mutation.
      }
      await chmod(this.#statePath, 0o600).catch(() => undefined);
      return true;
    } finally {
      releasePublish?.();
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #writeJournal(state: PersistedState, onDurable?: () => void): Promise<void> {
    const referenced = new Set([
      ...Object.values(state.credentialSlots),
      ...Object.values(state.pendingRevocations).map(record => record.slot),
    ]);
    const encryptedSlots: Record<string, string> = {};
    for (const slot of referenced) {
      encryptedSlots[slot] = (await readFile(join(this.#credentialsDirectory, slot))).toString('base64url');
    }
    const payload: JournalPayload = {
      version: 1,
      state: JSON.parse(JSON.stringify(state)) as PersistedState,
      encryptedSlots,
    };
    const record: JournalRecord = { ...payload, checksum: journalChecksum(payload) };
    const path = this.#journalPaths[state.generation % this.#journalPaths.length];
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_SYNC,
      0o600,
    );
    let committed = false;
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      committed = true;
      onDurable?.();
      await this.#step('journal-written').catch(() => undefined);
      await handle.sync().then(
        () => this.#step('journal-fsynced').catch(() => undefined),
        () => undefined,
      );
    } finally {
      await handle.close().catch(error => {
        if (!committed) throw error;
      });
    }
    await chmod(path, 0o600).catch(() => undefined);
  }

  async #stageCredential(credential: StoredCredential): Promise<string> {
    await this.#ensureDirectories();
    const slot = `${credential.profileId}.${randomUUID()}.bin`;
    const target = join(this.#credentialsDirectory, slot);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.#encryption.encrypt(JSON.stringify(credential));
      await this.#step('credential-encrypted');
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await this.#step('credential-written');
      await this.#fsyncFile(temporary);
      await this.#step('credential-fsynced');
      await rename(temporary, target);
      await this.#step('credential-renamed');
      const directoryDurable = await this.#fsyncDirectory(this.#credentialsDirectory).then(() => true, () => false);
      if (directoryDurable) await this.#step('credential-directory-fsynced');
      await chmod(target, 0o600).catch(() => undefined);
      return slot;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #recover(): Promise<void> {
    await this.#ensureDirectories();
    const journalRecords: JournalRecord[] = [];
    for (const path of this.#journalPaths) {
      try {
        journalRecords.push(parseJournal(await readFile(path, 'utf8')));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
          && !(error instanceof SyntaxError)
          && !(error instanceof Error && error.message.startsWith('Desktop transaction journal'))) throw error;
      }
    }
    journalRecords.sort((left, right) => left.state.generation - right.state.generation);
    const authoritativeJournal = journalRecords.at(-1);

    let parsed: PersistedState | VersionTwoPersistedState | LegacyPersistedState;
    try {
      parsed = parseState(await readFile(this.#statePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parsed = { version: 1, activeProfileId: null, profiles: [] };
    }

    let state: PersistedState;
    if (authoritativeJournal) {
      state = authoritativeJournal.state;
      for (const [slot, encoded] of Object.entries(authoritativeJournal.encryptedSlots)) {
        const expectedBytes = Buffer.from(encoded, 'base64url');
        try {
          const actualBytes = await readFile(join(this.#credentialsDirectory, slot));
          if (actualBytes.equals(expectedBytes)) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await this.#writeThroughFile(join(this.#credentialsDirectory, slot), expectedBytes);
      }
      const mirrorMatches = parsed.version === 3
        && JSON.stringify(parsed) === JSON.stringify(state);
      if (!mirrorMatches) await this.#writeStateMirror(state);
    } else if (parsed.version === 1) {
      state = {
        version: 3,
        generation: 0,
        activeProfileId: parsed.activeProfileId,
        profiles: parsed.profiles.map(profile => ({ ...profile })),
        credentialSlots: {},
        credentialEpochs: {},
        pendingRevocations: {},
      };
      const entries = await readdir(this.#credentialsDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.bin$/.exec(entry.name);
        if (!match || !entry.isFile()) continue;
        const profileId = match[1];
        const bytes = await readFile(join(this.#credentialsDirectory, entry.name));
        const slot = `${profileId}.${randomUUID()}.bin`;
        const slotPath = join(this.#credentialsDirectory, slot);
        await writeFile(slotPath, bytes, { mode: 0o600 });
        await this.#fsyncFile(slotPath);
        state.credentialSlots[profileId] = slot;
        state.credentialEpochs[profileId] = randomBytes(16).toString('base64url');
      }
      await this.#fsyncDirectory(this.#credentialsDirectory).catch(() => undefined);
      await this.#writeState(state);
    } else if (parsed.version === 2) {
      state = {
        version: 3,
        generation: 0,
        activeProfileId: parsed.activeProfileId,
        profiles: parsed.profiles.map(profile => ({ ...profile })),
        credentialSlots: { ...parsed.credentialSlots },
        credentialEpochs: Object.fromEntries(
          Object.keys(parsed.credentialSlots).map(profileId => [profileId, randomBytes(16).toString('base64url')]),
        ),
        pendingRevocations: {},
      };
      await this.#writeState(state);
    } else {
      state = parsed;
      // A v3 file predating journal creation is migrated into the durable
      // write-through protocol before any unreferenced slot cleanup.
      await this.#writeState(state);
    }

    const referenced = new Set([
      ...Object.values(state.credentialSlots),
      ...Object.values(state.pendingRevocations).map(record => record.slot),
    ]);
    const entries = await readdir(this.#credentialsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) {
        await unlink(join(this.#credentialsDirectory, entry.name));
      }
    }
    const stateEntries = await readdir(this.#directory, { withFileTypes: true });
    for (const entry of stateEntries) {
      if (entry.isFile() && /^profiles\.json\..+\.tmp$/.test(entry.name)) {
        await unlink(join(this.#directory, entry.name));
      }
    }
    await this.#fsyncDirectory(this.#credentialsDirectory).catch(() => undefined);
    await this.#fsyncDirectory(this.#directory).catch(() => undefined);
    for (const slot of referenced) {
      try {
        await readFile(join(this.#credentialsDirectory, slot));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('Desktop credential state is incomplete');
        }
        throw error;
      }
    }
    for (const entry of entries) {
      if (!entry.isFile() || referenced.has(entry.name)) continue;
      if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:\.[0-9a-f-]{36})?\.bin$/i.test(entry.name)) {
        await unlink(join(this.#credentialsDirectory, entry.name));
      }
    }
    await this.#fsyncDirectory(this.#credentialsDirectory).catch(() => undefined);
    await this.#fsyncDirectory(this.#directory).catch(() => undefined);
  }

  async #writeStateMirror(state: PersistedState): Promise<void> {
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.recovery.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#fsyncFile(temporary);
      await rename(temporary, this.#statePath);
      await this.#fsyncDirectory(this.#directory).catch(() => undefined);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #writeThroughFile(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_SYNC,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #fsyncFile(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #fsyncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #unlinkSlot(slot: string): Promise<void> {
    await unlink(join(this.#credentialsDirectory, slot)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  #step(step: ProfileStoreDurabilityStep): Promise<void> {
    return Promise.resolve(this.#options.afterDurabilityStep?.(step));
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#credentialsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    await chmod(this.#credentialsDirectory, 0o700).catch(() => undefined);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const recoveredOperation = async () => {
      await this.#recover();
      return operation();
    };
    const result = this.#mutation.then(recoveredOperation, recoveredOperation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
  }

}
