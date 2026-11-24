/**
 * GitHub relay credentials for `propr deploy fly`.
 *
 * Two consumers need relay credentials, and they are decided separately:
 *   - GitHub API auth: a stack with its own GitHub App (GH_APP_ID + key) mints
 *     installation tokens locally and needs no relay.
 *   - Browser sign-in through ProPR Connect (the tunnel flags select
 *     PROPR_WEB_AUTH_MODE=connect): the API redeems Connect login codes with
 *     PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN and refuses to start without
 *     them, own App or not.
 *
 * So own-App credentials suppress automatic enrollment only when Connect is
 * off. With Connect on and no relay token, a token is enrolled (keeping the
 * own App for API auth), or the deploy stops before anything is provisioned.
 */

import { DEFAULT_PROPR_GH_RELAY_URL, validateRelayUrl } from "@propr/shared";
import { enrollRelayToken, type RelayClientOptions } from "../../api/relay.js";
import { discoverInstallationId } from "../relayCommands.js";
import { FLY_GH_PRIVATE_KEY_SECRET } from "./flyMachineConfig.js";

export interface FlyRelayOptions {
  relay?: boolean;
  relayUrl?: string;
  installation?: string;
}

export interface FlyRelayContext {
  /** Connect browser sign-in is selected (the tunnel flags were given). */
  connect: boolean;
  /** GitHub token from `propr login`, if any. */
  githubToken?: string;
}

export interface FlyRelayDeps {
  discoverInstallationId: (client: RelayClientOptions) => Promise<string>;
  enrollRelayToken: (client: RelayClientOptions, body: { installationId: string; label: string }) => Promise<{ token: string }>;
}

export interface FlyRelayResult {
  /** Secrets to merge over the collected ones. */
  secrets: Record<string, string>;
  /** Set when a new relay token was enrolled. */
  enrolledInstallationId?: string;
}

type RelayPlan =
  | { kind: "none" }
  | { kind: "fill-url"; baseUrl: string }
  | { kind: "enroll"; baseUrl: string; keepOwnApp: boolean };

function hasOwnApp(secrets: Record<string, string>): boolean {
  return Boolean(secrets.GH_APP_ID && secrets[FLY_GH_PRIVATE_KEY_SECRET]);
}

function relayBaseUrl(options: FlyRelayOptions, secrets: Record<string, string>): string {
  const baseUrl = options.relayUrl ?? (secrets.PROPR_GH_RELAY_URL?.trim() || DEFAULT_PROPR_GH_RELAY_URL);
  const urlError = validateRelayUrl(baseUrl);
  if (urlError) throw new Error(urlError);
  return baseUrl;
}

/**
 * Decide what relay work the deploy needs, and fail on combinations that
 * cannot produce a working Machine. Synchronous and side-effect free, so it
 * runs before any Fly call (and on --dry-run).
 */
export function planFlyRelay(options: FlyRelayOptions, secrets: Record<string, string>, context: FlyRelayContext): RelayPlan {
  const hasRelayToken = Boolean(secrets.PROPR_GH_RELAY_TOKEN?.trim());
  const connectNeedsToken = context.connect && !hasRelayToken;
  const auto = options.relay === undefined;

  if (connectNeedsToken && options.relay === false) {
    throw new Error(
      "ProPR Connect (--tunnel-token/--tunnel-url) signs browsers in with a GitHub relay token, but --no-relay was given and the stack .env has no PROPR_GH_RELAY_TOKEN. Drop --no-relay so one is enrolled, or add PROPR_GH_RELAY_URL and PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env.",
    );
  }
  const enroll = options.relay === true || connectNeedsToken || (auto && !hasRelayToken && !hasOwnApp(secrets));
  if (!enroll) {
    // Connect reads PROPR_GH_RELAY_URL without the hosted default the GitHub
    // API path applies, so pin it next to an existing token.
    if (context.connect && !secrets.PROPR_GH_RELAY_URL?.trim()) return { kind: "fill-url", baseUrl: relayBaseUrl(options, secrets) };
    return { kind: "none" };
  }
  if (!context.githubToken) {
    if (connectNeedsToken) {
      throw new Error(
        "ProPR Connect (--tunnel-token/--tunnel-url) signs browsers in with a GitHub relay token, and the stack .env has none. Run `propr login` so the deploy can enroll one, or add PROPR_GH_RELAY_URL and PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env.",
      );
    }
    if (options.relay === true) throw new Error("--relay needs a GitHub login; run `propr login` first");
    return { kind: "none" };
  }
  // Enrolled only for Connect sign-in: the own App keeps GitHub API auth.
  return { kind: "enroll", baseUrl: relayBaseUrl(options, secrets), keepOwnApp: auto && hasOwnApp(secrets) };
}

/** Enroll (or complete) the relay credentials {@link planFlyRelay} calls for. */
export async function resolveFlyRelaySecrets(
  options: FlyRelayOptions,
  secrets: Record<string, string>,
  context: FlyRelayContext & { label: string },
  deps: FlyRelayDeps = { discoverInstallationId, enrollRelayToken },
): Promise<FlyRelayResult | undefined> {
  const plan = planFlyRelay(options, secrets, context);
  if (plan.kind === "none") return undefined;
  if (plan.kind === "fill-url") return { secrets: { PROPR_GH_RELAY_URL: plan.baseUrl } };

  const client = { baseUrl: plan.baseUrl, githubToken: context.githubToken! };
  // An own App's GH_INSTALLATION_ID belongs to that App, not to the shared
  // App installation the relay token is bound to.
  const knownInstallation = plan.keepOwnApp ? undefined : secrets.GH_INSTALLATION_ID;
  const installationId = options.installation ?? knownInstallation ?? (await deps.discoverInstallationId(client));
  const enrolled = await deps.enrollRelayToken(client, { installationId, label: context.label });
  const relay = { PROPR_GH_RELAY_URL: plan.baseUrl, PROPR_GH_RELAY_TOKEN: enrolled.token };
  if (plan.keepOwnApp) {
    // URL + token would otherwise infer relay mode and shadow the own App.
    return { secrets: { ...relay, GH_AUTH_MODE: secrets.GH_AUTH_MODE || "app" }, enrolledInstallationId: installationId };
  }
  return { secrets: { ...relay, GH_AUTH_MODE: "relay", GH_INSTALLATION_ID: installationId }, enrolledInstallationId: installationId };
}
