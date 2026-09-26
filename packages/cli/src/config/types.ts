/**
 * CLI Configuration Types
 *
 * These types define the configuration schema for the CLI.
 */

export interface RemoteProfile {
  remoteUrl?: string;
  githubToken?: string;
  defaultProject?: string;
}

/**
 * CLI configuration structure as stored on disk. Remote settings (remoteUrl,
 * githubToken, defaultProject) live only on named profiles.
 */
export interface CLIConfig {
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
   * Desired state of the Cloudflare Tunnel service, keyed by absolute stack
   * root. Keeping this state per root prevents an explicit stack from inheriting
   * another stack's `propr tunnel on|off` choice.
   */
  tunnelEnabledByRoot?: Record<string, boolean>;
}

/**
 * Values addressable through the generic get/set accessors. Remote settings
 * are virtual keys routed to the active profile rather than stored top-level.
 */
export type ConfigValues = CLIConfig & RemoteProfile;

/**
 * Supported configuration keys for the CLI.
 */
export type ConfigKey = keyof ConfigValues;

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: CLIConfig = {
  activeProfile: undefined,
  profiles: undefined,
  stackRoot: undefined,
  uiEnabled: undefined,
  docsEnabled: undefined,
  tunnelEnabledByRoot: undefined,
};
