/**
 * Agent Tank integration modes.
 *
 * `disabled` - no usage tracking at all (the default; nothing is contacted).
 * `bundled`  - ProPR runs the Agent Tank CLI inside the unified agent image.
 * `external` - ProPR talks HTTP to an Agent Tank instance the operator runs.
 */
export const AGENT_TANK_MODES = ['disabled', 'bundled', 'external'] as const;
export type AgentTankMode = typeof AGENT_TANK_MODES[number];

export const DEFAULT_AGENT_TANK_MODE: AgentTankMode = 'disabled';

/**
 * Coerce an unknown persisted/requested value into a valid mode.
 *
 * This is deliberately total (never throws): it is called on the read path for
 * configuration that may predate this feature, and a corrupt value must degrade
 * to "off" rather than break settings loading for the whole installation.
 */
export function normalizeAgentTankMode(value: unknown): AgentTankMode {
  return typeof value === 'string' && (AGENT_TANK_MODES as readonly string[]).includes(value)
    ? value as AgentTankMode
    : DEFAULT_AGENT_TANK_MODE;
}

/** True when `value` is already one of the three modes. */
export function isAgentTankMode(value: unknown): value is AgentTankMode {
  return typeof value === 'string' && (AGENT_TANK_MODES as readonly string[]).includes(value);
}

/**
 * Migrate the pre-mode persisted shape. Historically the only two states were
 * "off" and "talk HTTP to a host install", so a legacy `enabled: true` means
 * `external` and never `bundled` - we must not silently change what an existing
 * installation is pointed at.
 */
export function agentTankModeFromLegacyEnabled(enabled: unknown): AgentTankMode {
  return enabled === true ? 'external' : 'disabled';
}
