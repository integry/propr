import type { AgentConfig, AgentType } from '../types.js';
import { parseJsonc } from '../../utils/jsonUtils.js';
import { openCodeEnvVarRejection } from '../impl/openCodeEnvForwarding.js';
import { getMistralApiKeyFromSettings } from '../impl/utils/vibeAgentHelpers.js';
import { parseDotenv } from './dotenv.js';
import type { CredentialFileReader } from './pastedCredentials.js';
import { providerCredentialManifest } from './providerManifests.js';

/** OpenCode config files (manifest `config` entries) whose `provider.<id>.options.apiKey` authenticates that provider. */
const OPENCODE_CONFIG_FILES = ['opencode.json', 'opencode.jsonc', 'config.json'] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a secret environment file the manifest declares (Vibe's `.env`) sets
 * one of the provider's API-key variables: the broker extracts exactly these
 * and supplies them to the run as secret variables.
 */
function secretEnvFileKeyPresent(provider: AgentType, read: CredentialFileReader): boolean {
    return (['config', 'data'] as const).some(store => {
        const manifest = providerCredentialManifest(provider, store);
        const apiKeyEnv = new Set(manifest?.apiKeyEnv ?? []);
        return (manifest?.secretEnvFiles ?? []).some(source => {
            const content = read(store, source.path);
            if (!content?.length) return false;
            const values = parseDotenv(content.toString('utf8'));
            return source.variables.some(name => apiKeyEnv.has(name) && Boolean(values.get(name)?.trim()));
        });
    });
}

/** Whether an OpenCode config file configures a provider with a nonempty `options.apiKey`. */
function openCodeConfigApiKeyPresent(read: CredentialFileReader): boolean {
    return OPENCODE_CONFIG_FILES.some(path => {
        const content = read('config', path);
        if (!content?.length) return false;
        let config: unknown;
        try { config = parseJsonc(content.toString('utf8')); }
        catch { return false; }
        const providers = isObject(config) && isObject(config.provider) ? Object.values(config.provider) : [];
        return providers.some(provider => isObject(provider) && isObject(provider.options)
            && typeof provider.options.apiKey === 'string' && provider.options.apiKey.trim().length > 0);
    });
}

/**
 * Whether the provider's stores hold a credential that is not a login file or
 * a pasted kind but that a run authenticates with: an API key in a manifest
 * secret environment file (Vibe's `.env`), or a provider API key in OpenCode's
 * config file.
 */
export function storedConfigCredentialPresent(provider: AgentType, read: CredentialFileReader): boolean {
    if (secretEnvFileKeyPresent(provider, read)) return true;
    return provider === 'opencode' && openCodeConfigApiKeyPresent(read);
}

/** Provider key variables OpenCode reads from its environment (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, ...). */
const OPENCODE_PROVIDER_KEY_ENV = /_(?:API_KEY|TOKEN)$/;

/**
 * Whether the run is given an API key from the agent configuration or the
 * ProPR environment rather than a credential store, as the agent's execution
 * resolves it: the manifest's API-key variables in the agent's env vars; for
 * Vibe also `MISTRAL_API_KEY` in the ProPR environment or the Mistral key
 * setting; for OpenCode any provider key variable among the agent env vars it
 * forwards to the run.
 */
export function environmentCredentialPresent(
    agent: Pick<AgentConfig, 'type' | 'envVars'>,
    options: { settings?: Record<string, unknown>; env?: NodeJS.ProcessEnv } = {},
): boolean {
    const envVars = agent.envVars ?? {};
    const apiKeyEnv = providerCredentialManifest(agent.type, 'config')?.apiKeyEnv ?? [];
    if (apiKeyEnv.some(name => envVars[name]?.trim())) return true;
    if (agent.type === 'vibe') {
        return Boolean((options.env ?? process.env).MISTRAL_API_KEY?.trim())
            || Boolean(options.settings && getMistralApiKeyFromSettings(options.settings));
    }
    if (agent.type === 'opencode') {
        return Object.entries(envVars).some(([name, value]) => OPENCODE_PROVIDER_KEY_ENV.test(name)
            && typeof value === 'string' && value.trim().length > 0 && openCodeEnvVarRejection(name, value) === null);
    }
    return false;
}
