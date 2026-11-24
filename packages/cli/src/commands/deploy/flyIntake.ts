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
 * a secret left by an earlier deploy counts by name only. That includes
 * GH_AUTH_MODE: when an earlier one could be either relay or app (both kinds
 * of credentials are present), polling (valid under both) is pinned. The
 * intake an earlier deploy pinned is not kept: it cannot be read back either,
 * and a demo deploy pins direct_webhook under demo mode's exemption from the
 * prerequisite checks, so it may not start once demo mode is off.
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

  const auths = authModes(values, existing, has, relayToken);
  if (auths.length === 0) {
    throw new Error(
      "The Machine would have no GitHub credentials, so its daemon could not start. Run `propr login` so the deploy enrolls a GitHub relay token (drop --no-relay), "
        + "add your own GitHub App (GH_APP_ID, GH_INSTALLATION_ID and HOST_GH_PRIVATE_KEY or --github-app-key) to the stack .env, or set PROPR_DEMO_MODE=true for a read-only demo.",
    );
  }

  // Checked here, apart from the intake: an auth mode without its
  // credentials makes core GitHub auth exit at boot under any intake mode.
  const missing = [...new Set(auths.flatMap((authMode) => missingAuthCredentials(authMode, has)))];
  if (missing.length > 0) {
    throw new Error(
      `GitHub auth mode ${auths.join(" or ")} on the Machine needs ${missing.join(", ")}, and neither this deploy nor an earlier one sets it, so its daemon could not start. `
        + "Add the missing values to the stack .env, or set GH_AUTH_MODE to the mode whose credentials you have.",
    );
  }

  const explicit = values[FLY_INTAKE_MODE_KEY]?.trim();
  // Several candidates: GH_AUTH_MODE is a secret an earlier deploy left, known
  // by name only, and both relay and App credentials are present. Polling runs
  // under either mode. The intake pinned earlier is unreadable too, and may
  // have been a demo deploy's direct_webhook, so it is replaced, not kept.
  const auth = auths[0]!;
  const mode: GithubEventIntakeMode = explicit
    ? resolveGithubEventIntakeMode({ eventIntakeMode: explicit }).mode
    : auths.length > 1 ? "polling"
      : auth === "relay" ? "routing_websocket" : has("GH_WEBHOOK_SECRET") ? "direct_webhook" : "polling";

  // The mode must start under every GH_AUTH_MODE the Machine could end up with.
  const errors = [...new Set(auths.flatMap((authMode) => validateIntakeModePrerequisites({
    intakeMode: mode,
    authMode,
    routingUrl: values.PROPR_ROUTING_URL,
    relayUrl: values.PROPR_GH_RELAY_URL,
    // Presence is all that matters here; values are never inspected.
    relayToken: relayToken ? "set" : undefined,
    webhookSecret: has("GH_WEBHOOK_SECRET") ? "set" : undefined,
  }).errors))];
  if (errors.length > 0) {
    const fix = auths.length > 1
      ? "GH_AUTH_MODE from an earlier deploy cannot be read back; set GH_AUTH_MODE (relay or app) in the stack .env so the intake can match it."
      : mode === "routing_websocket"
        ? "Drop --no-relay so a relay token is enrolled, add PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env, or set GITHUB_EVENT_INTAKE_MODE=polling."
        : `Fix ${FLY_INTAKE_MODE_KEY} or the GitHub credentials in the stack .env.`;
    throw new Error(`GitHub event intake ${mode} cannot start on the Machine: ${errors.join(" ")} ${fix}`);
  }
  const why = explicit ? "from the stack .env"
    : auths.length > 1 ? "GH_AUTH_MODE from an earlier deploy, relay token and own GitHub App"
      : auth === "relay" ? "relay token" : mode === "direct_webhook" ? "own GitHub App with GH_WEBHOOK_SECRET" : "own GitHub App without GH_WEBHOOK_SECRET";
  return { secrets: { [FLY_INTAKE_MODE_KEY]: mode }, summary: `GitHub event intake: ${mode} (${why}).` };
}

/**
 * What core GitHub auth (packages/core/src/auth/githubAuth.ts) requires for
 * `authMode` and the Machine would lack, named as the stack .env sets it.
 * The private key reaches the Machine as FLY_GH_PRIVATE_KEY_SECRET, written to
 * the file GH_PRIVATE_KEY_PATH points at.
 */
function missingAuthCredentials(authMode: IntakeAuthMode, has: (name: string) => boolean): string[] {
  if (authMode === "relay") return has("PROPR_GH_RELAY_TOKEN") ? [] : ["PROPR_GH_RELAY_TOKEN"];
  if (authMode !== "app") return [];
  return [
    !has("GH_APP_ID") && "GH_APP_ID",
    !has(FLY_GH_PRIVATE_KEY_SECRET) && "the App private key (HOST_GH_PRIVATE_KEY or --github-app-key)",
    !has("GH_INSTALLATION_ID") && "GH_INSTALLATION_ID",
  ].filter((name): name is string => Boolean(name));
}

/**
 * The GH_AUTH_MODE values the Machine could run with: the one set this run,
 * else what the daemon would infer from the secrets the app holds. A mode left
 * by an earlier deploy outranks inference but cannot be read back, so with
 * both relay and App credentials present either is possible.
 */
function authModes(
  values: Readonly<Record<string, string>>,
  existing: ReadonlySet<string>,
  has: (name: string) => boolean,
  relayToken: boolean,
): IntakeAuthMode[] {
  const explicit = values.GH_AUTH_MODE?.trim().toLowerCase();
  if (explicit === "relay" || explicit === "app") return [explicit];
  // Inference needs all three, as resolveGithubAuthMode does; a set mode is
  // taken as is and its credentials checked by missingAuthCredentials.
  const app = has("GH_APP_ID") && has(FLY_GH_PRIVATE_KEY_SECRET) && has("GH_INSTALLATION_ID");
  if (!("GH_AUTH_MODE" in values) && existing.has("GH_AUTH_MODE") && relayToken && app) return ["relay", "app"];
  if (relayToken) return ["relay"];
  if (app) return ["app"];
  return [];
}
