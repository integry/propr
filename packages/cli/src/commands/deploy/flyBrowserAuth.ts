/**
 * Browser sign-in for `propr deploy fly`.
 *
 * The API picks its browser sign-in at boot (resolveBrowserAuthMode in
 * packages/api/connectAuth.ts) and serves a UI nobody can sign in to when it
 * resolves to `disabled`. For the Machine env this deploy writes, the usable
 * outcomes are:
 *   - connect  the tunnel flags pin PROPR_WEB_AUTH_MODE=connect, and
 *              planFlyRelay guarantees the relay URL + token Connect redeems
 *              login codes with;
 *   - github   a GitHub OAuth client (GH_OAUTH_CLIENT_ID + _SECRET) in the
 *              stack .env, called back at <public URL>/api/auth/github/callback;
 *   - device   relay-only: the relay token (existing or enrolled by this run)
 *              signs browsers in with GitHub's device flow and the shared
 *              App's public client ID, so no OAuth App and no callback URL
 *              are needed. A non-hosted relay also needs
 *              PROPR_GH_DEVICE_CLIENT_ID (its own App's client ID);
 *   - demo     PROPR_DEMO_MODE, where the read-only UI needs no sign-in.
 * Anything else is refused before provisioning.
 */

import { DEFAULT_PROPR_GH_RELAY_URL, parseTruthyEnvValue } from "@propr/shared";
import { buildAppEnv, flyPublicUrl, type FlyDeployPlan } from "./flyMachineConfig.js";

export type FlyBrowserAuth = "connect" | "github" | "device" | "demo";

/** What the relay plan leaves on the Machine, as planFlyRelay decided it. */
export interface FlyRelayOutcome {
  kind: "none" | "fill-url" | "enroll";
  baseUrl?: string;
}

/** Same placeholder rules as the API's isConfiguredValue (packages/api/connectAuth.ts). */
function isConfiguredValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && !normalized.startsWith("your_") && normalized !== "changeme");
}

/** The callback the API sends GitHub, as the Machine env sets it. */
export function flyOAuthCallbackUrl(plan: FlyDeployPlan): string {
  return buildAppEnv(plan).GH_OAUTH_CALLBACK_URL;
}

function hasOAuthClient(secrets: Readonly<Record<string, string>>): boolean {
  return isConfiguredValue(secrets.GH_OAUTH_CLIENT_ID) && isConfiguredValue(secrets.GH_OAUTH_CLIENT_SECRET);
}

/**
 * Whether sign-in falls through to device flow if a relay token is there:
 * no demo, no tunnel and no OAuth client. planFlyRelay pins the relay URL
 * for it, because the API reads PROPR_GH_RELAY_URL without a default.
 */
export function flyWantsDeviceSignIn(plan: FlyDeployPlan, secrets: Readonly<Record<string, string>>): boolean {
  return !parseTruthyEnvValue(secrets.PROPR_DEMO_MODE) && !plan.tunnel && !hasOAuthClient(secrets);
}

/** Same normalization as the API's hosted-relay check (origin + path, no trailing slash). */
function normalizedRelayUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * Decide how browsers sign in to the deployed control plane, or fail when they
 * could not. Synchronous and side-effect free, so it runs before any Fly call
 * (and on --dry-run). `secrets` are the ones this run uploads: Fly secret
 * values cannot be read back, so a client left on the app by an earlier
 * deploy is not evidence, and the stack .env has to carry it. `relay` is the
 * relay plan: an enrollment this run makes counts as a relay token.
 */
export function planFlyBrowserAuth(
  plan: FlyDeployPlan,
  secrets: Readonly<Record<string, string>>,
  relay: FlyRelayOutcome = { kind: "none" },
): FlyBrowserAuth {
  if (parseTruthyEnvValue(secrets.PROPR_DEMO_MODE)) return "demo";
  if (plan.tunnel) return "connect";
  if (hasOAuthClient(secrets)) return "github";
  const relayToken = Boolean(secrets.PROPR_GH_RELAY_TOKEN?.trim()) || relay.kind === "enroll";
  const relayUrl = relay.baseUrl ?? (secrets.PROPR_GH_RELAY_URL?.trim() || DEFAULT_PROPR_GH_RELAY_URL);
  const hostedRelay = normalizedRelayUrl(relayUrl) === normalizedRelayUrl(DEFAULT_PROPR_GH_RELAY_URL);
  if (relayToken && (hostedRelay || isConfiguredValue(secrets.PROPR_GH_DEVICE_CLIENT_ID))) return "device";
  const relayHint = relayToken
    ? `The relay at ${relayUrl} is not the hosted ProPR relay, so device sign-in also needs PROPR_GH_DEVICE_CLIENT_ID (the client ID of that relay's GitHub App, with Device Flow enabled) in the stack .env. Or `
    : "Run `propr login` so the deploy enrolls a relay token (browsers then sign in with GitHub device flow, no OAuth App needed), add PROPR_GH_RELAY_TOKEN (`propr relay enroll`) to the stack .env, ";
  throw new Error(
    `${flyPublicUrl(plan.app)} would serve a UI nobody can sign in to: the stack has no ProPR relay token for device sign-in and no GitHub OAuth client (GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET). `
      + relayHint
      + "pass --tunnel-token and --tunnel-url from ProPR Connect to sign in through https://app.propr.dev, "
      + `or add the client id and secret of a GitHub App or OAuth App whose callback URL is ${flyOAuthCallbackUrl(plan)} to the stack .env.`,
  );
}

/** One summary line naming how browsers sign in. */
export function describeFlyBrowserAuth(plan: FlyDeployPlan, auth: FlyBrowserAuth): string {
  if (auth === "connect") return "ProPR Connect at https://app.propr.dev";
  if (auth === "demo") return "none needed (PROPR_DEMO_MODE, read-only)";
  if (auth === "device") return `GitHub device sign-in at ${flyPublicUrl(plan.app)} (relay App, no OAuth App needed)`;
  return `GitHub OAuth (callback ${flyOAuthCallbackUrl(plan)})`;
}
