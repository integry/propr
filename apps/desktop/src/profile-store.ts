import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
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
  credentialGeneration: string;
  deferred: boolean;
}

interface PersistedState {
  version: 3;
  generation: string;
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

interface LegacyJournalRecord extends JournalPayload {
  checksum: string;
}

interface JournalRecord {
  version: 2;
  generation: string;
  encryptedPayload: string;
  checksum: string;
}

interface AuthenticatedJournal {
  generation: bigint;
  state: PersistedState;
  encryptedSlots: Record<string, string>;
}

export interface PendingCredentialRevocation {
  id: string;
  credential: StoredCredential;
  credentialGeneration: string;
  deferred: boolean;
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
  | 'journal-closed'
  | 'journal-reopened'
  | 'journal-prepared-verified'
  | 'journal-committed'
  | 'journal-commit-fsynced'
  | 'journal-commit-verified'
  | 'journal-commit-closed'
  | 'state-renamed'
  | 'state-directory-fsynced'
  | 'old-credential-removed';

export interface ProfileStoreOptions {
  afterDurabilityStep?(step: ProfileStoreDurabilityStep): void | Promise<void>;
  beforeIO?(operation: ProfileStoreIOOperation): void | Promise<void>;
}

export type ProfileStoreIOOperation =
  | 'credential-write'
  | 'credential-flush'
  | 'credential-replace'
  | 'journal-write'
  | 'journal-flush'
  | 'journal-reopen'
  | 'journal-commit'
  | 'journal-commit-flush'
  | 'journal-verify'
  | 'mirror-write'
  | 'mirror-flush'
  | 'mirror-replace'
  | 'metadata-flush';

const emptyState = (): PersistedState => ({
  version: 3,
  generation: '0',
  activeProfileId: null,
  profiles: [],
  credentialSlots: {},
  credentialEpochs: {},
  pendingRevocations: {},
});

const SLOT_PATTERN = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.[0-9a-f-]{36}\.bin$/i;
const IDENTITY_EPOCH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_PENDING_REVOCATIONS = 64;
const MAX_JOURNAL_BYTES = (MAX_PENDING_REVOCATIONS + 1) * (MAX_CREDENTIAL_LENGTH * 2 + 4_096);
const RECOVERY_ERROR = 'Desktop profile recovery state is unavailable';

/**
 * Flush an existing file through a writable handle. Windows rejects fsync on
 * the read-only handle Node creates for `open(path, 'r')`; O_WRONLY is the
 * minimum access libuv needs for FlushFileBuffers and works on POSIX too.
 */
export const flushFileData = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_WRONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

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
    if (!((typeof state.generation === 'string' && /^(?:0|[1-9][0-9]{0,30})$/.test(state.generation))
        || (Number.isSafeInteger(state.generation) && (state.generation as number) >= 0))
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
      if (record.credentialGeneration === undefined && typeof record.slot === 'string') {
        record.credentialGeneration = createHash('sha256')
          .update(record.slot)
          .digest()
          .subarray(0, 16)
          .toString('base64url');
      }
      if (record.deferred === undefined) record.deferred = false;
      if (record.version !== 1 || typeof record.profileId !== 'string'
        || !PROFILE_ID_PATTERN.test(record.profileId) || typeof record.origin !== 'string'
        || normalizeApiBaseUrl(record.origin) !== record.origin || typeof record.slot !== 'string'
        || typeof record.credentialGeneration !== 'string'
        || !IDENTITY_EPOCH_PATTERN.test(record.credentialGeneration)
        || typeof record.deferred !== 'boolean'
        || SLOT_PATTERN.exec(record.slot)?.[1] !== record.profileId
        || Object.values(slots).includes(record.slot) || pendingSlots.has(record.slot)) {
        throw new Error('Desktop revocation state is invalid');
      }
      pendingSlots.add(record.slot);
    }
    state.generation = String(state.generation);
  }
  return state as unknown as PersistedState | VersionTwoPersistedState | LegacyPersistedState;
};

const journalChecksum = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('base64url');

