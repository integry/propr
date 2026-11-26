/**
 * Secrets `propr deploy fly` generates, and the ProPR MCP defaults it turns on.
 *
 * Generated secrets are set only when the app does not already have them and
 * the stack .env (or the environment) does not supply them, so a redeploy
 * never rotates them (see runFlyDeploy):
 *
 * - SESSION_SECRET signs browser sessions.
 * - SYSTEM_TASK_SECRET signs system tasks (reverts) and the worker's requests
 *   for run-scoped ProPR MCP grants. Without it every automation, acting step
 *   and agent run that needs ProPR MCP is refused on the worker.
 * - MCP_ENCRYPTION_KEY seals the MCP server's records, only when the deploy
 *   turns MCP on (below).
 */

import { randomBytes } from "node:crypto";
import type { FlyBrowserAuth } from "./flyBrowserAuth.js";
import type { FlyDeployPlan } from "./flyMachineConfig.js";

export const FLY_MCP_ENCRYPTION_KEY_SECRET = "MCP_ENCRYPTION_KEY";

/** MCP settings that mean the stack .env manages ProPR MCP itself; the deploy then sets none of its defaults. */
const USER_MANAGED_MCP_KEYS = ["MCP_ENABLED", "MCP_PUBLIC_ORIGIN", "MCP_INSTANCE_ID"];

export function generateFlySecrets(
  plan: Pick<FlyDeployPlan, "mcp">,
  random: (size: number) => Buffer = randomBytes,
): Record<string, string> {
  const secrets: Record<string, string> = {
    SESSION_SECRET: random(32).toString("hex"),
    SYSTEM_TASK_SECRET: random(32).toString("hex"),
  };
  if (plan.mcp) secrets[FLY_MCP_ENCRYPTION_KEY_SECRET] = random(32).toString("base64");
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
  return browserAuth === "github" && !USER_MANAGED_MCP_KEYS.some((key) => key in secrets);
}

/** MCP_INSTANCE_ID must be 8–128 characters; Fly app names can be as short as 2. Stable across redeploys. */
export function flyMcpInstanceId(app: string): string {
  return `propr-fly-${app}`;
}
