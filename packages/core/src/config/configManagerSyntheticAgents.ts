import type { Knex } from 'knex';
import {
    parseSyntheticAgentConfigs,
    type SyntheticAgentConfig,
} from '@propr/shared';
import { getConfig, getConfigWithClient, saveConfig } from './configStore.js';

export const SYNTHETIC_AGENTS_CONFIG_KEY = 'synthetic_agents';
const DEFAULT_SYNTHETIC_AGENTS: SyntheticAgentConfig[] = [];

export async function loadSyntheticAgents(
    client?: Knex | Knex.Transaction,
): Promise<SyntheticAgentConfig[]> {
    const value = client
        ? await getConfigWithClient<unknown>(
            SYNTHETIC_AGENTS_CONFIG_KEY,
            DEFAULT_SYNTHETIC_AGENTS,
            client,
        )
        : await getConfig<unknown>(
            SYNTHETIC_AGENTS_CONFIG_KEY,
            DEFAULT_SYNTHETIC_AGENTS,
        );

    return parseSyntheticAgentConfigs(value);
}

export async function saveSyntheticAgents(
    value: unknown,
    client?: Knex | Knex.Transaction,
): Promise<SyntheticAgentConfig[]> {
    const normalized = parseSyntheticAgentConfigs(value);
    await saveConfig(SYNTHETIC_AGENTS_CONFIG_KEY, normalized, client);
    return normalized;
}
