import logger from '../utils/logger.js';
import { retryOnSqliteContention, type SqliteRetryOptions } from '../db/sqliteRetry.js';
import { getConfigStrict, saveConfig } from './configStore.js';
import {
    AGENT_NETWORK_SETTING_KEYS,
    resolveInstanceNetworkPolicy,
    validateAgentNetworkSetting,
    type AgentNetworkSettingKey,
    type InstanceNetworkPolicy,
} from '../network/networkPolicy.js';

/** Raw stored overrides (null when unset), for the settings API. */
export async function loadAgentNetworkOverrides(): Promise<Record<AgentNetworkSettingKey, unknown>> {
    const values = await Promise.all(AGENT_NETWORK_SETTING_KEYS.map(key => getConfigStrict<unknown>(key, null)));
    return Object.fromEntries(AGENT_NETWORK_SETTING_KEYS.map((key, index) => [key, values[index] ?? null])) as Record<AgentNetworkSettingKey, unknown>;
}

/**
 * Read for every run, so a Settings change applies to the next run without a
 * restart. Strict: an unreadable policy must not silently open the network.
 * A briefly locked database is retried (all four reads together, within one
 * bounded budget) rather than failing the run; any other error, or contention
 * that outlasts the budget, still fails it.
 */
export async function loadInstanceNetworkPolicy(
    seams: { read?: typeof loadAgentNetworkOverrides; retry?: SqliteRetryOptions } = {},
): Promise<InstanceNetworkPolicy> {
    const read = seams.read ?? loadAgentNetworkOverrides;
    const overrides = await retryOnSqliteContention(read, { operation: 'load instance network policy', sharesBudget: true }, seams.retry);
    return resolveInstanceNetworkPolicy(overrides);
}

export async function saveAgentNetworkSetting(key: AgentNetworkSettingKey, value: unknown): Promise<boolean> {
    const error = validateAgentNetworkSetting(key, value);
    if (error) throw new Error(error);
    const normalized = key === 'agent_network_mode' && typeof value === 'string' ? value.trim().toLowerCase()
        : key === 'agent_network_allow' && Array.isArray(value) ? [...new Set(value.map(entry => String(entry).trim().toLowerCase()))]
        : value;
    await saveConfig(key, normalized);
    logger.info({ [key]: normalized }, 'Successfully saved agent network setting');
    return true;
}
