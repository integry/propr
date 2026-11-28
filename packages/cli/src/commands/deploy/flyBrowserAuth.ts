/**
 * Browser sign-in for `propr deploy fly`.
 *
 * The API picks its browser sign-in at boot (resolveBrowserAuthMode in
 * packages/api/connectAuth.ts) and serves a UI nobody can sign in to when it
 * resolves to `disabled`. For the Machine env this deploy writes, the only
 * usable outcomes are:
 *   - connect  the tunnel flags pin PROPR_WEB_AUTH_MODE=connect, and
 *              planFlyRelay guarantees the relay URL + token Connect redeems
 *              login codes with;
 *   - github   a GitHub OAuth client (GH_OAUTH_CLIENT_ID + _SECRET) in the
 *              stack .env, called back at <public URL>/api/auth/github/callback;
 *   - demo     PROPR_DEMO_MODE, where the read-only UI needs no sign-in.
 * The automatic Connect path for relay-only stacks needs a loopback callback,
 * and the Fly callback is always the public HTTPS URL, so a relay token alone
 * never signs a browser in here. Anything else is refused before provisioning.
 */

import { parseTruthyEnvValue } from "@propr/shared";
import { buildAppEnv, flyPublicUrl, type FlyDeployPlan } from "./flyMachineConfig.js";

export type FlyBrowserAuth = "connect" | "github" | "demo";

/** Same placeholder rules as the API's isConfiguredValue (packages/api/connectAuth.ts). */
function isConfiguredValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && !normalized.startsWith("your_") && normalized !== "changeme");
}

/** The callback the API sends GitHub, as the Machine env sets it. */
export function flyOAuthCallbackUrl(plan: FlyDeployPlan): string {
  return buildAppEnv(plan).GH_OAUTH_CALLBACK_URL;
}

/**
 * Decide how browsers sign in to the deployed control plane, or fail when they
 * could not. Synchronous and side-effect free, so it runs before any Fly call
 * (and on --dry-run). `secrets` are the ones this run uploads: Fly secret
 * values cannot be read back, so a client left on the app by an earlier
 * deploy is not evidence, and the stack .env has to carry it.
 */
export function planFlyBrowserAuth(plan: FlyDeployPlan, secrets: Readonly<Record<string, string>>): FlyBrowserAuth {
  if (parseTruthyEnvValue(secrets.PROPR_DEMO_MODE)) return "demo";
  if (plan.tunnel) return "connect";
  if (isConfiguredValue(secrets.GH_OAUTH_CLIENT_ID) && isConfiguredValue(secrets.GH_OAUTH_CLIENT_SECRET)) return "github";
  throw new Error(
    `${flyPublicUrl(plan.app)} would serve a UI nobody can sign in to: without ProPR Connect the API signs browsers in with a GitHub OAuth client, and the stack .env has no GH_OAUTH_CLIENT_ID and GH_OAUTH_CLIENT_SECRET. `
      + "Pass --tunnel-token and --tunnel-url from ProPR Connect to sign in through https://app.propr.dev, "
      + `or add the client id and secret of a GitHub App or OAuth App whose callback URL is ${flyOAuthCallbackUrl(plan)} to the stack .env.`,
  );
}

/** One summary line naming how browsers sign in. */
export function describeFlyBrowserAuth(plan: FlyDeployPlan, auth: FlyBrowserAuth): string {
  if (auth === "connect") return "ProPR Connect at https://app.propr.dev";
  if (auth === "demo") return "none needed (PROPR_DEMO_MODE, read-only)";
  return `GitHub OAuth (callback ${flyOAuthCallbackUrl(plan)})`;
}
