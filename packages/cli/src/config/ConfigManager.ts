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
import { CLIConfig, ConfigKey, ConfigValues, DEFAULT_CONFIG, RemoteProfile } from "./types.js";

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
const PROFILE_BACKED_KEYS = ["remoteUrl", "githubToken", "defaultProject"] as const;
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

  /**
   * Creates a new ConfigManager instance.
   *
   * @param customConfigDir - Optional custom configuration directory path.
   *                          Defaults to ~/.propr
   */
  constructor(customConfigDir?: string) {
    this.configDir = customConfigDir ?? path.join(os.homedir(), CONFIG_DIR_NAME);
    this.configFilePath = path.join(this.configDir, CONFIG_FILE_NAME);
    this.config = { ...DEFAULT_CONFIG };
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
   * Ensures the configuration directory exists.
   *
   * @returns A promise that resolves when the directory exists.
   */
  private async ensureConfigDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.configDir, { recursive: true });
    } catch (error) {
      // Directory already exists or other error
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
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
      const data = await fs.promises.readFile(this.configFilePath, "utf-8");
      const parsed = JSON.parse(data);

      // Validate that parsed data is an object
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        console.warn(
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
        console.warn(
          `Warning: Configuration file at ${this.configFilePath} is corrupted (invalid JSON). Using defaults.`
        );
        this.config = { ...DEFAULT_CONFIG };
        return this.config;
      }

      // Other errors (permission issues, etc.)
      console.warn(
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

    if (typeof data.tunnelEnabled === "boolean") {
      sanitized.tunnelEnabled = data.tunnelEnabled;
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

  private async updateActiveProfile(patch: Partial<RemoteProfile>): Promise<void> {
    const name = this.getActiveProfileName();
    const profiles = { ...(this.config.profiles ?? {}) };
    profiles[name] = {
      ...(profiles[name] ?? {}),
      ...patch,
    };
    this.config.profiles = profiles;
    await this.save();
  }

  /**
   * Saves the current configuration to the file.
   *
   * @returns A promise that resolves when the configuration is saved.
   */
  async save(): Promise<void> {
    await this.ensureConfigDir();

    // Only write non-undefined values
    const dataToWrite: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.config)) {
      if (value !== undefined) {
        dataToWrite[key] = value;
      }
    }

    const content = JSON.stringify(dataToWrite, null, 2);
    await fs.promises.writeFile(this.configFilePath, content, "utf-8");
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
      await this.updateActiveProfile({ [key]: value as string | undefined });
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
    await this.updateActiveProfile({ githubToken: token });
  }

  /**
   * Clears the GitHub token.
   *
   * @returns A promise that resolves when the token is cleared.
   */
  async clearGithubToken(): Promise<void> {
    const name = this.getActiveProfileName();
    const profiles = { ...(this.config.profiles ?? {}) };
    profiles[name] = { ...(profiles[name] ?? {}) };
    delete profiles[name].githubToken;
    this.config.profiles = profiles;
    await this.save();
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

    const profiles = { ...(this.config.profiles ?? {}) };
    const nextProfile: RemoteProfile = {
      ...(profiles[trimmed] ?? {}),
      ...patch,
    };
    for (const key of clear) {
      delete nextProfile[key];
    }
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
  getTunnelEnabled(): boolean | undefined {
    return this.get("tunnelEnabled");
  }

  /**
   * Sets the desired Cloudflare Tunnel service state.
   */
  async setTunnelEnabled(enabled: boolean): Promise<void> {
    await this.set("tunnelEnabled", enabled);
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
  customConfigDir?: string
): Promise<ConfigManager> {
  const manager = new ConfigManager(customConfigDir);
  await manager.init();
  return manager;
}
