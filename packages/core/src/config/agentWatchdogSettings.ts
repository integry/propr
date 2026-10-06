import logger from '../utils/logger.js';
import type { AgentWatchdogSettings } from '../claude/docker/agentActivityWatchdog.js';

// --- Agent stall and degenerate-output watchdog ---

export const DEFAULT_AGENT_STALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_AGENT_TOOL_STALL_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_AGENT_DEGENERATE_OUTPUT_LIMIT = 50;

interface WatchdogSettingDefinition {
    key: 'agent_stall_timeout_ms' | 'agent_tool_stall_timeout_ms' | 'agent_degenerate_output_limit';
    env: string;
    defaultValue: number;
    field: keyof AgentWatchdogSettings;
}

export const AGENT_WATCHDOG_SETTING_DEFINITIONS: readonly WatchdogSettingDefinition[] = [
    { key: 'agent_stall_timeout_ms', env: 'AGENT_STALL_TIMEOUT_MS', defaultValue: DEFAULT_AGENT_STALL_TIMEOUT_MS, field: 'stallTimeoutMs' },
    { key: 'agent_tool_stall_timeout_ms', env: 'AGENT_TOOL_STALL_TIMEOUT_MS', defaultValue: DEFAULT_AGENT_TOOL_STALL_TIMEOUT_MS, field: 'toolStallTimeoutMs' },
    { key: 'agent_degenerate_output_limit', env: 'AGENT_DEGENERATE_OUTPUT_LIMIT', defaultValue: DEFAULT_AGENT_DEGENERATE_OUTPUT_LIMIT, field: 'degenerateOutputLimit' },
];

export type AgentWatchdogSettingKey = WatchdogSettingDefinition['key'];

export function parseNonNegativeInteger(value: unknown): number | null {
    const candidate = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

/** The environment value, or the built-in default when unset or invalid. */
export function resolveAgentWatchdogEnvDefault(definition: WatchdogSettingDefinition, env: NodeJS.ProcessEnv = process.env): number {
    const raw = env[definition.env];
    if (raw === undefined || raw.trim() === '') return definition.defaultValue;
    const parsed = parseNonNegativeInteger(raw);
    if (parsed === null) {
        logger.warn({ env: definition.env, value: raw, defaultValue: definition.defaultValue }, 'Invalid agent watchdog environment value, using default');
        return definition.defaultValue;
    }
    return parsed;
}

/**
 * Environment values are the defaults; a stored instance setting overrides
 * them when set. `null` (or no row) means "use the environment". Invalid
 * stored values fall back to the default with a warning.
 */
export function resolveAgentWatchdogSettings(
    stored: Partial<Record<AgentWatchdogSettingKey, unknown>>,
    env: NodeJS.ProcessEnv = process.env,
): AgentWatchdogSettings {
    const settings = {} as AgentWatchdogSettings;
    for (const definition of AGENT_WATCHDOG_SETTING_DEFINITIONS) {
        const envDefault = resolveAgentWatchdogEnvDefault(definition, env);
        const value = stored[definition.key];
        if (value === undefined || value === null) {
            settings[definition.field] = envDefault;
            continue;
        }
        const parsed = parseNonNegativeInteger(value);
        if (parsed === null) {
            logger.warn({ setting: definition.key, stored_value: value, defaultValue: envDefault }, 'Invalid agent watchdog setting in DB, using default');
            settings[definition.field] = envDefault;
            continue;
        }
        settings[definition.field] = parsed;
    }
    return settings;
}
