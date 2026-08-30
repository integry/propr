/** Typed helpers for the synthetic-agent configuration endpoint. */

import type { SyntheticAgentConfig } from "@propr/shared";
import { ApiClient, createApiClient } from "./client.js";

export interface SyntheticAgentsResponse {
  synthetic_agents: SyntheticAgentConfig[];
}

export interface SaveSyntheticAgentsResponse extends SyntheticAgentsResponse {
  success: boolean;
  warnings?: string[];
  committed?: boolean;
}

/** Lists the complete synthetic configuration document. */
export async function listSyntheticAgents(
  client?: ApiClient
): Promise<SyntheticAgentsResponse> {
  const apiClient = client ?? (await createApiClient());
  return (await apiClient.get<SyntheticAgentsResponse>(
    "/api/config/synthetic-agents"
  )).data;
}

/** Replaces the complete synthetic configuration document. */
export async function saveSyntheticAgents(
  syntheticAgents: SyntheticAgentConfig[],
  client?: ApiClient
): Promise<SaveSyntheticAgentsResponse> {
  const apiClient = client ?? (await createApiClient());
  return (await apiClient.post<SaveSyntheticAgentsResponse>(
    "/api/config/synthetic-agents",
    { body: { synthetic_agents: syntheticAgents } }
  )).data;
}

/** Deletes one synthetic agent by its stable ID or alias. */
export async function deleteSyntheticAgent(
  idOrAlias: string,
  client?: ApiClient
): Promise<SaveSyntheticAgentsResponse> {
  const apiClient = client ?? (await createApiClient());
  const current = await listSyntheticAgents(apiClient);
  const match = current.synthetic_agents.find(
    (pool) => pool.id === idOrAlias || pool.alias === idOrAlias
  );
  if (!match) throw new Error(`Synthetic pool '${idOrAlias}' not found`);
  return saveSyntheticAgents(
    current.synthetic_agents.filter((pool) => pool.id !== match.id),
    apiClient
  );
}
