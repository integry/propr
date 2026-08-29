import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

interface PersistedState {
  version: 1;
  activeProfileId: string | null;
  profiles: DesktopProfile[];
}

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  backend(): string;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const emptyState = (): PersistedState => ({
  version: 1,
  activeProfileId: null,
  profiles: [],
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

const parseState = (contents: string): PersistedState => {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Desktop profile store is invalid');
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Array.isArray(state.profiles) || !state.profiles.every(validProfile)) {
    throw new Error('Desktop profile store is invalid');
  }
  if (state.activeProfileId !== null && (
    typeof state.activeProfileId !== 'string'
    || !state.profiles.some((profile: DesktopProfile) => profile.id === state.activeProfileId)
  )) {
    throw new Error('Desktop active profile is invalid');
  }
  return state as unknown as PersistedState;
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
  #mutation = Promise.resolve();

  constructor(userDataPath: string, encryption: EncryptionProvider) {
    this.#directory = join(userDataPath, 'desktop');
    this.#statePath = join(this.#directory, 'profiles.json');
    this.#credentialsDirectory = join(this.#directory, 'credentials');
    this.#encryption = encryption;
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
        detachedCredential = await this.#captureCredentialFile(normalized.id);
        // Credential deletion precedes state publication. A failed unlink leaves
        // the old profile intact; a failed state write leaves it safely unpaired.
        await this.#removeCredentialFile(normalized.id);
        if (originChanged && state.activeProfileId === normalized.id) state.activeProfileId = null;
      }
      const now = new Date().toISOString();
      const profile: DesktopProfile = {
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.profiles = [...state.profiles.filter(item => item.id !== profile.id), profile];
      await this.#writeState(state);
      return { profile: { ...profile }, detachedCredential, originChanged };
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
      const credential = await this.#captureCredentialFile(profileId);
      // Always remove an app-owned credential, even if profile state is absent,
      // so a later same-ID profile cannot inherit an orphan. Unlink failures are
      // reported before any visible state mutation.
      await this.#removeCredentialFile(profileId);
      if (!profile) return null;
      state.profiles = state.profiles.filter(profile => profile.id !== profileId);
      if (state.activeProfileId === profileId) state.activeProfileId = null;
      await this.#writeState(state);
      return { profile: { ...profile }, credential };
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
      const credential = await this.#readCredentialFile(profileId);
      if (!isCurrent()
        || state.activeProfileId !== expectedActiveProfileId
        || profile?.apiBaseUrl !== expectedProfileOrigin
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

  async readCredential(profileId: string): Promise<StoredCredential | null> {
    assertProfileId(profileId);
    if (!this.security().available) return null;
    return this.#readCredentialFile(profileId);
  }

  async #readCredentialFile(profileId: string): Promise<StoredCredential | null> {
    try {
      const encrypted = await readFile(this.#credentialPath(profileId));
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

  async #captureCredentialFile(profileId: string): Promise<StoredCredential | null> {
    try {
      return await this.#readCredentialFile(profileId);
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
      await this.#ensureDirectories();
      const target = this.#credentialPath(profileId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, this.#encryption.encrypt(JSON.stringify(credential)), { mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600).catch(() => undefined);
      return { stored: true };
    });
  }

  removeCredential(profileId: string): Promise<void> {
    assertProfileId(profileId);
    return this.#mutate(() => this.#removeCredentialFile(profileId));
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
      const credential = await this.#readCredentialFile(profileId);
      if (!isCurrent()
        || profile?.apiBaseUrl !== expectedProfileOrigin
        || !credential
        || credential.version !== expected.version
        || credential.profileId !== expected.profileId
        || credential.origin !== expected.origin
        || credential.token !== expected.token) return false;
      await this.#removeCredentialFile(profileId);
      return true;
    });
  }

  async #removeCredentialFile(profileId: string): Promise<void> {
    await unlink(this.#credentialPath(profileId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async #readState(): Promise<PersistedState> {
    try {
      return parseState(await readFile(this.#statePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #writeState(state: PersistedState): Promise<void> {
    await this.#ensureDirectories();
    const temporary = `${this.#statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.#statePath);
    await chmod(this.#statePath, 0o600).catch(() => undefined);
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#credentialsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    await chmod(this.#credentialsDirectory, 0o700).catch(() => undefined);
  }

  #credentialPath(profileId: string): string {
    return join(this.#credentialsDirectory, `${profileId}.bin`);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
  }

}
