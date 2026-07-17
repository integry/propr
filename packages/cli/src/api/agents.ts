/**
 * Agents API
 *
 * Functions for interacting with the ProPR backend agent configuration endpoints.
 * These functions provide a typed interface to list, add, and delete agents.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ApiClient, createApiClient } from "./index.js";

/**
 * Agent type identifier.
 */
export type AgentType = "claude" | "codex" | "antigravity" | "opencode" | "vibe";

export const AGENT_TYPES: readonly AgentType[] = ["claude", "codex", "antigravity", "opencode", "vibe"] as const;

// Keep in sync with the core unified agent image name.
const AGENT_IMAGE_NAME = "propr/agent";

/**
 * Configuration for a specific agent instance.
 */
export interface AgentConfig {
  /**
   * Unique identifier (UUID v4).
   */
  id: string;

  /**
   * The agent type (claude, codex, antigravity, opencode, or vibe).
   */
  type: AgentType;

  /**
   * Human-readable alias (e.g., 'claude-prod', 'codex-beta').
   */
  alias: string;

  /**
   * Whether the agent is enabled.
   */
  enabled: boolean;

  /**
   * Docker image for the agent (e.g., 'propr/agent:latest').
   */
  dockerImage: string;

  /**
   * Host path to mount for configuration.
   */
  configPath: string;

  /**
   * List of models this agent supports.
   */
  supportedModels: string[];

  /**
   * Default model if none specified.
   */
  defaultModel?: string;

  /**
   * Environment variables to inject into container.
   */
  envVars?: Record<string, string>;

  /**
   * Custom GitHub labels per model.
   */
  modelCustomLabels?: Record<string, string>;
}

/**
 * Response from the get agents endpoint.
 */
export interface GetAgentsResponse {
  /**
   * Array of agent configurations.
   */
  agents: AgentConfig[];
}

/**
 * Options for adding a new agent.
 */
export interface AddAgentOptions {
  /**
   * Human-readable alias for the agent.
   */
  alias: string;

  /**
   * The agent type (claude, codex, antigravity, opencode, or vibe).
   */
  type: AgentType;

  /**
   * List of models this agent supports.
   */
  models: string[];

  /**
   * Default model to use.
   */
  defaultModel?: string;

  /**
   * Docker image for the agent.
   */
  dockerImage?: string;

  /**
   * Host path to mount for configuration.
   */
  configPath?: string;

  /**
   * Whether the agent is enabled.
   */
  enabled?: boolean;
}

/**
 * Response from save agents endpoint.
 */
export interface SaveAgentsResponse {
  /**
   * Whether the operation was successful.
   */
  success: boolean;

  /**
   * The updated agents array.
   */
  agents: AgentConfig[];
}

/**
 * Lists all configured agents.
 *
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of agent configurations.
 *
 * @example
 * ```typescript
 * // List all agents
 * const result = await listAgents();
 * console.log(`Found ${result.agents.length} agents`);
 * ```
 */
export async function listAgents(client?: ApiClient): Promise<GetAgentsResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.get<GetAgentsResponse>("/api/config/agents");

  return response.data;
}

/**
 * Adds a new agent configuration.
 *
 * This function first fetches the existing agents, adds the new one,
 * and then saves the updated list.
 *
 * @param options - Options for the new agent.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the save response.
 *
 * @example
 * ```typescript
 * // Add a new Claude agent
 * const result = await addAgent({
 *   alias: 'claude-prod',
 *   type: 'claude',
 *   models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514']
 * });
 * ```
 */
export async function addAgent(
  options: AddAgentOptions,
  client?: ApiClient
): Promise<SaveAgentsResponse> {
  const apiClient = client ?? (await createApiClient());

  // Fetch existing agents
  const existingResponse = await apiClient.get<GetAgentsResponse>("/api/config/agents");
  const existingAgents = existingResponse.data.agents || [];

  // Check if alias already exists
  const aliasExists = existingAgents.some(
    (agent) => agent.alias.toLowerCase() === options.alias.toLowerCase()
  );
  if (aliasExists) {
    throw new Error(`Agent with alias '${options.alias}' already exists`);
  }

  const configPath = options.configPath || resolveDefaultConfigPath(options.type, apiClient);

  // Create new agent config
  const newAgent: AgentConfig = {
    id: crypto.randomUUID(),
    type: options.type,
    alias: options.alias,
    enabled: options.enabled !== undefined ? options.enabled : true,
    dockerImage: options.dockerImage || getDefaultDockerImage(options.type),
    configPath,
    supportedModels: options.models,
    defaultModel: options.defaultModel || options.models[0],
  };

  // Add new agent to the list
  const updatedAgents = [...existingAgents, newAgent];

  // Save the updated list
  const response = await apiClient.post<SaveAgentsResponse>("/api/config/agents", {
    body: { agents: updatedAgents },
  });

  return response.data;
}

