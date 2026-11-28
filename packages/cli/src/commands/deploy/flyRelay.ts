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
 * off, and so does PROPR_DEMO_MODE (a read-only demo has no GitHub access).
 * With Connect on and no relay token, a token is enrolled, or the deploy
 * stops before anything is provisioned.
 *
 * The deploy also writes the GitHub API auth mode it selects, unless the stack
 * sets GH_AUTH_MODE itself. Fly secrets are only ever added or replaced, so a
 * mode, relay token or installation id from an earlier deploy stays in the
 * Machine env, and an earlier GH_AUTH_MODE outranks whatever this run's
 * credentials would infer. The own App keeps API auth (GH_AUTH_MODE=app)
 * unless the stack pins relay mode or --relay switches; relay credentials
 * without an own App pin GH_AUTH_MODE=relay. A run with no GitHub credentials
 * at all pins nothing and leaves the earlier ones in charge.
 */

import { DEFAULT_PROPR_GH_RELAY_URL, parseTruthyEnvValue, validateRelayUrl } from "@propr/shared";
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
  /** Browsers sign in with device flow through the relay (no tunnel, OAuth client or demo). */
  deviceSignIn?: boolean;
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

/** keepOwnApp: the own App keeps GitHub API auth next to any relay credentials in the Machine env. */
type RelayPlan =
  | { kind: "none"; keepOwnApp: boolean }
  | { kind: "fill-url"; baseUrl: string; keepOwnApp: boolean }
  | { kind: "enroll"; baseUrl: string; keepOwnApp: boolean };

function hasOwnApp(secrets: Record<string, string>): boolean {
  return Boolean(secrets.GH_APP_ID && secrets[FLY_GH_PRIVATE_KEY_SECRET]);
}

/** GH_AUTH_MODE as resolveGithubAuthMode reads it; "" means the mode is inferred. */
function explicitAuthMode(secrets: Record<string, string>): string {
  return (secrets.GH_AUTH_MODE ?? "").trim().toLowerCase();
}

/**
 * GH_INSTALLATION_ID next to a GitHub App id belongs to that App, not to the
 * shared App the relay binds tokens to, whether or not the own App keeps API
 * auth. `propr relay enroll` pins GH_AUTH_MODE=relay when it writes a
 * shared-App installation, so that pin makes the id reusable.
 */
function sharedAppInstallation(secrets: Record<string, string>): string | undefined {
  if (secrets.GH_APP_ID?.trim() && explicitAuthMode(secrets) !== "relay") return undefined;
  return secrets.GH_INSTALLATION_ID?.trim() || undefined;
}

/**
 * The own App keeps API auth unless the stack pins relay mode or --relay
 * switches to it, Connect or not: relay credentials in the Machine env, from
 * Connect or an earlier deploy, would otherwise take API auth over.
 */
function keepsOwnApp(options: FlyRelayOptions, secrets: Record<string, string>): boolean {
  return options.relay !== true && hasOwnApp(secrets) && explicitAuthMode(secrets) !== "relay";
}

/**
 * GH_AUTH_MODE for the API auth this run selects, unless the stack sets a mode
 * (uploaded as is). An enrollment that does not keep the own App writes relay
 * mode itself, see resolveFlyRelaySecrets.
 */
function selectedAuthMode(plan: RelayPlan, secrets: Record<string, string>): Record<string, string> {
  if (explicitAuthMode(secrets)) return {};
  if (plan.keepOwnApp) return { GH_AUTH_MODE: "app" };
  if (secrets.PROPR_GH_RELAY_TOKEN?.trim()) return { GH_AUTH_MODE: "relay" };
  return {};
}

/**
 * App mode needs the own App's installation id from this run: an earlier
 * relay enrollment leaves the shared App's GH_INSTALLATION_ID on the Fly app,
 * and the own App would silently mint tokens against it.
 */
