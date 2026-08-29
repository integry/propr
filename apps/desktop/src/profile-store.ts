import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CredentialReadResult,
  CredentialWriteResult,
  DesktopProfile,
  DesktopProfileInput,
  DesktopProfileList,
  StorageSecurity,
} from './shared/contract';
import { normalizeApiBaseUrl } from './security';

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_CREDENTIAL_LENGTH = 65_536;

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
  readonly #credentialMutations = new Map<string, Promise<void>>();

  constructor(userDataPath: string, encryption: EncryptionProvider) {
    this.#directory = join(userDataPath, 'desktop');
    this.#statePath = join(this.#directory, 'profiles.json');
    this.#credentialsDirectory = join(this.#directory, 'credentials');
    this.#encryption = encryption;
  }

  security(): StorageSecurity {
    return encryptionStatus(this.#encryption);
  }

  async list(): Promise<DesktopProfileList> {
    const state = await this.#readState();
    return {
      profiles: state.profiles.map(profile => ({ ...profile })),
      activeProfileId: state.activeProfileId,
    };
  }

  save(input: DesktopProfileInput): Promise<DesktopProfile> {
    return this.#mutate(async () => {
      const normalized = normalizedProfileInput(input);
      const state = await this.#readState();
      const existing = state.profiles.find(profile => profile.id === normalized.id);
      const now = new Date().toISOString();
      const profile: DesktopProfile = {
        ...normalized,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      state.profiles = [...state.profiles.filter(item => item.id !== profile.id), profile];
      await this.#writeState(state);
      return { ...profile };
    });
  }

  remove(profileId: string): Promise<void> {
    assertProfileId(profileId);
    const stateMutation = this.#mutate(async () => {
      const state = await this.#readState();
      state.profiles = state.profiles.filter(profile => profile.id !== profileId);
      if (state.activeProfileId === profileId) state.activeProfileId = null;
      await this.#writeState(state);
    });
    return this.#mutateCredential(profileId, async () => {
      await stateMutation;
      await this.#removeCredentialFile(profileId);
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

  async readCredential(profileId: string): Promise<CredentialReadResult> {
    assertProfileId(profileId);
    if (!this.security().available) return { available: false, value: null };
    try {
      const encrypted = await readFile(this.#credentialPath(profileId));
      return { available: true, value: this.#encryption.decrypt(encrypted) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: true, value: null };
      throw error;
    }
  }

  async writeCredential(profileId: string, value: string): Promise<CredentialWriteResult> {
    assertProfileId(profileId);
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH) {
      throw new Error('Credential must contain 1 to 65536 characters');
    }
    if (!this.security().available) return { stored: false, reason: 'encryption-unavailable' };
    return this.#mutateCredential(profileId, async () => {
      await this.#ensureDirectories();
      const target = this.#credentialPath(profileId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, this.#encryption.encrypt(value), { mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600).catch(() => undefined);
      return { stored: true };
    });
  }

  removeCredential(profileId: string): Promise<void> {
    assertProfileId(profileId);
    return this.#mutateCredential(profileId, () => this.#removeCredentialFile(profileId));
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

  #mutateCredential<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#credentialMutations.get(profileId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#credentialMutations.set(profileId, settled);
    void settled.then(() => {
      if (this.#credentialMutations.get(profileId) === settled) this.#credentialMutations.delete(profileId);
    });
    return result;
  }
}
