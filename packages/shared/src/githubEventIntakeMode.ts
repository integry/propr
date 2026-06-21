/**
 * GitHub event intake mode resolution, shared so the backend boot path and
 * any tooling agree on how GitHub events are delivered.
 *
 * Auth mode (see githubAuthMode) and event delivery mode are now independent:
 * how ProPR authenticates to GitHub no longer dictates how it receives events.
 *
 * Event intake is configured one of three ways:
 *   routing_websocket — events arrive over a routing WebSocket (the default)
 *   polling           — events are pulled by polling the GitHub API
 *   direct_webhook    — events are delivered to a local webhook endpoint
 * An explicit GITHUB_EVENT_INTAKE_MODE selects the mode; unset defaults to
 * routing_websocket. The legacy boolean ENABLE_GITHUB_WEBHOOKS is deprecated
 * and no longer selects the mode.
 */

export type GithubEventIntakeMode = 'routing_websocket' | 'polling' | 'direct_webhook';

export const GITHUB_EVENT_INTAKE_MODES: readonly GithubEventIntakeMode[] = [
  'routing_websocket',
  'polling',
  'direct_webhook',
];

export const DEFAULT_GITHUB_EVENT_INTAKE_MODE: GithubEventIntakeMode = 'routing_websocket';

export interface GithubEventIntakeModeEnv {
  /** Raw GITHUB_EVENT_INTAKE_MODE value. */
  eventIntakeMode?: string;
  /** Raw ENABLE_GITHUB_WEBHOOKS value (legacy, deprecated — no longer selects the mode). */
  enableGithubWebhooks?: string;
}

export interface GithubEventIntakeModeResult {
  mode: GithubEventIntakeMode;
  /** Human-readable warnings the caller should surface (logged by the backend). */
  warnings: string[];
}

function isGithubEventIntakeMode(value: string): value is GithubEventIntakeMode {
  return (GITHUB_EVENT_INTAKE_MODES as readonly string[]).includes(value);
}

export function resolveGithubEventIntakeMode(env: GithubEventIntakeModeEnv): GithubEventIntakeModeResult {
  const warnings: string[] = [];

  // The legacy boolean no longer selects the mode — surface a deprecation
  // notice whenever it is present so operators can migrate off it.
  if (env.enableGithubWebhooks !== undefined) {
    warnings.push(
      'ENABLE_GITHUB_WEBHOOKS is deprecated and no longer selects the GitHub event intake mode. Set GITHUB_EVENT_INTAKE_MODE to "routing_websocket", "polling", or "direct_webhook" instead.',
    );
  }

  const explicit = (env.eventIntakeMode || '').trim().toLowerCase();
  if (!explicit) {
    return { mode: DEFAULT_GITHUB_EVENT_INTAKE_MODE, warnings };
  }
  if (isGithubEventIntakeMode(explicit)) {
    return { mode: explicit, warnings };
  }

  throw new Error(
    `GITHUB_EVENT_INTAKE_MODE="${env.eventIntakeMode}" is not a recognized value (expected ${GITHUB_EVENT_INTAKE_MODES.map((m) => `"${m}"`).join(', ')}).`,
  );
}
