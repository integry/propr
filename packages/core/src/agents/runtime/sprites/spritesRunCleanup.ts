import path from 'node:path';
import { WORKSPACE_TRANSPORT_RESULT_DIR } from '../../../git/workspaceTransportScript.js';
import type { AgentRunMount, AgentRunSpec } from '../types.js';
import { isSafeSpritesTarget, SPRITES_AGENT_HOME, SPRITES_ANTIGRAVITY_HOME } from './spritesCredentialRecords.js';

/**
 * What a run can leave on a Sprite outside its run directory, removed by root
 * before the run's files are installed (`purge` records of
 * `SPRITES_LAUNCHER_SCRIPT`) and when the run is released without a
 * checkpoint restore (`SPRITES_SCRUB_SCRIPT`).
 */

/** Where each provider's credential copy goes; removed before and after every run so no account outlives its run. */
export const SPRITES_CREDENTIAL_TARGETS: readonly string[] = Object.freeze([
    '/home/node/.claude', '/home/node/.claude.json', '/home/node/.codex', '/home/node/.gemini', '/home/node/.gemini-source',
    '/home/node/.config/opencode', '/home/node/.local/share/opencode', '/home/node/.vibe', '/run/propr-claude',
]);

/** Removed before every run (with every credential target): a live copy an earlier run left is never returned as this run's token. */
export const SPRITES_RUN_PURGE_TARGETS: readonly string[] = Object.freeze([...SPRITES_CREDENTIAL_TARGETS, SPRITES_ANTIGRAVITY_HOME]);

/** Host binds whose content the run never needs back: an empty directory stands in. */
const EMPTY_DIRECTORY_PURPOSES = new Set<AgentRunMount['purpose']>(['logs', 'scratch']);

/** A mount the Sprite provides as an empty directory: a tmpfs, or a writable log or scratch bind. */
export function spritesProvidesEmptyDirectory(mount: AgentRunMount): boolean {
    return mount.type === 'tmpfs' || (!mount.credentialStore && EMPTY_DIRECTORY_PURPOSES.has(mount.purpose) && !mount.readOnly);
}

/**
 * The launcher's first records: every credential target and Antigravity's
 * HOME, and every directory the plan provides empty (log, scratch and tmpfs
 * directories) are removed before anything is installed, so what an earlier
 * run left in them never reaches this run.
 */
export function spritesPurgeRecords(plan: { directories: readonly string[] }): string[][] {
    return [...new Set([...SPRITES_RUN_PURGE_TARGETS, ...plan.directories])].map(target => ['purge', target]);
}

/**
 * Everything a run leaves outside its run directory: the clone workspace
 * (with `.git`), the workspace result (`result.bundle`), its log, scratch and
 * tmpfs directories, Antigravity's disposable HOME and every credential
 * target. Removed when the run is released and the Sprite cannot be restored
 * to its clean checkpoint. With `keepLiveCredentials` (their export was not
 * confirmed, so they may hold the only valid token) the credential targets
 * and Antigravity's HOME stay as the run left them, with any of its
 * directories inside or around them.
 */
export function spritesRunLeftovers(spec: Pick<AgentRunSpec, 'workdir' | 'name' | 'mounts'>, { keepLiveCredentials = false } = {}): string[] {
    const workdir = path.posix.normalize(spec.workdir);
    const safeWorkdir = path.posix.isAbsolute(workdir) && [`${SPRITES_AGENT_HOME}/`, '/tmp/'].some(prefix => workdir.startsWith(prefix) && workdir.length > prefix.length);
    if (!safeWorkdir) throw new Error(`Agent runtime "sprites" cannot run ${spec.name} in ${spec.workdir} (the workdir must be under ${SPRITES_AGENT_HOME}/ or /tmp/)`);
    const liveCopies = [SPRITES_ANTIGRAVITY_HOME, ...SPRITES_CREDENTIAL_TARGETS];
    const overlaps = (left: string, right: string) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    const directories = spec.mounts.filter(spritesProvidesEmptyDirectory).map(mount => mount.target)
        .filter(target => isSafeSpritesTarget(target) && !(keepLiveCredentials && liveCopies.some(live => overlaps(target, live))));
    return [...new Set([workdir, WORKSPACE_TRANSPORT_RESULT_DIR, ...directories, ...(keepLiveCredentials ? [] : liveCopies)])];
}
