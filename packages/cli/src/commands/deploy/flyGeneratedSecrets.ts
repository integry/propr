/**
 * Secrets `propr deploy fly` generates, and the ProPR MCP defaults it turns on.
 *
 * Generated secrets are set only when the app does not already have them and
 * the stack .env (or the environment) does not supply them, so a redeploy
 * never rotates them (see runFlyDeploy). The list (SESSION_SECRET,
 * SYSTEM_TASK_SECRET and, with MCP on, MCP_ENCRYPTION_KEY) is
 * FLY_GENERATED_SECRETS in @propr/shared: a Fly dashboard launch generates the
 * same ones on first boot instead (src/flyLaunch/bootSecrets.ts).
 */

import { randomBytes } from "node:crypto";
import { FLY_GENERATED_SECRETS, FLY_USER_MANAGED_MCP_KEYS, flyMcpInstanceId } from "@propr/shared";
import type { FlyBrowserAuth } from "./flyBrowserAuth.js";
import type { FlyDeployPlan } from "./flyMachineConfig.js";

export const FLY_MCP_ENCRYPTION_KEY_SECRET = "MCP_ENCRYPTION_KEY";


export function generateFlySecrets(
  plan: Pick<FlyDeployPlan, "mcp">,
  random: (size: number) => Buffer = randomBytes,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const spec of FLY_GENERATED_SECRETS) {
    if (!spec.mcpOnly || plan.mcp) secrets[spec.name] = random(spec.bytes).toString(spec.encoding);
  }
  return secrets;
}

/**
 * Whether the deploy turns the ProPR MCP server on at https://<app>.fly.dev.
 * Automations and agents that use `propr_mcp` need it, and the stored
 * Settings toggle a fresh instance starts with is off. It stays off in demo
 * mode (MCP_ENABLED=true refuses to start there), and with the Connect tunnel,
 * where the API turns MCP on through Connect by itself. Any MCP_ENABLED,
 * MCP_PUBLIC_ORIGIN or MCP_INSTANCE_ID in the stack .env (MCP_ENABLED=false
 * turns it off) leaves MCP to that configuration.
 */
export function flyDeployEnablesMcp(secrets: Readonly<Record<string, string>>, browserAuth: FlyBrowserAuth): boolean {
  return browserAuth === "github" && !FLY_USER_MANAGED_MCP_KEYS.some((key) => key in secrets);
}

export { flyMcpInstanceId };
