/**
 * Agents API
 *
 * Functions for interacting with the ProPR backend agent configuration endpoints.
 * These functions provide a typed interface to list, add, and delete agents.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * Agent type identifier.
 */
export const AGENT_TYPES = ["claude", "codex", "gemini", "opencode"] as const;
export type AgentType = typeof AGENT_TYPES[number];

const DEFAULT_DOCKER_IMAGES: Record<AgentType, string> = {
  claude: "propr/agent-claude:latest",
  codex: "propr/agent-codex:latest",
  gemini: "propr/agent-gemini:latest",
  opencode: "propr/agent-opencode:latest",
};

/**
 * Configuration for a specific agent instance.
 */
export interface AgentConfig {
  /**
   * Unique identifier (UUID v4).
   */
  id: string;

  /**
   * The agent type.
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
   * Docker image for the agent (e.g., 'propr/agent-claude:latest').
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
   * The agent type.
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

  // Create new agent config
  const newAgent: AgentConfig = {
    id: crypto.randomUUID(),
    type: options.type,
    alias: options.alias,
    enabled: options.enabled !== undefined ? options.enabled : true,
    dockerImage: options.dockerImage || getDefaultDockerImage(options.type),
    configPath: options.configPath || getDefaultConfigPath(options.type),
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
 * Gets the default Docker image for an agent type.
 *
 * @param type - The agent type.
 * @returns The default Docker image name.
 */
function getDefaultDockerImage(type: AgentType): string {
  return DEFAULT_DOCKER_IMAGES[type];
}

/**
 * Gets the default config path for an agent type.
 *
 * @param type - The agent type.
 * @returns The default config path.
 */
function getDefaultConfigPath(type: AgentType): string {
  switch (type) {
    case "claude":
      return "/root/.claude";
    case "codex":
      return "/root/.codex";
    case "gemini":
      return "/root/.gemini";
    case "opencode":
      return "/root/.config/opencode";
    default:
      return `/root/.${type}`;
  }
}
