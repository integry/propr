import fs from 'fs';
import path from 'path';

/** Container mount point of the per-run Vibe runtime home. */
export const VIBE_CONTAINER_RUNTIME_HOME = '/tmp/propr-vibe-home';
/** Runtime-home subdirectory Vibe 3 writes `export.json` to via `--output-dir`. */
export const VIBE_EXPORT_DIR_NAME = 'propr-export';

/**
 * Vibe 3 prints no token counts, so ask it to write `export.json` into the runtime
 * home mount, whatever `session_logging.save_dir` says. A caller-supplied
 * `--output-dir` (VIBE_CLI_ARGS) is left alone; usage then falls back to the session store.
 */
export function appendVibeExportDirArg(cliArgs: string[], enabled: boolean): void {
    if (!enabled || cliArgs.some(arg => arg === '--output-dir' || arg.startsWith('--output-dir='))) return;
    cliArgs.push('--output-dir', `${VIBE_CONTAINER_RUNTIME_HOME}/${VIBE_EXPORT_DIR_NAME}`);
}

export interface VibeTokenUsage { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }

/**
 * Converts Vibe 3 usage into ProPR's shape. Vibe's input count is the provider's
 * `prompt_tokens`, and its cached count is a subset of that: the harness rejects
 * `cached_input_tokens > input_tokens` and checks `total_tokens = input + output`.
 * ProPR's `input_tokens` means uncached input, so the cached part is moved to
 * `cache_read_input_tokens`. That way it is billed once, at the cached rate. When
 * the cached count is missing it stays unset: unknown, not a measured zero.
 */
export function splitVibeTokenUsage(inputTokens: unknown, outputTokens: unknown, cachedInputTokens: unknown): VibeTokenUsage | undefined {
    if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined;
    if (typeof cachedInputTokens !== 'number') return { input_tokens: inputTokens, output_tokens: outputTokens };
    const cached = Math.min(Math.max(0, cachedInputTokens), Math.max(0, inputTokens));
    return { input_tokens: inputTokens - cached, output_tokens: outputTokens, cache_read_input_tokens: cached };
}

/**
 * Reads token usage from the `export.json` Vibe 3 writes to `--output-dir` on every exit.
 * Unlike the session store, its location does not depend on the user's
 * `session_logging.save_dir`, which real configs set to an absolute host path.
 */
export function readVibeExportTokenUsage(runtimeHomePath: string): VibeTokenUsage | undefined {
    try {
        const exported = JSON.parse(fs.readFileSync(path.join(runtimeHomePath, VIBE_EXPORT_DIR_NAME, 'export.json'), 'utf8'));
        const usage = exported?.usage;
        return splitVibeTokenUsage(usage?.input_tokens, usage?.output_tokens, usage?.cached_input_tokens);
    } catch {
        return undefined;
    }
}
