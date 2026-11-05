import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';
import type { AgentWatchdogSettings } from '../claude/docker/agentActivityWatchdog.js';
import { AGENT_WATCHDOG_SETTING_DEFINITIONS, parseNonNegativeInteger, resolveAgentWatchdogSettings, type AgentWatchdogSettingKey } from './agentWatchdogSettings.js';

export {
    AGENT_WATCHDOG_SETTING_DEFINITIONS,
    DEFAULT_AGENT_DEGENERATE_OUTPUT_LIMIT,
    DEFAULT_AGENT_STALL_TIMEOUT_MS,
    DEFAULT_AGENT_TOOL_STALL_TIMEOUT_MS,
    resolveAgentWatchdogEnvDefault,
    resolveAgentWatchdogSettings,
    type AgentWatchdogSettingKey,
} from './agentWatchdogSettings.js';

/** Raw stored overrides (null when unset), for the settings API. */
export async function loadAgentWatchdogOverrides(): Promise<Record<AgentWatchdogSettingKey, unknown>> {
    const values = await Promise.all(AGENT_WATCHDOG_SETTING_DEFINITIONS.map(definition => getConfig<unknown>(definition.key, null)));
    return Object.fromEntries(AGENT_WATCHDOG_SETTING_DEFINITIONS.map((definition, index) => [definition.key, values[index] ?? null])) as Record<AgentWatchdogSettingKey, unknown>;
}

/** Read for every agent run, so a Settings change applies to the next run without a restart. */
export async function loadAgentWatchdogSettings(): Promise<AgentWatchdogSettings> {
    return resolveAgentWatchdogSettings(await loadAgentWatchdogOverrides());
}

export async function saveAgentWatchdogSetting(key: AgentWatchdogSettingKey, value: number | null): Promise<boolean> {
    if (value !== null && parseNonNegativeInteger(value) === null) {
        throw new Error(`${key} must be a non-negative integer or null`);
    }
    await saveConfig(key, value);
    logger.info({ [key]: value }, 'Successfully saved agent watchdog setting');
    return true;
}
