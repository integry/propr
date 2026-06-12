/**
 * Agent Tank API
 *
 * Agent Tank tracks LLM subscription usage. It is an external service (not a
 * stack container) — toggling it is a backend setting, so these helpers go
 * through the running ProPR API (`/api/config/agent-tank`).
 */

import { ApiClient, createApiClient } from "./index.js";

export interface AgentTankSettings {
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

/** Enable or disable Agent Tank usage tracking, optionally setting the URL. */
export async function setAgentTank(
  enabled: boolean,
  url?: string,
  client?: ApiClient
): Promise<AgentTankSettings> {
  const apiClient = client ?? (await createApiClient());

  // Preserve the existing URL when the caller doesn't pass one.
  let resolvedUrl = url;
  if (!resolvedUrl) {
    const current = await getAgentTank(apiClient);
    resolvedUrl = current.url || DEFAULT_AGENT_TANK_URL;
  }

  await apiClient.post("/api/config/agent-tank", { body: { enabled, url: resolvedUrl } });
  return { enabled, url: resolvedUrl };
}
