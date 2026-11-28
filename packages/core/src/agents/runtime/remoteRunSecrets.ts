import { parseJsonc } from '../../utils/jsonUtils.js';
import { parseDotenv } from '../credentials/dotenv.js';
import type { CredentialStoreBundle } from '../credentials/broker.js';
import { providerCredentialManifest } from '../credentials/providerManifests.js';
import { PROPR_MCP_BEARER_TOKEN_ENV } from '../agentToolPolicy.js';
import type { AgentType } from '../types.js';

/**
 * The secret values a remote run (Fly Machines, Sprites) redacts from its
 * output: the credential strings in the agent configuration's store files,
 * the variables the broker extracted from a store's secret file (Vibe's
 * `MISTRAL_API_KEY`) and credential-shaped variables of the run.
 */

/** Credential-shaped JSON keys (Claude, Codex and OpenCode logins) whose values are redacted from the output. */
export const CREDENTIAL_KEY = /^(?:(?:access|refresh|id|auth)_?)?token$|^(?:openai_)?api_?key$|^(?:access|refresh|key)$/i;
/** Environment names that carry a provider credential (OpenCode reads its provider keys from these, Vibe from its `.env`). */
export const CREDENTIAL_ENV = /(?:API_?KEY|TOKEN|SECRET|PASSWORD)$/i;
/** Shorter values are not redacted: they would mangle ordinary output. */
const MIN_SECRET_LENGTH = 12;

/**
 * The credential strings in one store file. JSON and JSONC (OpenCode's
 * opencode.jsonc may carry comments and trailing commas around a provider
 * apiKey) by key; anything else as dotenv (`KEY=value`, Vibe's `.env`).
 * A refreshed token file that is neither is redacted whole.
 */
export function storeFileSecrets(content: Buffer | string, refresh = false): string[] {
    const text = content.toString();
    const secrets: string[] = [];
    try {
        parseJsonc(text, (key, value) => {
            if (typeof value === 'string' && CREDENTIAL_KEY.test(key)) secrets.push(value);
            return value;
        });
        return secrets;
    } catch { /* not JSON: read it as dotenv */ }
    for (const [key, value] of parseDotenv(text)) {
        if (CREDENTIAL_ENV.test(key) || CREDENTIAL_KEY.test(key)) secrets.push(value);
    }
    if (refresh) secrets.push(text.trim());
    return secrets;
}

/** Every store file's credential strings. */
export function credentialStoreSecrets(stores: readonly CredentialStoreBundle[]): string[] {
    return stores.flatMap(store => store.files.flatMap(file => storeFileSecrets(file.content, file.refresh)));
}

/** The run's credential variable names: the provider's API-key variables, GitHub and MCP tokens, and credential-shaped names. */
export function credentialEnvNames(provider: AgentType, env: ReadonlyMap<string, string>): string[] {
    return [...providerCredentialManifest(provider, 'config')?.apiKeyEnv ?? [], 'OPENAI_API_KEY',
        'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ACCESS_TOKEN', PROPR_MCP_BEARER_TOKEN_ENV,
        ...[...env.keys()].filter(name => CREDENTIAL_ENV.test(name))];
}

/** The values worth redacting: nonempty, long enough not to mangle ordinary output, deduplicated. */
export function redactableSecrets(values: Iterable<string | undefined>): string[] {
    return [...new Set([...values].filter((v): v is string => v !== undefined && v.length >= MIN_SECRET_LENGTH))];
}