function assertOwnAppInstallation(secrets: Record<string, string>): void {
  const mode = explicitAuthMode(secrets);
  if ((mode === "" || mode === "app") && !secrets.GH_INSTALLATION_ID?.trim()) {
    throw new Error(
      "Your own GitHub App (GH_APP_ID and its private key) keeps GitHub API calls, but the stack .env has no GH_INSTALLATION_ID. Add the installation id of that App to the stack .env, or pass --relay to use the shared ProPR App instead.",
    );
  }
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
  // A read-only demo has no GitHub access and needs no relay token unless
  // Connect signs browsers in, so it is not enrolled by default.
  const demo = parseTruthyEnvValue(secrets.PROPR_DEMO_MODE);
  const enroll = options.relay === true || connectNeedsToken || (auto && !hasRelayToken && !hasOwnApp(secrets) && !demo);
  const keepOwnApp = keepsOwnApp(options, secrets);
  if (keepOwnApp) assertOwnAppInstallation(secrets);
  if (!enroll) {
    // Connect and device sign-in read PROPR_GH_RELAY_URL without the hosted
    // default the GitHub API path applies, so pin it next to an existing token.
    const signInNeedsUrl = context.connect || (context.deviceSignIn === true && hasRelayToken);
    if (signInNeedsUrl && !secrets.PROPR_GH_RELAY_URL?.trim()) return { kind: "fill-url", baseUrl: relayBaseUrl(options, secrets), keepOwnApp };
    return { kind: "none", keepOwnApp };
  }
  if (!context.githubToken) {
    if (connectNeedsToken) {
      throw new Error(
        "ProPR Connect (--tunnel-token/--tunnel-url) signs browsers in with a GitHub relay token, and the stack .env has none. Run `propr login` so the deploy can enroll one, or add PROPR_GH_RELAY_URL and PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env.",
      );
    }
    if (options.relay === true) throw new Error("--relay needs a GitHub login; run `propr login` first");
    return { kind: "none", keepOwnApp };
  }
  return { kind: "enroll", baseUrl: relayBaseUrl(options, secrets), keepOwnApp };
}

/**
 * The secrets a plan without enrollment adds: the GitHub API auth mode it
 * selects and, for Connect, the relay URL. Side-effect free, so --dry-run
 * applies exactly what a real run would before it checks the intake mode.
 * Undefined for an enrollment, whose token only a real run can get.
 */
export function plannedFlyRelaySecrets(plan: RelayPlan, secrets: Record<string, string>): Record<string, string> | undefined {
  if (plan.kind === "enroll") return undefined;
  const authMode = selectedAuthMode(plan, secrets);
  return plan.kind === "fill-url" ? { PROPR_GH_RELAY_URL: plan.baseUrl, ...authMode } : authMode;
}

/** Enroll (or complete) the relay credentials {@link planFlyRelay} calls for. */
export async function resolveFlyRelaySecrets(
  options: FlyRelayOptions,
  secrets: Record<string, string>,
  context: FlyRelayContext & { label: string },
  deps: FlyRelayDeps = { discoverInstallationId, enrollRelayToken },
): Promise<FlyRelayResult | undefined> {
  const plan = planFlyRelay(options, secrets, context);
  if (plan.kind !== "enroll") {
    const planned = plannedFlyRelaySecrets(plan, secrets) ?? {};
    return Object.keys(planned).length > 0 ? { secrets: planned } : undefined;
  }
  const authMode = selectedAuthMode(plan, secrets);

  const client = { baseUrl: plan.baseUrl, githubToken: context.githubToken! };
  const installationId = options.installation ?? sharedAppInstallation(secrets) ?? (await deps.discoverInstallationId(client));
  const enrolled = await deps.enrollRelayToken(client, { installationId, label: context.label });
  const relay = { PROPR_GH_RELAY_URL: plan.baseUrl, PROPR_GH_RELAY_TOKEN: enrolled.token };
  if (plan.keepOwnApp) {
    // GH_INSTALLATION_ID stays the own App's; the token carries the shared one.
    return { secrets: { ...relay, ...authMode }, enrolledInstallationId: installationId };
  }
  return { secrets: { ...relay, GH_AUTH_MODE: "relay", GH_INSTALLATION_ID: installationId }, enrolledInstallationId: installationId };
}
