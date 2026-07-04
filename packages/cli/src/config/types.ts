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
  | "activeProfile"
  | "profiles"
  | "stackRoot"
  | "uiEnabled"
  | "docsEnabled"
  | "tunnelEnabled";

export interface RemoteProfile {
  remoteUrl?: string;
  githubToken?: string;
  defaultProject?: string;
}

/**
 * CLI configuration structure.
 */
export interface CLIConfig {
  /**
   * GitHub personal access token for authentication.
   *
   * Accepted on load from configs written before named profiles existed and
   * migrated into the active profile; the profile is the source of truth and
   * this field is never written back.
   */
  githubToken?: string;

  /**
   * Remote API URL for the ProPR backend.
   *
   * Accepted on load from configs written before named profiles existed and
   * migrated into the active profile; the profile is the source of truth and
   * this field is never written back.
   */
  remoteUrl?: string;

  /**
   * Default project to use when not specified in commands.
   * Format: owner/repo
   *
   * Accepted on load from configs written before named profiles existed and
   * migrated into the active profile; the profile is the source of truth and
   * this field is never written back.
   */
  defaultProject?: string;

  /**
   * Name of the active backend profile. Defaults to "default".
   */
  activeProfile?: string;

  /**
   * Named backend profiles holding remoteUrl/githubToken/defaultProject.
   * This is the single source of truth for remote settings.
   */
  profiles?: Record<string, RemoteProfile>;

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
   * Desired state of the Cloudflare Tunnel service. Persisted so `propr start`
   * honors a previous `propr tunnel on|off` toggle. When unset, the launcher
   * falls back to its env-derived default (a configured PROPR_UI_TUNNEL_TOKEN
   * or PROPR_UI_TUNNEL_ENABLED=true).
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
  activeProfile: undefined,
  profiles: undefined,
  stackRoot: undefined,
  uiEnabled: undefined,
  docsEnabled: undefined,
  tunnelEnabled: undefined,
};