const parseLegacyJournal = (contents: string): LegacyJournalRecord => {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Desktop transaction journal is invalid');
  const record = value as LegacyJournalRecord;
  const rawPayload = { version: 1 as const, state: record.state, encryptedSlots: record.encryptedSlots };
  if (record.checksum !== journalChecksum(JSON.stringify(rawPayload))) {
    throw new Error('Desktop transaction journal checksum failed');
  }
  const state = parseState(JSON.stringify(record.state));
  if (record.version !== 1 || state.version !== 3 || !record.encryptedSlots
    || typeof record.encryptedSlots !== 'object' || Array.isArray(record.encryptedSlots)
    || Object.entries(record.encryptedSlots).some(([slot, bytes]) => !SLOT_PATTERN.test(slot)
      || typeof bytes !== 'string' || !/^[A-Za-z0-9_-]*$/.test(bytes))) {
    throw new Error('Desktop transaction journal is invalid');
  }
  const payload: JournalPayload = { version: 1, state, encryptedSlots: record.encryptedSlots };
  return { ...payload, checksum: record.checksum };
};

const parseJournalEnvelope = (contents: string): JournalRecord => {
  if (Buffer.byteLength(contents) > MAX_JOURNAL_BYTES) throw new Error('Desktop transaction journal is invalid');
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Desktop transaction journal is invalid');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || typeof record.generation !== 'string'
    || !/^(?:0|[1-9][0-9]{0,30})$/.test(record.generation)
    || typeof record.encryptedPayload !== 'string'
    || record.encryptedPayload.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(record.encryptedPayload)
    || typeof record.checksum !== 'string'
    || record.checksum !== journalChecksum(record.encryptedPayload)) {
    throw new Error('Desktop transaction journal is invalid');
  }
  return record as unknown as JournalRecord;
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
  readonly #authenticatedJournalCache = new Map<string, AuthenticatedJournal>();
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
      if (!existing || originChanged) {
        detachedCredential = (await this.#moveCredentialToPending(state, normalized.id))?.credential ?? null;
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
    pendingRevocationId?: string,
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

      const previousSlot = state.credentialSlots[profile.id];
      const pending = pendingRevocationId ? state.pendingRevocations[pendingRevocationId] : undefined;
      if (pendingRevocationId && !pending) return null;
      const stagedSlot = pending?.slot ?? await this.#stageCredential(credential);
      const identityEpoch = pending?.credentialGeneration ?? randomBytes(16).toString('base64url');
      const stagedByThisCall = !pending;
      if (pending) {
        const pendingCredential = await this.#readCredentialSlot(pending.slot, pending.profileId);
        if (pending.profileId !== credential.profileId || pending.origin !== credential.origin
          || !this.#sameCredential(pendingCredential, credential)) {
          throw new Error('Pending desktop credential does not match the paired profile');
        }
      }
      let committed = false;
      try {
        if (!isCurrent()) return null;
        // Promote B and detach A through the same pending transition used by
        // deletion, origin edits and explicit credential replacement. These
        // are only in-memory changes until the single journal commit below.
        if (pendingRevocationId) delete state.pendingRevocations[pendingRevocationId];
        if (previousSlot) await this.#moveCredentialToPending(state, profile.id);
        state.profiles = [...state.profiles.filter(item => item.id !== profile.id), profile];
        if (originChanged && state.activeProfileId === profile.id) state.activeProfileId = null;
        // The staged slot is durable while the old state still names A. This
        // single atomic state-file rename is the only A -> B commit point.
        state.credentialSlots[profile.id] = stagedSlot;
        state.credentialEpochs[profile.id] = identityEpoch;
        const durable = await this.#writeState(state, isCurrent, beginPublish, onPublished);
        if (durable === null) return null;
        committed = true;
        return {
          profile: { ...profile },
          identityEpoch,
          originChanged,
        };
      } finally {
        if (!committed && stagedByThisCall) {
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
      const previousSlot = state.credentialSlots[profileId];
      const credential = (await this.#moveCredentialToPending(state, profileId))?.credential ?? null;
      if (!profile && !previousSlot) return null;
      state.profiles = state.profiles.filter(profile => profile.id !== profileId);
      if (state.activeProfileId === profileId) state.activeProfileId = null;
      const durable = await this.#writeState(state);
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

  async #moveCredentialToPending(
    state: PersistedState,
    profileId: string,
  ): Promise<(Omit<PendingCredentialRevocation, 'credential'> & { credential: StoredCredential | null }) | null> {
    const slot = state.credentialSlots[profileId];
    if (!slot) return null;
    if (Object.keys(state.pendingRevocations).length >= MAX_PENDING_REVOCATIONS) {
      throw new Error('Pending desktop credential revocations must complete before changing profiles.');
    }
    let credential: StoredCredential | null = null;
    try {
      credential = await this.#readCredentialSlot(slot, profileId);
    } catch {
      // The slot bytes were authenticated by the prior committed journal. Keep
      // them durable even while a keychain/backend read is temporarily failing.
    }
    const credentialGeneration = state.credentialEpochs[profileId];
    const profile = state.profiles.find(item => item.id === profileId);
    if (!credentialGeneration || (!credential && !profile)) {
      throw new Error('Desktop credential cannot be safely detached for revocation.');
    }
    const id = randomUUID();
    state.pendingRevocations[id] = {
      version: 1,
      profileId,
      origin: credential?.origin ?? profile!.apiBaseUrl,
      slot,
      credentialGeneration,
      deferred: false,
    };
    delete state.credentialSlots[profileId];
    delete state.credentialEpochs[profileId];
    return { id, credential, credentialGeneration, deferred: false };
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
      if (previousSlot) await this.#moveCredentialToPending(state, profileId);
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
      return { stored: true };
    });
  }

  removeCredential(profileId: string): Promise<void> {
    assertProfileId(profileId);
    return this.#mutate(async () => {
      const state = await this.#readState();
      if (!await this.#moveCredentialToPending(state, profileId)) return;
      await this.#writeState(state);
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
      await this.#moveCredentialToPending(state, profileId);
      await this.#writeState(state);
      return true;
    });
  }

  journalPendingRevocation(
    credential: StoredCredential,
  ): Promise<PendingCredentialRevocation | { stored: false; reason: 'encryption-unavailable' }> {
    const profileId = credential?.profileId;
    assertProfileId(profileId);
    if (credential.version !== 1 || normalizeApiBaseUrl(credential.origin) !== credential.origin
      || typeof credential.token !== 'string' || credential.token.length > MAX_CREDENTIAL_LENGTH
      || !/^propr_it_[A-Za-z0-9_-]{43}$/.test(credential.token)) {
      throw new Error('Invalid desktop credential revocation material');
    }
    if (!this.security().available) return Promise.resolve({ stored: false, reason: 'encryption-unavailable' });
    return this.#mutate(async () => {
      const state = await this.#readState();
      for (const [id, record] of Object.entries(state.pendingRevocations)) {
        if (record.profileId !== profileId || record.origin !== credential.origin) continue;
        const existing = await this.#readCredentialSlot(record.slot, record.profileId);
        if (this.#sameCredential(existing, credential)) {
          return {
            id,
            credential: { ...credential },
            credentialGeneration: record.credentialGeneration,
            deferred: record.deferred,
          };
        }
      }
      if (Object.keys(state.pendingRevocations).length >= MAX_PENDING_REVOCATIONS) {
        throw new Error('Pending desktop credential revocations must complete before pairing again.');
      }
      const slot = await this.#stageCredential(credential);
      const id = randomUUID();
      const credentialGeneration = randomBytes(16).toString('base64url');
      let committed = false;
      try {
        state.pendingRevocations[id] = {
          version: 1,
          profileId,
          origin: credential.origin,
          slot,
          credentialGeneration,
          deferred: true,
        };
        await this.#writeState(state);
        committed = true;
        return { id, credential: { ...credential }, credentialGeneration, deferred: true };
      } finally {
        if (!committed) await this.#unlinkSlot(slot).catch(() => undefined);
      }
    });
  }

  releasePendingRevocation(id: string, credentialGeneration: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id) || !IDENTITY_EPOCH_PATTERN.test(credentialGeneration)) {
      throw new Error('Invalid desktop revocation release');
    }
    return this.#mutate(async () => {
      const state = await this.#readState();
      const record = state.pendingRevocations[id];
      if (!record || record.credentialGeneration !== credentialGeneration) return false;
      if (!record.deferred) return true;
      record.deferred = false;
      await this.#writeState(state);
      return true;
    });
  }

  pendingRevocations(includeDeferred = true): Promise<PendingCredentialRevocation[]> {
    if (!this.security().available) return Promise.resolve([]);
    return this.#mutate(async () => {
      const state = await this.#readState();
      const pending: PendingCredentialRevocation[] = [];
      for (const [id, record] of Object.entries(state.pendingRevocations)) {
        if (record.deferred && !includeDeferred) continue;
        const credential = await this.#readCredentialSlot(record.slot, record.profileId);
        if (!credential || credential.origin !== record.origin) {
          throw new Error('Desktop pending revocation material is unavailable');
        }
        pending.push({
          id,
          credential,
          credentialGeneration: record.credentialGeneration,
          deferred: record.deferred,
        });
      }
      return pending;
    });
  }

  completePendingRevocation(
    id: string,
    expected: StoredCredential,
    expectedCredentialGeneration?: string,
  ): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid desktop revocation id');
    return this.#mutate(async () => {
      const state = await this.#readState();
      const record = state.pendingRevocations[id];
      if (!record || record.profileId !== expected.profileId || record.origin !== expected.origin
        || (expectedCredentialGeneration !== undefined
          && record.credentialGeneration !== expectedCredentialGeneration)) return false;
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
    const previousGeneration = state.generation;
    state.generation = (BigInt(state.generation) + 1n).toString();
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    let releasePublish: (() => void) | undefined;
    try {
      await this.#io('mirror-write');
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#step('state-written');
      await this.#io('mirror-flush');
      await this.#fsyncFile(temporary);
      await this.#step('state-fsynced');
      if (beginPublish) {
        const release = beginPublish();
        if (!release) {
          state.generation = previousGeneration;
          return null;
        }
        releasePublish = release;
      } else if (isCurrent && !isCurrent()) {
        state.generation = previousGeneration;
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
        await this.#io('mirror-replace');
        await rename(temporary, this.#statePath);
        await this.#step('state-renamed').catch(() => undefined);
        const directoryDurable = await this.#flushDirectoryIfSupported(this.#directory);
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

  async #writeJournal(state: PersistedState, onPublished?: () => void): Promise<void> {
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
    const encryptedPayload = this.#encryption.encrypt(JSON.stringify(payload)).toString('base64url');
    const record: JournalRecord = {
      version: 2,
      generation: String(state.generation),
      encryptedPayload,
      checksum: journalChecksum(encryptedPayload),
    };
    const path = this.#journalPaths[Number(BigInt(state.generation) % BigInt(this.#journalPaths.length))];
    const preparedContents = `P${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(preparedContents) > MAX_JOURNAL_BYTES) {
      throw new Error('Desktop transaction journal exceeds its bounded size');
    }
    const preparationHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
    try {
      await this.#io('journal-write');
      await preparationHandle.writeFile(preparedContents, 'utf8');
      await this.#step('journal-written');

      await this.#io('journal-flush');
      await preparationHandle.sync();
      await this.#step('journal-fsynced');
    } finally {
      await preparationHandle.close();
    }
    await this.#step('journal-closed');

    // Verification deliberately reopens the prepared slot through a writable
    // handle and does not use an in-memory authentication cache. The same held
    // handle remains bound to the verified bytes through C publication.
    await this.#io('journal-reopen');
    const verificationHandle = await open(path, constants.O_RDWR);
    try {
      await this.#step('journal-reopened');
      const verifiedContents = await this.#readHandleContents(verificationHandle);
      await this.#io('journal-verify');
      if (verifiedContents !== preparedContents) throw new Error(RECOVERY_ERROR);
      const prepared = await this.#authenticateJournal(verifiedContents, false, false);
      if (prepared.generation !== BigInt(state.generation)
        || JSON.stringify(prepared.state) !== JSON.stringify(state)
        || JSON.stringify(prepared.encryptedSlots) !== JSON.stringify(encryptedSlots)) {
        throw new Error(RECOVERY_ERROR);
      }
      await this.#step('journal-prepared-verified');

      // Refuse a pathname replacement before the authority transition. The
      // marker is nevertheless written through the already verified handle,
      // so a same-user same-size/generation replacement can never receive C.
      await this.#io('journal-commit');
      await this.#assertHandleStillNamesPath(verificationHandle, path, preparedContents.length);
      const written = await verificationHandle.write(Buffer.from('C'), 0, 1, 0);
      if (written.bytesWritten !== 1) throw new Error('Desktop transaction journal commit failed');
      // From this point B may be observed after a crash even if the explicit
      // flush reports failure. Notify the shared gate before anything fallible
      // so the fully verified B credential is never revoked as transient.
      onPublished?.();
      await this.#step('journal-committed');
      await this.#io('journal-commit-flush');
      await verificationHandle.sync();
      await this.#step('journal-commit-fsynced');
      const committedContents = await this.#readHandleContents(verificationHandle);
      if (committedContents !== `C${preparedContents.slice(1)}`) throw new Error(RECOVERY_ERROR);
      const committed = await this.#authenticateJournal(committedContents, true, false);
      if (committed.generation !== prepared.generation
        || JSON.stringify(committed.state) !== JSON.stringify(prepared.state)
        || JSON.stringify(committed.encryptedSlots) !== JSON.stringify(prepared.encryptedSlots)) {
        throw new Error(RECOVERY_ERROR);
      }
      await this.#step('journal-commit-verified');
    } finally {
      await verificationHandle.close();
    }
    await this.#step('journal-commit-closed');
    await chmod(path, 0o600).catch(() => undefined);
  }

  async #readHandleContents(handle: FileHandle): Promise<string> {
    const info = await handle.stat({ bigint: true });
    if (info.size > BigInt(MAX_JOURNAL_BYTES) || info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(RECOVERY_ERROR);
    }
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error(RECOVERY_ERROR);
      offset += result.bytesRead;
    }
    return bytes.toString('utf8');
  }

  async #assertHandleStillNamesPath(handle: FileHandle, path: string, expectedSize: number): Promise<void> {
    const [held, named] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (named.isSymbolicLink() || !named.isFile()
      || held.dev !== named.dev || held.ino !== named.ino
      || held.size !== BigInt(expectedSize) || named.size !== held.size
      || held.mode !== named.mode || held.uid !== named.uid || held.gid !== named.gid
      || held.nlink !== named.nlink || held.nlink !== 1n) {
      throw new Error(RECOVERY_ERROR);
    }
  }

  async #stageCredential(credential: StoredCredential): Promise<string> {
    await this.#ensureDirectories();
    const slot = `${credential.profileId}.${randomUUID()}.bin`;
    const target = join(this.#credentialsDirectory, slot);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.#encryption.encrypt(JSON.stringify(credential));
      await this.#step('credential-encrypted');
      await this.#io('credential-write');
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await this.#step('credential-written');
      await this.#io('credential-flush');
      await this.#fsyncFile(temporary);
      await this.#step('credential-fsynced');
      await this.#io('credential-replace');
      await rename(temporary, target);
      await this.#step('credential-renamed');
      const directoryDurable = await this.#flushDirectoryIfSupported(this.#credentialsDirectory);
      if (directoryDurable) await this.#step('credential-directory-fsynced');
      await chmod(target, 0o600).catch(() => undefined);
      return slot;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #authenticateJournal(
    contents: string,
    committedOnly: boolean,
    useCache = true,
  ): Promise<AuthenticatedJournal> {
    const marker = contents[0];
    if ((committedOnly && marker !== 'C') || (!committedOnly && marker !== 'P' && marker !== 'C')) {
      throw new Error('Desktop transaction journal is incomplete');
    }
    const envelope = parseJournalEnvelope(contents.slice(1));
    const cached = useCache ? this.#authenticatedJournalCache.get(envelope.checksum) : undefined;
    if (cached) {
      if (cached.generation !== BigInt(envelope.generation)) throw new Error(RECOVERY_ERROR);
      return {
        generation: cached.generation,
        state: JSON.parse(JSON.stringify(cached.state)) as PersistedState,
        encryptedSlots: { ...cached.encryptedSlots },
      };
    }
    let plaintext: string;
    try {
      plaintext = this.#encryption.decrypt(Buffer.from(envelope.encryptedPayload, 'base64url'));
    } catch {
      throw new Error('Desktop transaction journal authentication failed');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(plaintext) as unknown;
    } catch {
      throw new Error('Desktop transaction journal authentication failed');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(RECOVERY_ERROR);
    const candidate = raw as Record<string, unknown>;
    const state = parseState(JSON.stringify(candidate.state));
    if (candidate.version !== 1 || state.version !== 3
      || typeof candidate.encryptedSlots !== 'object' || candidate.encryptedSlots === null
      || Array.isArray(candidate.encryptedSlots)
      || envelope.generation !== String(state.generation)) throw new Error(RECOVERY_ERROR);
    const encryptedSlots = candidate.encryptedSlots as Record<string, unknown>;
    const referenced = new Set([
      ...Object.values(state.credentialSlots),
      ...Object.values(state.pendingRevocations).map(record => record.slot),
    ]);
    if (Object.keys(encryptedSlots).length !== referenced.size
      || Object.keys(encryptedSlots).some(slot => !referenced.has(slot))) throw new Error(RECOVERY_ERROR);

    const authenticatedSlots: Record<string, string> = {};
    for (const slot of referenced) {
      const encoded = encryptedSlots[slot];
      if (typeof encoded !== 'string' || encoded.length === 0
        || encoded.length > Math.ceil(MAX_CREDENTIAL_LENGTH * 2)
        || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(RECOVERY_ERROR);
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw new Error(RECOVERY_ERROR);
      let credential: StoredCredential | null = null;
      try {
        credential = JSON.parse(this.#encryption.decrypt(bytes)) as StoredCredential;
      } catch {
        if (!this.#wasPreviouslyAuthenticatedSlot(state, slot, encoded)) throw new Error(RECOVERY_ERROR);
      }
      const profileId = SLOT_PATTERN.exec(slot)?.[1];
      if (credential && (credential.version !== 1 || credential.profileId !== profileId
        || typeof credential.origin !== 'string'
        || normalizeApiBaseUrl(credential.origin) !== credential.origin
        || typeof credential.token !== 'string'
        || !/^propr_it_[A-Za-z0-9_-]{43}$/.test(credential.token))) throw new Error(RECOVERY_ERROR);
      const pending = Object.values(state.pendingRevocations).find(record => record.slot === slot);
      if (credential && pending
        && (pending.profileId !== credential.profileId || pending.origin !== credential.origin)) {
        throw new Error(RECOVERY_ERROR);
      }
      authenticatedSlots[slot] = encoded;
    }
    const authenticated = { generation: BigInt(envelope.generation), state, encryptedSlots: authenticatedSlots };
    this.#authenticatedJournalCache.set(envelope.checksum, {
      generation: authenticated.generation,
      state: JSON.parse(JSON.stringify(state)) as PersistedState,
      encryptedSlots: { ...authenticatedSlots },
    });
    return authenticated;
  }

  #wasPreviouslyAuthenticatedSlot(state: PersistedState, slot: string, encoded: string): boolean {
    const currentPending = Object.values(state.pendingRevocations).find(record => record.slot === slot);
    const currentProfileId = SLOT_PATTERN.exec(slot)?.[1];
    for (const cached of this.#authenticatedJournalCache.values()) {
      if (cached.encryptedSlots[slot] !== encoded) continue;
      const priorPending = Object.values(cached.state.pendingRevocations).find(record => record.slot === slot);
      if (currentPending && priorPending
        && currentPending.profileId === priorPending.profileId
        && currentPending.origin === priorPending.origin
        && currentPending.credentialGeneration === priorPending.credentialGeneration) return true;
      if (currentPending && currentProfileId
        && cached.state.credentialSlots[currentProfileId] === slot
        && cached.state.credentialEpochs[currentProfileId] === currentPending.credentialGeneration
        && cached.state.profiles.find(profile => profile.id === currentProfileId)?.apiBaseUrl
          === currentPending.origin) return true;
      if (!currentPending && currentProfileId
        && state.credentialSlots[currentProfileId] === slot
        && cached.state.credentialSlots[currentProfileId] === slot
        && state.credentialEpochs[currentProfileId] === cached.state.credentialEpochs[currentProfileId]) return true;
    }
    return false;
  }

  async #recover(): Promise<void> {
    await this.#ensureDirectories();
    const journalRecords: AuthenticatedJournal[] = [];
    const legacyJournalRecords: LegacyJournalRecord[] = [];
    const preparedJournalRecords: AuthenticatedJournal[] = [];
    let invalidCommittedJournal = false;
    let invalidPreparedJournal = false;
    let sawPreparedJournal = false;
    let sawNonPreparedJournal = false;
    for (const path of this.#journalPaths) {
      try {
        const info = await stat(path);
        if (info.size > MAX_JOURNAL_BYTES) throw new Error('Desktop transaction journal is invalid');
        const contents = await readFile(path, 'utf8');
        if (contents.startsWith('C') || contents.startsWith('P')) {
          if (contents.startsWith('C')) {
            sawNonPreparedJournal = true;
            try {
              journalRecords.push(await this.#authenticateJournal(contents, true));
            } catch {
              invalidCommittedJournal = true;
            }
          } else {
            sawPreparedJournal = true;
            try {
              preparedJournalRecords.push(await this.#authenticateJournal(contents, false, false));
            } catch {
              invalidPreparedJournal = true;
            }
          }
          // A prepared record is deliberately not authoritative. The other
          // alternating slot (or the legacy mirror before the first commit)
          // remains the complete recovery point.
        } else {
          sawNonPreparedJournal = true;
          legacyJournalRecords.push(parseLegacyJournal(contents));
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (error instanceof SyntaxError
          || (error instanceof Error && error.message.startsWith('Desktop transaction journal'))) {
          sawNonPreparedJournal = true;
          continue;
        }
        throw new Error(RECOVERY_ERROR);
      }
    }
    journalRecords.sort((left, right) => left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0);
    const authoritativeJournal = journalRecords.at(-1);

    let parsed: PersistedState | VersionTwoPersistedState | LegacyPersistedState | null = null;
    let mirrorMissing = false;
    try {
      parsed = parseState(await readFile(this.#statePath, 'utf8'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      mirrorMissing = code === 'ENOENT';
      if (code && code !== 'ENOENT') throw new Error(RECOVERY_ERROR);
      if (!(error instanceof SyntaxError)
        && !(error instanceof Error && error.message.startsWith('Desktop '))
        && !mirrorMissing) throw new Error(RECOVERY_ERROR);
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
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(RECOVERY_ERROR);
        }
        try {
          await this.#writeThroughFile(join(this.#credentialsDirectory, slot), expectedBytes);
        } catch {
          throw new Error(RECOVERY_ERROR);
        }
      }
      const mirrorMatches = parsed?.version === 3
        && JSON.stringify(parsed) === JSON.stringify(state);
      if (!mirrorMatches) {
        try {
          await this.#writeStateMirror(state);
        } catch {
          throw new Error(RECOVERY_ERROR);
        }
      }
    } else {
      if (!parsed) {
        const preparedIsOnlyCanonicalEmptyBootstrap = sawPreparedJournal
          && !invalidPreparedJournal
          && preparedJournalRecords.length > 0
          && preparedJournalRecords.every(record => record.generation === 1n
            && JSON.stringify(record.state) === JSON.stringify({ ...emptyState(), generation: '1' })
            && Object.keys(record.encryptedSlots).length === 0);
        if (mirrorMissing && !invalidCommittedJournal && legacyJournalRecords.length === 0
          && (!sawPreparedJournal || preparedIsOnlyCanonicalEmptyBootstrap)) {
          // An authenticated generation-1 empty P is the one narrow prepared
          // bootstrap exception. It is never made authoritative: recovery
          // reconstructs empty A and retries publication. Any A-to-B P remains
          // ignored and cannot manufacture a missing mirror authority.
          parsed = { version: 1, activeProfileId: null, profiles: [] };
        } else {
          throw new Error(RECOVERY_ERROR);
        }
      }
      if (invalidCommittedJournal || (sawNonPreparedJournal && legacyJournalRecords.length === 0)) {
        throw new Error(RECOVERY_ERROR);
      }
      if (legacyJournalRecords.length > 0) {
        legacyJournalRecords.sort((left, right) => {
          const leftGeneration = BigInt(left.state.generation);
          const rightGeneration = BigInt(right.state.generation);
          return leftGeneration < rightGeneration ? -1 : leftGeneration > rightGeneration ? 1 : 0;
        });
        const legacy = legacyJournalRecords.at(-1)!;
        if (parsed.version !== 3 || JSON.stringify(parsed) !== JSON.stringify(legacy.state)) {
          throw new Error(RECOVERY_ERROR);
        }
        state = legacy.state;
        for (const [slot, encoded] of Object.entries(legacy.encryptedSlots)) {
          await this.#writeThroughFile(join(this.#credentialsDirectory, slot), Buffer.from(encoded, 'base64url'));
        }
        await this.#writeState(state);
      } else if (parsed.version === 1) {
        state = {
          version: 3,
          generation: '0',
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
        await this.#flushDirectoryIfSupported(this.#credentialsDirectory);
        await this.#writeState(state);
      } else if (parsed.version === 2) {
        state = {
          version: 3,
          generation: '0',
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
    await this.#flushDirectoryIfSupported(this.#credentialsDirectory);
    await this.#flushDirectoryIfSupported(this.#directory);
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
    await this.#flushDirectoryIfSupported(this.#credentialsDirectory);
    await this.#flushDirectoryIfSupported(this.#directory);
  }

  async #writeStateMirror(state: PersistedState): Promise<void> {
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.recovery.tmp`;
    try {
      await this.#io('mirror-write');
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#io('mirror-flush');
      await this.#fsyncFile(temporary);
      await this.#io('mirror-replace');
      await rename(temporary, this.#statePath);
      await this.#flushDirectoryIfSupported(this.#directory);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #writeThroughFile(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
      0o600,
    );
    try {
      await this.#io('journal-write');
      await handle.writeFile(bytes);
      await this.#io('journal-flush');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.#io('journal-verify');
    if (!(await readFile(path)).equals(bytes)) throw new Error(RECOVERY_ERROR);
  }

  async #fsyncFile(path: string): Promise<void> {
    await flushFileData(path);
  }

  async #fsyncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #flushDirectoryIfSupported(path: string): Promise<boolean> {
    await this.#io('metadata-flush');
    // Node does not expose a supported Windows directory FlushFileBuffers
    // handle. No authority transition depends on it: the committed journal is
    // self-contained and can recreate both renamed credential entries and the
    // profiles.json mirror. POSIX platforms still require and perform fsync.
    if (process.platform === 'win32') return false;
    await this.#fsyncDirectory(path);
    return true;
  }

  async #unlinkSlot(slot: string): Promise<void> {
    await unlink(join(this.#credentialsDirectory, slot)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  #step(step: ProfileStoreDurabilityStep): Promise<void> {
    return Promise.resolve(this.#options.afterDurabilityStep?.(step));
  }

  #io(operation: ProfileStoreIOOperation): Promise<void> {
    return Promise.resolve(this.#options.beforeIO?.(operation));
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
