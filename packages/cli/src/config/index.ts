/**
 * CLI Configuration Module
 *
 * Exports the ConfigManager and related types for managing
 * persistent CLI configuration.
 */

export { ConfigManager, createConfigManager } from "./ConfigManager.js";
export type { CLIConfig, ConfigKey, RemoteProfile } from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
