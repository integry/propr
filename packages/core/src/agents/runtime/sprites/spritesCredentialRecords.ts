import path from 'node:path';
import type { AgentType } from '../../types.js';

/**
 * Where credentials live on a Sprite, and the launcher manifest records that
 * return a run's refreshed tokens from there (see `SPRITES_LAUNCHER_SCRIPT`).
 */

export const SPRITES_AGENT_HOME = '/home/node';

/** Antigravity's disposable HOME (`scripts/antigravity-entrypoint.sh`), which holds the run's OAuth token copy. */
export const SPRITES_ANTIGRAVITY_HOME = '/tmp/propr-antigravity-home';

/**
 * Where a provider's entrypoint keeps the run's live copy of its credential
 * store, when that is not the store's own target: Antigravity copies the token
 * into its disposable HOME, the CLI refreshes it there, and only the
 * entrypoint's exit syncs it back to the store. A run killed before that sync
 * holds its only current token in the live copy, so the launcher returns that
 * one when present (see {@link spritesOutputRecord}).
 */
export const SPRITES_LIVE_CREDENTIAL_ROOTS: Readonly<Partial<Record<AgentType, string>>> = Object.freeze({
    antigravity: `${SPRITES_ANTIGRAVITY_HOME}/.gemini`,
});

/** A target the run may use on a Sprite: below the agent home, `/tmp/` or `/run/propr-`, never the workspace itself. */
export function isSafeSpritesTarget(target: string): boolean {
    const normalized = path.posix.normalize(target);
    if (normalized !== target || !path.posix.isAbsolute(target) || target.endsWith('/')) return false;
    return [`${SPRITES_AGENT_HOME}/`, '/tmp/', '/run/propr-'].some(prefix => target.startsWith(prefix) && target.length > prefix.length)
        && target !== `${SPRITES_AGENT_HOME}/workspace`;
}

/**
 * Directories above every Sprite target that the agent user cannot replace:
 * its home (in root-owned `/home`), `/tmp` and `/run` themselves.
 */
const SPRITES_TARGET_BOUNDARIES: readonly string[] = [SPRITES_AGENT_HOME, '/tmp', '/run'];

/**
 * The `output` record of a refreshable credential installed at `target`: the
 * launcher returns `<target>/<output>` only when every component below the
 * target's boundary (the store's own directory and every ancestor the agent
 * user could have replaced, e.g. `/home/node/.codex`) is a real directory and
 * the file a regular file, so a symlink the agent planted never makes root
 * export a file from outside the run's store.
 */
export function spritesOutputRecord(target: string, output: string, returned: string): string[] {
    return credentialReturnRecord('output', target, output, returned);
}

/**
 * The `live` record of the output returned to `returned`: the provider
 * entrypoint's live copy of it below `liveRoot` (see
 * {@link SPRITES_LIVE_CREDENTIAL_ROOTS}). With the same checks as the store's
 * copy, the launcher returns the live copy instead of the store's whenever it
 * exists (the store's copy is current only when the entrypoint's sync ran), and
 * records no export when a symlink or another file type is on its path.
 */
export function spritesLiveOutputRecord(liveRoot: string, output: string, returned: string): string[] {
    return credentialReturnRecord('live', liveRoot, output, returned);
}

function credentialReturnRecord(kind: 'output' | 'live', target: string, output: string, returned: string): string[] {
    const boundary = SPRITES_TARGET_BOUNDARIES.find(prefix => target.startsWith(`${prefix}/`) && target.length > prefix.length + 1);
    const file = path.posix.join(target, output);
    if (!boundary || !isSafeSpritesTarget(target) || path.posix.normalize(file) !== file || !file.startsWith(`${target}/`)) {
        throw new Error(`Agent runtime "sprites" cannot return a credential from ${file}`);
    }
    return [kind, boundary, file.slice(boundary.length + 1), returned];
}
