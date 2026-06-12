/**
 * GitHub auth mode inference, shared by the backend (@propr/core githubAuth)
 * and the CLI (`propr check`) so the two can't drift.
 *
 * Auth is configured one of three ways:
 *   demo  — no GitHub access
 *   relay — fetch installation tokens from a vendor relay (shared-app path)
 *   app   — mint installation tokens locally from the App private key (own-app)
 * An explicit GH_AUTH_MODE overrides the inference.
 */

export type GithubAuthMode = 'demo' | 'relay' | 'app' | 'none';

export interface GithubAuthModeEnv {
  /** Already-parsed PROPR_DEMO_MODE truthiness. */
  demoMode?: boolean;
  /** Raw GH_AUTH_MODE value. */
  ghAuthMode?: string;
  relayUrl?: string;
  relayToken?: string;
  appId?: string;
  privateKeyPath?: string;
  installationId?: string;
}

export interface GithubAuthModeResult {
  mode: GithubAuthMode;
  /** Human-readable warnings the caller should surface (logged by the backend). */
  warnings: string[];
}

export function resolveGithubAuthMode(env: GithubAuthModeEnv): GithubAuthModeResult {
  const warnings: string[] = [];
  if (env.demoMode) return { mode: 'demo', warnings };

  const explicit = (env.ghAuthMode || '').trim().toLowerCase();
  if (explicit === 'demo') {
    warnings.push('GH_AUTH_MODE=demo only disables GitHub auth. Set PROPR_DEMO_MODE=true for full demo-mode behavior across the API and workers.');
    return { mode: 'demo', warnings };
  }
  if (explicit === 'relay') return { mode: 'relay', warnings };
  if (explicit === 'app') return { mode: 'app', warnings };
  if (explicit) {
    warnings.push(`GH_AUTH_MODE="${env.ghAuthMode}" is not a recognized value (expected "app", "relay", or "demo"). Falling back to auto-detection.`);
  }

  // Inferred relay requires both URL and token so a stray placeholder URL
  // doesn't shadow a fully valid GitHub App configuration.
  if (env.relayUrl && env.relayToken) return { mode: 'relay', warnings };
  if (env.appId && env.privateKeyPath && env.installationId) return { mode: 'app', warnings };
  return { mode: 'none', warnings };
}
