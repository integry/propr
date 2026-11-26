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

/**
 * Reads token usage from the `export.json` Vibe 3 writes to `--output-dir` on every exit.
 * Unlike the session store, its location does not depend on the user's
 * `session_logging.save_dir`, which real configs set to an absolute host path.
 */
export function readVibeExportTokenUsage(runtimeHomePath: string): { input_tokens: number; output_tokens: number } | undefined {
    try {
        const exported = JSON.parse(fs.readFileSync(path.join(runtimeHomePath, VIBE_EXPORT_DIR_NAME, 'export.json'), 'utf8'));
        const usage = exported?.usage;
        if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined;
        return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    } catch {
        return undefined;
    }
}
