/**
 * CLI Configuration Manager
 *
 * Manages persistent configuration for the CLI, storing settings in a JSON file
 * located in the user's home directory (~/.propr/config.json).
 *
 * Features:
 * - Reads and writes configuration to a JSON file
 * - Handles missing configuration files gracefully
 * - Handles corrupted configuration files with fallback behavior
 * - Provides type-safe getter and setter methods
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CLIConfig, ConfigKey, ConfigValues, DEFAULT_CONFIG, GithubCredential, RemoteProfile } from "./types.js";
import {
  ensurePrivateDirectory,
  secureExistingPrivateDirectory,
  secureExistingPrivateFile,
  validateExistingPrivateDirectory,
  validateExistingPrivateFile,
  writePrivateFileAtomic,
} from "../utils/privateFilesystem.js";
import { canonicalRootKey } from "./rootKey.js";

/**
 * Default configuration directory name.
 */
const CONFIG_DIR_NAME = ".propr";

/**
 * Default configuration file name.
 */
const CONFIG_FILE_NAME = "config.json";
const DEFAULT_PROFILE_NAME = "default";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Config keys whose values live on the active remote profile rather than at
 * the top level of the config file.
 */
const PROFILE_BACKED_KEYS = [
  "remoteUrl", "githubToken", "githubTokenExpiresAt", "githubRefreshToken", "githubRefreshTokenExpiresAt", "defaultProject",
] as const;
const GITHUB_CREDENTIAL_KEYS = ["githubToken", "githubTokenExpiresAt", "githubRefreshToken", "githubRefreshTokenExpiresAt"] as const;
const isExpiryTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Replacing or clearing a token drops expiry and refresh metadata that described the previous token. */
function dropStaleGithubCredentialMetadata(
  profile: RemoteProfile, patch: Partial<RemoteProfile>, clear: ReadonlyArray<keyof RemoteProfile> = []
): void {
  if (!("githubToken" in patch) && !clear.includes("githubToken")) return;
  for (const key of GITHUB_CREDENTIAL_KEYS) {
    if (key !== "githubToken" && (!(key in patch) || clear.includes("githubToken"))) delete profile[key];
  }
}
type ProfileBackedKey = (typeof PROFILE_BACKED_KEYS)[number];

function isProfileBackedKey(key: ConfigKey): key is ProfileBackedKey {
  return (PROFILE_BACKED_KEYS as readonly string[]).includes(key);
}

/**
 * Checks whether a value is usable as a remote profile name: non-empty after
 * trimming, containing only letters, numbers, dots, underscores, and hyphens,
 * and starting with a letter or number.
 */
export function isValidRemoteProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name.trim());
}

/**
 * ConfigManager handles persistent CLI configuration.
 */
export class ConfigManager {
  private configDir: string;
  private configFilePath: string;
  private config: CLIConfig;
  private initialized: boolean = false;
  private readonly warn: (message: string) => void;
  private readonly readOnly: boolean;
  /** Tail of the profile mutation queue: each mutation and its rollback completes before the next starts. */
  private profileMutations: Promise<unknown> = Promise.resolve();
  /** Tail of the file write queue, so the last rename always carries the latest in-memory state. */
  private fileWrites: Promise<unknown> = Promise.resolve();

  /**
   * Creates a new ConfigManager instance.
   *
   * @param customConfigDir - Optional custom configuration directory path.
   *                          Defaults to ~/.propr
   */
  constructor(
    customConfigDir?: string,
    options: { warn?: (message: string) => void; readOnly?: boolean } = {},
  ) {
    this.configDir = customConfigDir ?? path.join(os.homedir(), CONFIG_DIR_NAME);
    this.configFilePath = path.join(this.configDir, CONFIG_FILE_NAME);
    this.config = { ...DEFAULT_CONFIG };
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.readOnly = options.readOnly ?? false;
  }

