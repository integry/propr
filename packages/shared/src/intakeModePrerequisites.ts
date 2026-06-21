/**
 * Mode-specific GitHub intake prerequisite validation, shared so the backend
 * boot path and the CLI (`propr check`) agree on what each intake mode needs
 * before the daemon or API starts partially configured.
 *
 * Mode resolution (see githubEventIntakeMode) decides which intake path runs;
 * this helper validates the environment that path requires:
 *   routing_websocket — needs relay auth plus relay/routing credentials
 *   polling           — needs usable GitHub auth (relay or app)
 *   direct_webhook     — needs an own GitHub App plus a webhook secret
 *
 * Validation is intentionally side-effect free (no logging, no process exit)
 * so CLI checks and the boot path can both reuse it.
 */

import type { GithubAuthMode } from './githubAuthMode.js';
import type { GithubEventIntakeMode } from './githubEventIntakeMode.js';
import { validateRelayUrl } from './validateRelayUrl.js';

export interface IntakeModePrerequisitesEnv {
  /** Resolved GitHub event intake mode (see resolveGithubEventIntakeMode). */
  intakeMode: GithubEventIntakeMode;
  /** Resolved GitHub auth mode (see resolveGithubAuthMode). */
  authMode: GithubAuthMode;
  /** Raw PROPR_ROUTING_URL value. */
  routingUrl?: string;
  /** Raw PROPR_GH_RELAY_URL value. */
  relayUrl?: string;
  /** Raw PROPR_GH_RELAY_TOKEN value. */
  relayToken?: string;
  /** Raw GH_WEBHOOK_SECRET value. */
  webhookSecret?: string;
}

export interface IntakeModePrerequisitesResult {
  /** True when there are no blocking errors. */
  valid: boolean;
  /** Blocking configuration errors — the caller must not start until resolved. */
  errors: string[];
  /** Non-blocking advisories the caller should surface. */
  warnings: string[];
}

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Validate the environment prerequisites for the resolved intake mode.
 * Returns structured errors and warnings; never throws and never has side effects.
 */
export function validateIntakeModePrerequisites(
  env: IntakeModePrerequisitesEnv,
): IntakeModePrerequisitesResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Demo mode disables GitHub entirely, so no intake prerequisites apply.
  if (env.authMode === 'demo') {
    return { valid: true, errors, warnings };
  }

  switch (env.intakeMode) {
    case 'routing_websocket': {
      if (env.authMode !== 'relay') {
        errors.push(
          'routing_websocket intake requires relay auth mode. Set GH_AUTH_MODE=relay (or configure PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN so relay mode is inferred).',
        );
      }
      if (!isPresent(env.routingUrl)) {
        errors.push('PROPR_ROUTING_URL must be set for routing_websocket intake.');
      } else {
        const routingUrlError = validateRelayUrl(env.routingUrl);
        if (routingUrlError) {
          errors.push(`PROPR_ROUTING_URL is invalid: ${routingUrlError}`);
        }
      }
      if (!isPresent(env.relayUrl)) {
        errors.push('PROPR_GH_RELAY_URL must be set for routing_websocket intake.');
      }
      if (!isPresent(env.relayToken)) {
        errors.push('PROPR_GH_RELAY_TOKEN must be set for routing_websocket intake.');
      }
      break;
    }

    case 'polling': {
      // Polling pulls events from the GitHub API, so any usable GitHub auth
      // works — both the relay (shared-app) and app (own-app) paths qualify.
      if (env.authMode !== 'relay' && env.authMode !== 'app') {
        errors.push(
          'polling intake requires usable GitHub auth. Configure relay mode (PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN) or app mode (GH_APP_ID + GH_PRIVATE_KEY_PATH + GH_INSTALLATION_ID).',
        );
      }
      break;
    }

    case 'direct_webhook': {
      if (env.authMode !== 'app') {
        errors.push(
          'direct_webhook intake requires app auth mode (an own GitHub App). Set GH_AUTH_MODE=app and configure GH_APP_ID + GH_PRIVATE_KEY_PATH + GH_INSTALLATION_ID.',
        );
      }
      if (!isPresent(env.webhookSecret)) {
        errors.push('GH_WEBHOOK_SECRET must be set for direct_webhook intake.');
      }
      break;
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