/**
 * Deletes an agent by alias.
 *
 * @param alias - The alias of the agent to delete.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the save response.
 *
 * @example
 * ```typescript
 * // Delete an agent
 * await deleteAgent('claude-prod');
 * ```
 */
export async function deleteAgent(
  alias: string,
  client?: ApiClient
): Promise<SaveAgentsResponse> {
  const apiClient = client ?? (await createApiClient());

  // Fetch existing agents
  const existingResponse = await apiClient.get<GetAgentsResponse>("/api/config/agents");
  const existingAgents = existingResponse.data.agents || [];

  // Find the agent to delete
  const agentIndex = existingAgents.findIndex(
    (agent) => agent.alias.toLowerCase() === alias.toLowerCase()
  );

  if (agentIndex === -1) {
    throw new Error(`Agent with alias '${alias}' not found`);
  }

  // Remove the agent
  const updatedAgents = existingAgents.filter(
    (_, index) => index !== agentIndex
  );

  // Save the updated list
  const response = await apiClient.post<SaveAgentsResponse>("/api/config/agents", {
    body: { agents: updatedAgents },
  });

  return response.data;
}

/**
 * Enables or disables an agent by alias.
 *
 * Fetches the full agents array, flips the `enabled` flag on the matching entry,
 * and saves it back (full-array replace, matching the web UI). Requires the
 * backend API to be reachable (i.e. the stack is running).
 *
 * @param alias - The alias of the agent to toggle.
 * @param enabled - The desired enabled state.
 * @param client - Optional ApiClient instance.
 * @returns A promise resolving to the save response.
 */
export async function setAgentEnabled(
  alias: string,
  enabled: boolean,
  client?: ApiClient
): Promise<SaveAgentsResponse> {
  const apiClient = client ?? (await createApiClient());

  const existingResponse = await apiClient.get<GetAgentsResponse>("/api/config/agents");
  const existingAgents = existingResponse.data.agents || [];

  const target = existingAgents.find(
    (agent) => agent.alias.toLowerCase() === alias.toLowerCase()
  );
  if (!target) {
    throw new Error(`Agent with alias '${alias}' not found`);
  }

  const updatedAgents = existingAgents.map((agent) =>
    agent === target ? { ...agent, enabled } : agent
  );

  // Full-array replace can overwrite concurrent web/CLI edits until the API
  // exposes a per-agent PATCH endpoint.
  const response = await apiClient.post<SaveAgentsResponse>("/api/config/agents", {
    body: { agents: updatedAgents },
  });

  return response.data;
}

/**
 * Gets the default Docker image for an agent type.
 *
 * @param type - The agent type.
 * @returns The default Docker image name.
 */
function getDefaultDockerImage(type: AgentType): string {
  void type;
  return `${AGENT_IMAGE_NAME}:latest`;
}

/**
 * Gets the default config path for an agent type.
 *
 * Returns a path under the local user's home directory. This is correct for
 * Docker-outside-Docker setups where the CLI and server share the same host,
 * but will produce an incorrect path if the CLI talks to a remote ProPR
 * server. In remote setups, always pass an explicit `configPath` instead.
 *
 * @param type - The agent type.
 * @returns The default config path.
 */
function getDefaultConfigPath(type: AgentType): string {
  const home = homedir();
  switch (type) {
    case "claude":
      return join(home, ".claude");
    case "codex":
      return join(home, ".codex");
    case "antigravity":
      return join(home, ".gemini");
    case "opencode":
      return join(home, ".config", "opencode");
    case "vibe":
      return join(home, ".vibe");
    default:
      return join(home, `.${type}`);
  }
}

function isRemoteApiUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1";
  } catch {
    return false;
  }
}

function resolveDefaultConfigPath(type: AgentType, client: ApiClient): string {
  const baseUrl = typeof client.getBaseUrl === "function" ? client.getBaseUrl() : "http://localhost";
  if (isRemoteApiUrl(baseUrl)) {
    throw new Error(
      `Cannot infer config path for a remote ProPR server (${baseUrl}). ` +
      `Pass --config-path explicitly with the host path on the server ` +
      `(e.g. --config-path /home/propr/.${type}).`
    );
  }
  return getDefaultConfigPath(type);
}
