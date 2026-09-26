/**
 * Agent Tank API
 *
 * Agent Tank tracks LLM subscription usage. It is a backend setting rather than
 * a stack container — in `bundled` mode ProPR runs the Agent Tank CLI inside the
 * agent image, and in `external` mode it talks to an instance the operator runs
 * — so these helpers go through the running ProPR API
 * (`/api/config/agent-tank`).
 */

import { ApiClient, createApiClient } from "./index.js";
import type { AgentTankMode } from "@propr/shared";

export interface AgentTankSettings {
  mode: AgentTankMode;
  enabled: boolean;
  url?: string;
}

const DEFAULT_AGENT_TANK_URL = "http://127.0.0.1:3456";

/** Fetch the current Agent Tank settings. */
export async function getAgentTank(client?: ApiClient): Promise<AgentTankSettings> {
  const apiClient = client ?? (await createApiClient());
  const response = await apiClient.get<AgentTankSettings>("/api/config/agent-tank");
  return response.data;
}

/** Set the Agent Tank integration mode, optionally setting the external URL. */
export async function setAgentTank(
  mode: AgentTankMode,
  url?: string,
  client?: ApiClient
): Promise<AgentTankSettings> {
  const apiClient = client ?? (await createApiClient());

  // Preserve the existing URL when the caller doesn't pass one, so switching to
  // bundled and back to external does not lose a hand-tuned endpoint.
  let resolvedUrl = url;
  if (!resolvedUrl) {
    const current = await getAgentTank(apiClient);
    resolvedUrl = current.url || DEFAULT_AGENT_TANK_URL;
  }

  await apiClient.post("/api/config/agent-tank", { body: { mode, url: resolvedUrl } });
  return { mode, enabled: mode !== "disabled", url: resolvedUrl };
}
