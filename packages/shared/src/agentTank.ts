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

/**
 * Build the body for `POST /api/config/agent-tank`.
 *
 * `enabled` travels next to `mode` on purpose. A backend that predates
 * integration modes reads only `{ enabled, url }`, so a mode-only body makes it
 * persist `enabled: false` and still answer `{ success: true }`: tracking is
 * switched off while the client reports the mode the operator picked. Current
 * backends treat `mode` as authoritative and ignore `enabled`, so one body is
 * correct against both.
 *
 * `bundled` has no legacy equivalent at all - callers must refuse it against a
 * pre-mode backend (see `supportsAgentTankModes`) instead of sending a body
 * that backend would reinterpret as "external, at whatever URL is saved".
 */
export function buildAgentTankSettingsRequest(
  mode: AgentTankMode,
  url?: string
): { mode: AgentTankMode; enabled: boolean; url?: string } {
  const enabled = mode !== 'disabled';
  return url === undefined ? { mode, enabled } : { mode, enabled, url };
}

/**
 * Whether the backend that produced this `/api/config/agent-tank` (or
 * `/detect`) response understands integration modes. A pre-mode backend answers
 * with no `mode` key at all, and cannot honor a `bundled` request.
 */
export function supportsAgentTankModes(response: unknown): boolean {
  return !!response
    && typeof response === 'object'
    && isAgentTankMode((response as { mode?: unknown }).mode);
}

/**
 * Shown instead of reporting a successful change when the operator asks for a
 * mode the connected backend cannot express.
 */
export const AGENT_TANK_LEGACY_BACKEND_MESSAGE =
  'This ProPR backend is too old to support bundled Agent Tank mode. '
  + 'Upgrade the backend, or choose external mode.';
