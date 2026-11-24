/**
 * GitHub event intake for `propr deploy fly`.
 *
 * Unset, GITHUB_EVENT_INTAKE_MODE means routing_websocket, and the daemon then
 * opens the relay WebSocket, which throws without PROPR_GH_RELAY_TOKEN and
 * takes the all-in-one process (and the Machine) down with it. So every
 * deploy pins a mode the Machine can run:
 *
 *   demo                   direct_webhook: the passive mode. Demo mode has no
 *                          GitHub access, opens no relay connection, polls
 *                          nothing, and the API disables POST /webhook.
 *   relay auth + token     routing_websocket (events through the hosted relay)
 *   own GitHub App         direct_webhook with GH_WEBHOOK_SECRET, else polling
 *
 * A mode the stack .env sets is kept, but checked with the same prerequisite
 * rules the daemon applies at boot. Fly secret values cannot be read back, so
 * a secret left by an earlier deploy counts by name only.
 */

import {
  parseTruthyEnvValue,
  resolveGithubEventIntakeMode,
  validateIntakeModePrerequisites,
  type GithubEventIntakeMode,
} from "@propr/shared";
import { FLY_GH_PRIVATE_KEY_SECRET } from "./flyMachineConfig.js";

export const FLY_INTAKE_MODE_KEY = "GITHUB_EVENT_INTAKE_MODE";

type IntakeAuthMode = "demo" | "relay" | "app";

export interface FlyIntakeSelection {
  /** Secrets to merge over the ones this run sets. */
  secrets: Record<string, string>;
  /** One line for the deploy log. */
  summary: string;
}

/**
 * Pick (or check) the intake mode for the app secrets after this deploy:
 * `values` are the secrets this run sets, `existing` the names the app
 * already has. Throws when the Machine could not start its daemon.
 */
export function selectFlyIntakeMode(values: Readonly<Record<string, string>>, existing: ReadonlySet<string>): FlyIntakeSelection {
  const has = (name: string): boolean => Boolean(values[name]?.trim()) || (!(name in values) && existing.has(name));
  const relayToken = has("PROPR_GH_RELAY_TOKEN");

  if (parseTruthyEnvValue(values.PROPR_DEMO_MODE)) {
    return { secrets: { [FLY_INTAKE_MODE_KEY]: "direct_webhook" }, summary: "GitHub event intake: off (demo mode)." };
  }

  const auth = authMode(values, has, relayToken);
  if (!auth) {
    throw new Error(
      "The Machine would have no GitHub credentials, so its daemon could not start. Run `propr login` so the deploy enrolls a GitHub relay token (drop --no-relay), "
        + "add your own GitHub App (GH_APP_ID, GH_INSTALLATION_ID and HOST_GH_PRIVATE_KEY or --github-app-key) to the stack .env, or set PROPR_DEMO_MODE=true for a read-only demo.",
    );
  }

  const explicit = values[FLY_INTAKE_MODE_KEY]?.trim();
  const mode: GithubEventIntakeMode = explicit
    ? resolveGithubEventIntakeMode({ eventIntakeMode: explicit }).mode
    : auth === "relay" ? "routing_websocket" : has("GH_WEBHOOK_SECRET") ? "direct_webhook" : "polling";

  const { errors } = validateIntakeModePrerequisites({
    intakeMode: mode,
    authMode: auth,
    routingUrl: values.PROPR_ROUTING_URL,
    relayUrl: values.PROPR_GH_RELAY_URL,
    // Presence is all that matters here; values are never inspected.
    relayToken: relayToken ? "set" : undefined,
    webhookSecret: has("GH_WEBHOOK_SECRET") ? "set" : undefined,
  });
  if (errors.length > 0) {
    const fix = mode === "routing_websocket"
      ? "Drop --no-relay so a relay token is enrolled, add PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env, or set GITHUB_EVENT_INTAKE_MODE=polling."
      : `Fix ${FLY_INTAKE_MODE_KEY} or the GitHub credentials in the stack .env.`;
    throw new Error(`GitHub event intake ${mode} cannot start on the Machine: ${errors.join(" ")} ${fix}`);
  }
  const why = explicit ? "from the stack .env" : auth === "relay" ? "relay token" : mode === "direct_webhook" ? "own GitHub App with GH_WEBHOOK_SECRET" : "own GitHub App without GH_WEBHOOK_SECRET";
  return { secrets: { [FLY_INTAKE_MODE_KEY]: mode }, summary: `GitHub event intake: ${mode} (${why}).` };
}

/** GH_AUTH_MODE as set this run, else what the daemon would infer from the secrets the app holds. */
function authMode(values: Readonly<Record<string, string>>, has: (name: string) => boolean, relayToken: boolean): IntakeAuthMode | undefined {
  const explicit = values.GH_AUTH_MODE?.trim().toLowerCase();
  if (explicit === "relay" || explicit === "app") return explicit;
  if (relayToken) return "relay";
  if (has("GH_APP_ID") && has(FLY_GH_PRIVATE_KEY_SECRET)) return "app";
  return undefined;
}
