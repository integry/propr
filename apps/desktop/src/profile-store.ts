import { randomUUID } from 'node:crypto';
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
  replacedCredential: StoredCredential | null;
  originChanged: boolean;
}

export interface ProfileCredentialSnapshot {
  profile: DesktopProfile | null;
  credential: StoredCredential | null;
  activeProfileId: string | null;
}

interface LegacyPersistedState {
  version: 1;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
}

interface PersistedState {
  version: 2;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
  credentialSlots: Record<string, string>;
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
  | 'state-renamed'
  | 'state-directory-fsynced'
  | 'old-credential-removed';

export interface ProfileStoreOptions {
  afterDurabilityStep?(step: ProfileStoreDurabilityStep): void | Promise<void>;
}

const emptyState = (): PersistedState => ({
  version: 2,
  activeProfileId: null,
  profiles: [],
  credentialSlots: {},
});

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

const parseState = (contents: string): PersistedState | LegacyPersistedState => {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Desktop profile store is invalid');
  const state = value as Record<string, unknown>;
  if ((state.version !== 1 && state.version !== 2)
    || !Array.isArray(state.profiles) || !state.profiles.every(validProfile)) {
    throw new Error('Desktop profile store is invalid');
  }
  if (state.activeProfileId !== null && (
    typeof state.activeProfileId !== 'string'
    || !state.profiles.some((profile: DesktopProfile) => profile.id === state.activeProfileId)
  )) {
    throw new Error('Desktop active profile is invalid');
  }
  if (state.version === 2) {
    if (!state.credentialSlots || typeof state.credentialSlots !== 'object'
      || Array.isArray(state.credentialSlots)) throw new Error('Desktop credential state is invalid');
    const entries = Object.entries(state.credentialSlots as Record<string, unknown>);
    const slots = new Set<string>();
    for (const [profileId, slot] of entries) {
      if (!PROFILE_ID_PATTERN.test(profileId) || typeof slot !== 'string'
        || !new RegExp(`^${profileId}\\.[0-9a-f-]{36}\\.bin$`, 'i').test(slot)
        || slots.has(slot)) throw new Error('Desktop credential state is invalid');
      slots.add(slot);
    }
  }
  return state as unknown as PersistedState | LegacyPersistedState;
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
  readonly #credentialsDirectory: string;
  readonly #encryption: EncryptionProvider;
  readonly #options: ProfileStoreOptions;
  #mutation = Promise.resolve();

  constructor(userDataPath: string, encryption: EncryptionProvider, options: ProfileStoreOptions = {}) {
    this.#directory = join(userDataPath, 'desktop');
    this.#statePath = join(this.#directory, 'profiles.json');
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
      if (!isCurrent()
        || state.activeProfileId !== expected.activeProfileId
        || !this.#sameProfile(existing, expected.profile)
        || !this.#sameOptionalCredential(existingCredential, expected.credential)) return null;

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
      let committed = false;
      try {
        if (!isCurrent()) return null;
        // The staged slot is durable while the old state still names A. This
        // single atomic state-file rename is the only A -> B commit point.
        state.credentialSlots[profile.id] = stagedSlot;
        const durable = await this.#writeState(state);
        committed = true;
        if (durable && previousSlot) {
          await this.#unlinkSlot(previousSlot).catch(() => undefined);
          await this.#step('old-credential-removed').catch(() => undefined);
        }
        return {
          profile: { ...profile },
          replacedCredential: durable ? existingCredential : null,
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
    expectedProfileOrigin: string,
    expectedActiveProfileId: string | null,
    isCurrent: () => boolean,
  ): Promise<boolean> {
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
        || !this.#sameCredential(credential, expected)) return false;

      const previousActiveProfileId = state.activeProfileId;
      state.activeProfileId = profileId;
      await this.#writeState(state);
      if (isCurrent()) return true;

      // A generation/selection change that occurred during the atomic file
      // replacement must not leave the candidate selected.
      state.activeProfileId = previousActiveProfileId;
      await this.#writeState(state);
      return false;
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
        activeProfileId: state.activeProfileId,
      };
    });
  }

  async #readCredentialFile(state: PersistedState, profileId: string): Promise<StoredCredential | null> {
    const slot = state.credentialSlots[profileId];
    if (!slot) return null;
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
      const durable = await this.#writeState(state);
      if (durable && previousSlot) await this.#unlinkSlot(previousSlot).catch(() => undefined);
      return true;
    });
  }

  async #readState(): Promise<PersistedState> {
    try {
      const state = parseState(await readFile(this.#statePath, 'utf8'));
      if (state.version !== 2) throw new Error('Desktop profile store recovery was not completed');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #writeState(state: PersistedState): Promise<boolean> {
    await this.#ensureDirectories();
    const temporary = `${this.#statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await this.#step('state-written');
      await this.#fsyncFile(temporary);
      await this.#step('state-fsynced');
      await rename(temporary, this.#statePath);
      await this.#step('state-renamed').catch(() => undefined);
      // Once rename succeeds the new state is authoritative. A directory fsync
      // failure must not trigger a logical rollback or revoke B: after a crash,
      // the filesystem can expose either complete state, and both slots remain.
      const durable = await this.#fsyncDirectory(this.#directory).then(() => true, () => false);
      if (durable) await this.#step('state-directory-fsynced').catch(() => undefined);
      await chmod(this.#statePath, 0o600).catch(() => undefined);
      return durable;
    } finally {
      await unlink(temporary).catch(() => undefined);
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
      await writeFile(temporary, encrypted, { mode: 0o600 });
      await this.#step('credential-written');
      await this.#fsyncFile(temporary);
      await this.#step('credential-fsynced');
      await rename(temporary, target);
      await this.#step('credential-renamed');
      await this.#fsyncDirectory(this.#credentialsDirectory);
      await this.#step('credential-directory-fsynced');
      await chmod(target, 0o600).catch(() => undefined);
      return slot;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #recover(): Promise<void> {
    await this.#ensureDirectories();
    let parsed: PersistedState | LegacyPersistedState;
    try {
      parsed = parseState(await readFile(this.#statePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      parsed = { version: 1, activeProfileId: null, profiles: [] };
    }

    let state: PersistedState;
    if (parsed.version === 1) {
      state = {
        version: 2,
        activeProfileId: parsed.activeProfileId,
        profiles: parsed.profiles.map(profile => ({ ...profile })),
        credentialSlots: {},
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
      }
      await this.#fsyncDirectory(this.#credentialsDirectory);
      const durable = await this.#writeState(state);
      if (!durable) return;
    } else {
      state = parsed;
    }

    // Make the state pointer durable before deleting any slot it does not name.
    // This also completes a prior rename whose directory fsync failed in-process.
    await this.#fsyncDirectory(this.#directory);
    const referenced = new Set(Object.values(state.credentialSlots));
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
    await this.#fsyncDirectory(this.#credentialsDirectory);
    await this.#fsyncDirectory(this.#directory);
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

  async #fsyncFile(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #fsyncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Node/Windows does not expose a directory handle that FlushFileBuffers
      // accepts. The file itself is synced before the atomic NTFS rename.
      if (process.platform === 'win32' && ['EACCES', 'EBADF', 'EINVAL', 'EPERM'].includes(code ?? '')) return;
      throw error;
    }
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
