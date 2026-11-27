/**
 * Secrets `propr deploy fly` generates on a first deploy (FLY_GENERATED_SECRETS
 * in @propr/shared), generated on first boot instead when the Machine was
 * launched from the Fly dashboard (#3827), which cannot run the CLI.
 *
 * - A value already in the environment (a Fly secret) wins. It is neither
 *   stored nor replaced, so an instance whose secrets were set with
 *   `fly secrets set` or `propr deploy fly` behaves exactly as before.
 * - Otherwise the value stored on the volume is used.
 * - Otherwise one is generated, stored with mode 0600 and used from then on:
 *   restarts and idle stops followed by a wake keep the same secrets.
 *
 * Only names are ever reported, never values.
 */
import { randomBytes } from 'node:crypto';
import { FLY_GENERATED_SECRETS, FLY_USER_MANAGED_MCP_KEYS } from '@propr/shared';
import type { LaunchStore } from './launchStore.js';

export const BOOT_SECRETS_FILE = 'secrets.json';

export interface BootSecretsResult {
    /** Names taken from the environment (Fly secrets). */
    fromEnvironment: string[];
    /** Names read from the volume. */
    fromVolume: string[];
    /** Names generated on this boot and stored on the volume. */
    generated: string[];
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Whether the launch turns ProPR MCP on: the same rule as `flyDeployEnablesMcp` (the operator sets no MCP setting). */
export function flyLaunchEnablesMcp(env: NodeJS.ProcessEnv): boolean {
    return !FLY_USER_MANAGED_MCP_KEYS.some(key => key in env);
}

export function ensureBootSecrets(
    env: NodeJS.ProcessEnv,
    store: LaunchStore,
    random: (size: number) => Buffer = randomBytes,
): BootSecretsResult {
    const stored = store.readJson<Record<string, unknown>>(BOOT_SECRETS_FILE) ?? {};
    const mcp = flyLaunchEnablesMcp(env);
    const result: BootSecretsResult = { fromEnvironment: [], fromVolume: [], generated: [] };
    const next: Record<string, string> = {};
    for (const [name, value] of Object.entries(stored)) if (typeof value === 'string' && present(value)) next[name] = value;
    let changed = false;
    for (const spec of FLY_GENERATED_SECRETS) {
        if (present(env[spec.name])) {
            result.fromEnvironment.push(spec.name);
            continue;
        }
        const kept = next[spec.name];
        if (kept) {
            env[spec.name] = kept;
            result.fromVolume.push(spec.name);
            continue;
        }
        if (spec.mcpOnly && !mcp) continue;
        const value = random(spec.bytes).toString(spec.encoding);
        next[spec.name] = value;
        env[spec.name] = value;
        result.generated.push(spec.name);
        changed = true;
    }
    if (changed) store.writeJson(BOOT_SECRETS_FILE, next);
    return result;
}