  /**
   * Initializes the ConfigManager by loading the configuration file.
   * This method is idempotent and safe to call multiple times.
   *
   * @returns A promise that resolves when initialization is complete.
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.load();
    this.initialized = true;
  }

  /**
   * Loads the configuration from the file.
   * If the file doesn't exist, uses default values.
   * If the file is corrupted, resets to defaults and warns the user.
   *
   * @returns A promise that resolves when the configuration is loaded.
   */
  async load(): Promise<CLIConfig> {
    try {
      const directoryExists = this.readOnly
        ? validateExistingPrivateDirectory(this.configDir)
        : await secureExistingPrivateDirectory(this.configDir);
      if (directoryExists) {
        if (this.readOnly) validateExistingPrivateFile(this.configFilePath);
        else await secureExistingPrivateFile(this.configFilePath);
      }
      const data = await fs.promises.readFile(this.configFilePath, "utf-8");
      const parsed = JSON.parse(data);

      // Validate that parsed data is an object
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.warn(
          `Warning: Configuration file at ${this.configFilePath} contains invalid data. Using defaults.`
        );
        this.config = { ...DEFAULT_CONFIG };
        return this.config;
      }

      // Merge with defaults to ensure all keys are present
      this.config = {
        ...DEFAULT_CONFIG,
        ...this.sanitizeConfig(parsed),
      };

      return this.config;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;

      if (err.code === "ENOENT") {
        // File doesn't exist - use defaults (this is normal on first run)
        this.config = { ...DEFAULT_CONFIG };
        return this.config;
      }

      if (err instanceof SyntaxError) {
        // JSON parsing error - corrupted file
        this.warn(
          `Warning: Configuration file at ${this.configFilePath} is corrupted (invalid JSON). Using defaults.`
        );
        this.config = { ...DEFAULT_CONFIG };
        return this.config;
      }

      // Other errors (permission issues, etc.)
      this.warn(
        `Warning: Could not read configuration file at ${this.configFilePath}: ${err.message}. Using defaults.`
      );
      this.config = { ...DEFAULT_CONFIG };
      return this.config;
    }
  }

  /**
   * Sanitizes the loaded configuration to ensure only valid keys are included.
   *
   * @param data - The raw parsed configuration data.
   * @returns A sanitized configuration object.
   */
  private sanitizeConfig(data: Record<string, unknown>): Partial<CLIConfig> {
    const sanitized: Partial<CLIConfig> = {};

    if (typeof data.activeProfile === "string" && data.activeProfile.trim()) {
      try {
        sanitized.activeProfile = this.normalizeProfileName(data.activeProfile);
      } catch {
        // Ignore invalid profile names loaded from disk; commands only create valid names.
      }
    }

    if (data.profiles && typeof data.profiles === "object" && !Array.isArray(data.profiles)) {
      const profiles: Record<string, RemoteProfile> = {};
      for (const [name, rawProfile] of Object.entries(data.profiles as Record<string, unknown>)) {
        if (!name.trim() || !rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
          continue;
        }
        const profileData = rawProfile as Record<string, unknown>;
        const profile: RemoteProfile = {};
        if (typeof profileData.remoteUrl === "string") profile.remoteUrl = profileData.remoteUrl;
        if (typeof profileData.githubToken === "string") profile.githubToken = profileData.githubToken;
        // Expiry metadata is only meaningful beside the token it describes.
        if (profile.githubToken && isExpiryTime(profileData.githubTokenExpiresAt)) {
          profile.githubTokenExpiresAt = profileData.githubTokenExpiresAt;
        }
        if (profile.githubToken && typeof profileData.githubRefreshToken === "string" && profileData.githubRefreshToken) {
          profile.githubRefreshToken = profileData.githubRefreshToken;
          if (isExpiryTime(profileData.githubRefreshTokenExpiresAt)) {
            profile.githubRefreshTokenExpiresAt = profileData.githubRefreshTokenExpiresAt;
          }
        }
        if (typeof profileData.defaultProject === "string") profile.defaultProject = profileData.defaultProject;
        try {
          profiles[this.normalizeProfileName(name)] = profile;
        } catch {
          // Ignore invalid profile names loaded from disk; commands only create valid names.
        }
      }
      if (Object.keys(profiles).length > 0) {
        sanitized.profiles = profiles;
      }
    }

    if (typeof data.stackRoot === "string") {
      sanitized.stackRoot = data.stackRoot;
    }

    if (typeof data.uiEnabled === "boolean") {
      sanitized.uiEnabled = data.uiEnabled;
    }

    if (typeof data.docsEnabled === "boolean") {
      sanitized.docsEnabled = data.docsEnabled;
    }

    const tunnelEnabledByRoot: Record<string, boolean> = {};
    if (
      data.tunnelEnabledByRoot &&
      typeof data.tunnelEnabledByRoot === "object" &&
      !Array.isArray(data.tunnelEnabledByRoot)
    ) {
      for (const [root, enabled] of Object.entries(data.tunnelEnabledByRoot as Record<string, unknown>)) {
        if (path.isAbsolute(root) && typeof enabled === "boolean") {
          tunnelEnabledByRoot[canonicalRootKey(root)] = enabled;
        }
      }
    }

    // Migrate the 0.8.15 global flag to the stack root that was stored beside
    // it. The legacy value is deliberately not retained globally: doing so
    // would let a later explicit --root inherit another stack's tunnel intent.
    // If no stackRoot was recorded, there is no safe root to associate with the
    // flag, so leave it unset and fall back to that stack's own .env default.
    if (typeof data.tunnelEnabled === "boolean" && typeof data.stackRoot === "string") {
      const legacyRoot = canonicalRootKey(path.resolve(data.stackRoot));
      if (!(legacyRoot in tunnelEnabledByRoot)) {
        tunnelEnabledByRoot[legacyRoot] = data.tunnelEnabled;
      }
    }

    if (Object.keys(tunnelEnabledByRoot).length > 0) {
      sanitized.tunnelEnabledByRoot = tunnelEnabledByRoot;
    }

    return sanitized;
  }

  private getActiveProfileName(): string {
    return this.config.activeProfile || DEFAULT_PROFILE_NAME;
  }

  private normalizeProfileName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Profile name must not be empty");
    }
    if (!isValidRemoteProfileName(trimmed)) {
      throw new Error(
        "Profile name may only contain letters, numbers, dots, underscores, and hyphens, and must start with a letter or number"
      );
    }
    return trimmed;
  }

  private getActiveProfile(): RemoteProfile {
    const name = this.getActiveProfileName();
    return this.config.profiles?.[name] ?? {};
  }

  private getActiveProfileValue<K extends keyof RemoteProfile>(key: K): RemoteProfile[K] {
    return this.getActiveProfile()[key];
  }

  /**
   * Run profile mutations one at a time. A mutation reads, saves, and on
   * failure rolls back `profiles` without another mutation interleaving, so an
   * older write can never restore its snapshot over a later one.
   */
  private serializeProfileMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = this.profileMutations.then(mutation);
    this.profileMutations = run.catch(() => undefined);
    return run;
  }

  private updateActiveProfile(patch: Partial<RemoteProfile>): Promise<void> {
    return this.serializeProfileMutation(() => this.applyActiveProfilePatch(patch));
  }

  private async applyActiveProfilePatch(patch: Partial<RemoteProfile>): Promise<void> {
    const name = this.getActiveProfileName();
    const previousProfiles = this.config.profiles;
    const profiles = { ...(previousProfiles ?? {}) };
    profiles[name] = {
      ...(profiles[name] ?? {}),
      ...patch,
    };
    dropStaleGithubCredentialMetadata(profiles[name], patch);
    this.config.profiles = profiles;
    try {
      await this.save();
    } catch (error) {
      // A later config write must not persist a profile update that failed.
      this.config.profiles = previousProfiles;
      throw error;
    }
  }

  /**
   * Saves the current configuration to the file.
   *
   * @returns A promise that resolves when the configuration is saved.
   */
  async save(): Promise<void> {
    if (this.readOnly) throw new Error("Configuration manager is read-only");
    const write = this.fileWrites.then(() => this.writeConfigFile());
    this.fileWrites = write.catch(() => undefined);
    await write;
  }

  private async writeConfigFile(): Promise<void> {
    await ensurePrivateDirectory(this.configDir);

    // Only write non-undefined values
    const dataToWrite: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.config)) {
      if (value !== undefined) {
        dataToWrite[key] = value;
      }
    }

    const content = JSON.stringify(dataToWrite, null, 2);
    await writePrivateFileAtomic(this.configFilePath, content);
  }

  /**
   * Gets a configuration value by key.
   *
   * Remote settings (remoteUrl, githubToken, defaultProject) are read from the
   * active profile so the generic accessor stays consistent with the dedicated
   * getters.
   *
   * @param key - The configuration key to retrieve.
   * @returns The configuration value, or undefined if not set.
   */
  get<K extends ConfigKey>(key: K): ConfigValues[K] {
    if (isProfileBackedKey(key)) {
      return this.getActiveProfileValue(key) as ConfigValues[K];
    }
    return (this.config as ConfigValues)[key];
  }

  /**
   * Sets a configuration value by key.
   *
   * Remote settings (remoteUrl, githubToken, defaultProject) are written to
   * the active profile so the generic accessor stays consistent with the
   * dedicated setters.
   *
   * @param key - The configuration key to set.
   * @param value - The value to set.
   * @returns A promise that resolves when the value is saved.
   */
  async set<K extends ConfigKey>(key: K, value: ConfigValues[K]): Promise<void> {
    if (isProfileBackedKey(key)) {
      await this.updateActiveProfile({ [key]: value } as Partial<RemoteProfile>);
      return;
    }
    (this.config as ConfigValues)[key] = value;
    await this.save();
  }

  /**
   * Gets the GitHub token.
   *
   * @returns The GitHub token, or undefined if not set.
   */
  getGithubToken(): string | undefined {
    return this.getActiveProfileValue("githubToken");
  }

  /**
   * Sets the GitHub token.
   *
   * @param token - The GitHub token to set.
   * @returns A promise that resolves when the token is saved.
   */
  async setGithubToken(token: string): Promise<void> {
    // A plain token replaces any expiring credential and its refresh grant.
    await this.setGithubCredential({ accessToken: token });
  }

  /**
   * Gets the stored GitHub credential, including expiry and refresh metadata
   * for expiring GitHub OAuth tokens.
   */
  getGithubCredential(): GithubCredential | undefined {
    const profile = this.getActiveProfile();
    if (!profile.githubToken) return undefined;
    return {
      accessToken: profile.githubToken,
      ...(profile.githubTokenExpiresAt !== undefined ? { expiresAt: profile.githubTokenExpiresAt } : {}),
      ...(profile.githubRefreshToken !== undefined ? { refreshToken: profile.githubRefreshToken } : {}),
      ...(profile.githubRefreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: profile.githubRefreshTokenExpiresAt } : {}),
    };
  }

  /**
   * Atomically replaces the whole GitHub credential. Fields absent from
   * `credential` are removed so a rotated or replaced credential can never be
   * combined with a stale refresh token from an earlier sign-in.
   *
   * With `replacingRefreshToken`, the write is a compare-and-set: it only
   * happens when the active credential still carries that refresh token once
   * every earlier credential mutation has settled, and resolves `false`
   * otherwise. A refresh uses this so a sign-in confirmed meanwhile always wins.
   */
  async setGithubCredential(
    credential: GithubCredential,
    options: { replacingRefreshToken?: string } = {},
  ): Promise<boolean> {
    if (!credential.accessToken) throw new Error("GitHub credential requires an access token");
    if (credential.expiresAt !== undefined && !isExpiryTime(credential.expiresAt)) throw new Error("Invalid GitHub token expiry");
    if (credential.refreshTokenExpiresAt !== undefined && (!credential.refreshToken || !isExpiryTime(credential.refreshTokenExpiresAt))) {
      throw new Error("Invalid GitHub refresh token expiry");
    }
    const expected = options.replacingRefreshToken;
    return this.replaceActiveProfileCredential({
      githubToken: credential.accessToken,
      ...(credential.expiresAt !== undefined ? { githubTokenExpiresAt: credential.expiresAt } : {}),
      ...(credential.refreshToken ? { githubRefreshToken: credential.refreshToken } : {}),
      ...(credential.refreshToken && credential.refreshTokenExpiresAt !== undefined
        ? { githubRefreshTokenExpiresAt: credential.refreshTokenExpiresAt } : {}),
    }, expected === undefined ? undefined : profile => profile.githubRefreshToken === expected);
  }

  /**
   * Resolves the GitHub credential once every queued credential mutation has
   * settled, so a write still awaiting persistence (which may yet roll back)
   * is never observed.
   */
  getSettledGithubCredential(): Promise<GithubCredential | undefined> {
    return this.serializeProfileMutation(async () => this.getGithubCredential());
  }

  /**
   * Clears the GitHub token together with any expiry and refresh metadata.
   *
   * With `expectedAccessToken`, the clear is a compare-and-set like
   * `setGithubCredential`'s: it only happens when that token is still active
   * once earlier credential mutations have settled, and resolves `false`
   * otherwise.
   *
   * @returns A promise that resolves when the token is cleared.
   */
  async clearGithubToken(options: { expectedAccessToken?: string } = {}): Promise<boolean> {
    const expected = options.expectedAccessToken;
    return this.replaceActiveProfileCredential({},
      expected === undefined ? undefined : profile => profile.githubToken === expected);
  }

  private replaceActiveProfileCredential(
    credential: Partial<RemoteProfile>,
    precondition?: (profile: RemoteProfile) => boolean,
  ): Promise<boolean> {
    return this.serializeProfileMutation(async () => {
      if (precondition && !precondition(this.getActiveProfile())) return false;
      const name = this.getActiveProfileName();
      const previousProfiles = this.config.profiles;
      const profiles = { ...(previousProfiles ?? {}) };
      const profile: RemoteProfile = { ...(profiles[name] ?? {}) };
      for (const key of GITHUB_CREDENTIAL_KEYS) delete profile[key];
      profiles[name] = { ...profile, ...credential };
      this.config.profiles = profiles;
      try {
        await this.save();
      } catch (error) {
        // Never leave a partially rotated credential in memory after a failed write.
        this.config.profiles = previousProfiles;
        throw error;
      }
      return true;
    });
  }

  /**
   * Gets the remote API URL.
   *
   * @returns The remote URL, or undefined if not set.
   */
  getRemoteUrl(): string | undefined {
    return this.getActiveProfileValue("remoteUrl");
  }

  /**
   * Sets the remote API URL.
   *
   * @param url - The remote URL to set.
   * @returns A promise that resolves when the URL is saved.
   */
  async setRemoteUrl(url: string): Promise<void> {
    await this.updateActiveProfile({ remoteUrl: url });
  }

  /**
   * Gets the default project.
   *
   * @returns The default project (owner/repo format), or undefined if not set.
   */
  getDefaultProject(): string | undefined {
    return this.getActiveProfileValue("defaultProject");
  }

  /**
   * Sets the default project.
   *
   * @param project - The default project to set (owner/repo format).
   * @returns A promise that resolves when the project is saved.
   */
  async setDefaultProject(project: string): Promise<void> {
    await this.updateActiveProfile({ defaultProject: project });
  }

  getActiveRemoteProfile(): string {
    return this.getActiveProfileName();
  }

  getRemoteProfiles(): Record<string, RemoteProfile> {
    const profiles = Object.fromEntries(
      Object.entries(this.config.profiles ?? {}).map(([name, profile]) => [name, { ...profile }])
    );
    if (!profiles[DEFAULT_PROFILE_NAME]) {
      profiles[DEFAULT_PROFILE_NAME] = {};
    }
    return profiles;
  }

  /**
   * Checks whether a named remote profile exists in the stored configuration.
   */
  hasRemoteProfile(name: string): boolean {
    const trimmed = this.normalizeProfileName(name);
    return Boolean(this.config.profiles && Object.prototype.hasOwnProperty.call(this.config.profiles, trimmed));
  }

  /**
   * Switches the active remote profile, creating an empty profile when the
   * name does not exist yet.
   *
   * @returns Whether a new (empty) profile had to be created.
   */
  async useRemoteProfile(name: string): Promise<{ created: boolean }> {
    const trimmed = this.normalizeProfileName(name);
    return this.serializeProfileMutation(() => this.activateRemoteProfile(trimmed));
  }

  private async activateRemoteProfile(trimmed: string): Promise<{ created: boolean }> {
    const profiles = { ...(this.config.profiles ?? {}) };
    const created = !profiles[trimmed];
    if (created) {
      profiles[trimmed] = {};
    }
    this.config.profiles = profiles;
    this.config.activeProfile = trimmed;
    await this.save();
    return { created };
  }

  async setRemoteProfile(
    name: string,
    patch: Partial<RemoteProfile>,
    clear: Array<keyof RemoteProfile> = []
  ): Promise<void> {
    const trimmed = this.normalizeProfileName(name);
    return this.serializeProfileMutation(() => this.patchRemoteProfile(trimmed, patch, clear));
  }

  private async patchRemoteProfile(
    trimmed: string,
    patch: Partial<RemoteProfile>,
    clear: Array<keyof RemoteProfile>,
  ): Promise<void> {

    const profiles = { ...(this.config.profiles ?? {}) };
    const nextProfile: RemoteProfile = {
      ...(profiles[trimmed] ?? {}),
      ...patch,
    };
    for (const key of clear) {
      delete nextProfile[key];
    }
    dropStaleGithubCredentialMetadata(nextProfile, patch, clear);
    profiles[trimmed] = nextProfile;
    this.config.profiles = profiles;

    await this.save();
  }

  /**
   * Gets the local stack root directory (where .env, data/, logs/, repos/ live).
   *
   * @returns The stack root path, or undefined if not set.
   */
  getStackRoot(): string | undefined {
    return this.get("stackRoot");
  }

  /**
   * Sets the local stack root directory.
   *
   * @param root - Absolute path to the stack root.
   */
  async setStackRoot(root: string): Promise<void> {
    await this.set("stackRoot", root);
  }

  /**
   * Gets the desired UI service state. Defaults to true when unset.
   */
  getUiEnabled(): boolean {
    return this.get("uiEnabled") ?? true;
  }

  /**
   * Sets the desired UI service state.
   */
  async setUiEnabled(enabled: boolean): Promise<void> {
    await this.set("uiEnabled", enabled);
  }

  /**
   * Gets the desired docs service state. Defaults to false when unset.
   */
  getDocsEnabled(): boolean {
    return this.get("docsEnabled") ?? false;
  }

  /**
   * Sets the desired docs service state.
   */
  async setDocsEnabled(enabled: boolean): Promise<void> {
    await this.set("docsEnabled", enabled);
  }

  /**
   * Gets the desired Cloudflare Tunnel service state, or undefined when unset.
   *
   * Unlike the UI/docs toggles, the tunnel has no fixed CLI-side default: an
   * unset value means "defer to the launcher's env-derived default" (a
   * configured PROPR_UI_TUNNEL_TOKEN or PROPR_UI_TUNNEL_ENABLED=true). Callers
   * forward this value as an explicit override only when the user has toggled
   * it, so it must preserve the unset (undefined) state rather than collapsing
   * it to false.
   */
  getTunnelEnabled(root: string): boolean | undefined {
    return this.config.tunnelEnabledByRoot?.[canonicalRootKey(path.resolve(root))];
  }

  /**
   * Sets the desired Cloudflare Tunnel service state for one stack root. An
   * undefined value clears the override so the launcher's env-derived default
   * applies again (used to roll back a failed toggle).
   */
  async setTunnelEnabled(root: string, enabled: boolean | undefined): Promise<void> {
    const normalizedRoot = canonicalRootKey(path.resolve(root));
    const states = { ...(this.config.tunnelEnabledByRoot ?? {}) };
    if (enabled === undefined) {
      delete states[normalizedRoot];
    } else {
      states[normalizedRoot] = enabled;
    }
    this.config.tunnelEnabledByRoot = Object.keys(states).length > 0 ? states : undefined;
    await this.save();
  }

  /**
   * Gets all configuration values.
   *
   * @returns A copy of the current configuration.
   */
  getAll(): CLIConfig {
    return { ...this.config };
  }

  /**
   * Resets the configuration to default values.
   *
   * @param persist - Whether to persist the reset to the file. Defaults to true.
   * @returns A promise that resolves when the reset is complete.
   */
  async reset(persist: boolean = true): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    if (persist) {
      await this.save();
    }
  }

  /**
   * Deletes the configuration file.
   *
   * @returns A promise that resolves when the file is deleted.
   */
  async deleteConfigFile(): Promise<void> {
    try {
      await fs.promises.unlink(this.configFilePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
      // File doesn't exist - nothing to delete
    }
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Gets the path to the configuration file.
   *
   * @returns The configuration file path.
   */
  getConfigFilePath(): string {
    return this.configFilePath;
  }

  /**
   * Gets the path to the configuration directory.
   *
   * @returns The configuration directory path.
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * Checks if the configuration file exists.
   *
   * @returns A promise that resolves to true if the file exists.
   */
  async configFileExists(): Promise<boolean> {
    try {
      await fs.promises.access(this.configFilePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Creates and initializes a ConfigManager instance.
 * This is a convenience function for one-off usage.
 *
 * @param customConfigDir - Optional custom configuration directory path.
 * @returns A promise that resolves to an initialized ConfigManager.
 */
export async function createConfigManager(
  customConfigDir?: string,
  options: { warn?: (message: string) => void; readOnly?: boolean } = {},
): Promise<ConfigManager> {
  const manager = new ConfigManager(customConfigDir, options);
  await manager.init();
  return manager;
}
