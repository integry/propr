/**
 * CLI Configuration Types
 *
 * These types define the configuration schema for the CLI.
 */

/**
 * Supported configuration keys for the CLI.
 */
export type ConfigKey = "githubToken" | "remoteUrl" | "defaultProject";

/**
 * CLI configuration structure.
 */
export interface CLIConfig {
  /**
   * GitHub personal access token for authentication.
   */
  githubToken?: string;

  /**
   * Remote API URL for the ProPR backend.
   */
  remoteUrl?: string;

  /**
   * Default project to use when not specified in commands.
   * Format: owner/repo
   */
  defaultProject?: string;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: CLIConfig = {
  githubToken: undefined,
  remoteUrl: undefined,
  defaultProject: undefined,
};
