/**
 * CLI Configuration Types
 *
 * These types define the configuration schema for the CLI.
 */

/**
 * Supported configuration keys for the CLI.
 */
export type ConfigKey =
  | "githubToken"
  | "remoteUrl"
  | "defaultProject"
  | "stackRoot"
  | "uiEnabled"
  | "docsEnabled"
  | "tunnelEnabled";

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

  /**
   * Absolute path to the local stack root (where .env, data/, logs/, repos/
   * live). Written by `propr init stack`; used by the control-plane commands to
   * locate the stack when run from outside that directory.
   */
  stackRoot?: string;

  /**
   * Desired state of the UI service. Persisted so `propr start` and restarts
   * honor a previous `propr ui on|off` toggle. Defaults to enabled.
   */
  uiEnabled?: boolean;

  /**
   * Desired state of the docs service. Defaults to disabled (matches the
   * launcher's DOCS_ENABLED gate).
   */
  docsEnabled?: boolean;

  /**
   * Desired state of the hosted UI tunnel sidecar. Defaults to the stack .env
   * token/enabled setting when unset.
   */
  tunnelEnabled?: boolean;
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: CLIConfig = {
  githubToken: undefined,
  remoteUrl: undefined,
  defaultProject: undefined,
  stackRoot: undefined,
  uiEnabled: undefined,
  docsEnabled: undefined,
  tunnelEnabled: undefined,
};
