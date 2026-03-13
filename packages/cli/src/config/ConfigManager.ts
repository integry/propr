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
import { CLIConfig, ConfigKey, DEFAULT_CONFIG } from "./types.js";

/**
 * Default configuration directory name.
 */
const CONFIG_DIR_NAME = ".propr";

/**
 * Default configuration file name.
 */
const CONFIG_FILE_NAME = "config.json";

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

    if (typeof data.githubToken === "string") {
      sanitized.githubToken = data.githubToken;
    }

    if (typeof data.remoteUrl === "string") {
      sanitized.remoteUrl = data.remoteUrl;
    }

    if (typeof data.defaultProject === "string") {
      sanitized.defaultProject = data.defaultProject;
    }

    return sanitized;
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
   * @param key - The configuration key to retrieve.
   * @returns The configuration value, or undefined if not set.
   */
  get<K extends ConfigKey>(key: K): CLIConfig[K] {
    return this.config[key];
  }

  /**
   * Sets a configuration value by key.
   *
   * @param key - The configuration key to set.
   * @param value - The value to set.
   * @returns A promise that resolves when the value is saved.
   */
  async set<K extends ConfigKey>(key: K, value: CLIConfig[K]): Promise<void> {
    this.config[key] = value;
    await this.save();
  }

  /**
   * Gets the GitHub token.
   *
   * @returns The GitHub token, or undefined if not set.
   */
  getGithubToken(): string | undefined {
    return this.get("githubToken");
  }

  /**
   * Sets the GitHub token.
   *
   * @param token - The GitHub token to set.
   * @returns A promise that resolves when the token is saved.
   */
  async setGithubToken(token: string): Promise<void> {
    await this.set("githubToken", token);
  }

  /**
   * Clears the GitHub token.
   *
   * @returns A promise that resolves when the token is cleared.
   */
  async clearGithubToken(): Promise<void> {
    await this.set("githubToken", undefined);
  }

  /**
   * Gets the remote API URL.
   *
   * @returns The remote URL, or undefined if not set.
   */
  getRemoteUrl(): string | undefined {
    return this.get("remoteUrl");
  }

  /**
   * Sets the remote API URL.
   *
   * @param url - The remote URL to set.
   * @returns A promise that resolves when the URL is saved.
   */
  async setRemoteUrl(url: string): Promise<void> {
    await this.set("remoteUrl", url);
  }

  /**
   * Gets the default project.
   *
   * @returns The default project (owner/repo format), or undefined if not set.
   */
  getDefaultProject(): string | undefined {
    return this.get("defaultProject");
  }

  /**
   * Sets the default project.
   *
   * @param project - The default project to set (owner/repo format).
   * @returns A promise that resolves when the project is saved.
   */
  async setDefaultProject(project: string): Promise<void> {
    await this.set("defaultProject", project);
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
