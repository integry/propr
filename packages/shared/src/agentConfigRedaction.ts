/**
 * Output-boundary redaction for agent configuration.
 *
 * Agent `envVars` values are provider credentials and other opaque runtime
 * settings. Administrative responses (REST, CLI JSON and text) expose only the
 * configured variable names; every value is replaced by one fixed marker so no
 * prefix, length, hash or encoding of the secret is observable. Runtime code
 * keeps reading the stored configuration directly and is unaffected.
 *
 * Clients that read-modify-write the full agent list send the marker back for
 * unchanged values; {@link restoreRedactedAgentEnvVars} swaps it for the stored
 * value of the same agent id before persistence.
 */

export const REDACTED_AGENT_ENV_VALUE = '[REDACTED]';

interface AgentEnvVarsCarrier {
  id?: unknown;
  envVars?: unknown;
}

function isEnvVarRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns a copy of the agent whose `envVars` keep their names but never their values. */
export function redactAgentConfigSecrets<T extends AgentEnvVarsCarrier>(agent: T): T {
  if (!isEnvVarRecord(agent) || agent.envVars === undefined) return agent;
  const envVars = isEnvVarRecord(agent.envVars)
    ? Object.fromEntries(Object.keys(agent.envVars).map(name => [name, REDACTED_AGENT_ENV_VALUE]))
    : {};
  return { ...agent, envVars };
}

export function redactAgentConfigsSecrets<T extends AgentEnvVarsCarrier>(agents: readonly T[]): T[] {
  return agents.map(agent => redactAgentConfigSecrets(agent));
}

/**
 * Replaces redaction markers in incoming agents with the stored value of the
 * same variable on the same agent id. A marker with no stored counterpart
 * cannot be resolved and is reported as an error instead of being persisted.
 */
export function restoreRedactedAgentEnvVars<T extends AgentEnvVarsCarrier>(
  incoming: readonly T[],
  stored: readonly AgentEnvVarsCarrier[],
): { agents: T[]; error?: undefined } | { agents?: undefined; error: string } {
  const storedById = new Map(stored.filter(agent => typeof agent?.id === 'string').map(agent => [agent.id as string, agent]));
  const agents: T[] = [];
  for (const agent of incoming) {
    if (!isEnvVarRecord(agent) || !isEnvVarRecord(agent.envVars)) {
      agents.push(agent);
      continue;
    }
    const storedEnv = typeof agent.id === 'string' ? storedById.get(agent.id)?.envVars : undefined;
    const envVars: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(agent.envVars)) {
      if (value !== REDACTED_AGENT_ENV_VALUE) {
        envVars[name] = value;
        continue;
      }
      if (!isEnvVarRecord(storedEnv) || typeof storedEnv[name] !== 'string') {
        return { error: `Agent '${String(agent.id)}' environment variable '${name}' is redacted and has no stored value to keep. Provide the value again.` };
      }
      envVars[name] = storedEnv[name];
    }
    agents.push({ ...agent, envVars });
  }
  return { agents };
}
