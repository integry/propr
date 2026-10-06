import path from 'path';
import fs from 'fs-extra';
import logger from '../utils/logger.js';
import { createHooklessGit } from './hooklessGit.js';
import { redactAuthenticatedGitUrl } from './redactGitUrl.js';

/** Namespace for commits salvaged from a rejected push. Never under refs/heads, so
 * GitHub does not list them as branches and no branch-driven automation sees them. */
export const RESCUE_REF_PREFIX = 'refs/propr/rescue/';

const DEFAULT_RESCUE_RETENTION_DAYS = 14;

/** Task ids become one ref path component and one file name. */
export function sanitizeRescueId(taskId: string): string {
    const collapsed = taskId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.');
    // Trim leading/trailing '.' and '-' without a backtracking `[.-]+$` pattern.
    let start = 0;
    let end = collapsed.length;
    while (start < end && (collapsed[start] === '.' || collapsed[start] === '-')) start++;
    while (end > start && (collapsed[end - 1] === '.' || collapsed[end - 1] === '-')) end--;
    const cleaned = collapsed.slice(start, end).replace(/\.lock$/i, '-lock');
    return cleaned.slice(0, 200) || 'task';
}

/** The rescue creation time is part of the ref name, so retention is measured from the
 * salvage itself rather than from the salvaged commit's (agent-controlled) dates. */
const RESCUE_TIMESTAMP_SEPARATOR = '--';

function formatRescueTimestamp(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

export function rescueRefName(taskId: string, createdAt: Date = new Date()): string {
    return `${RESCUE_REF_PREFIX}${sanitizeRescueId(taskId)}${RESCUE_TIMESTAMP_SEPARATOR}${formatRescueTimestamp(createdAt)}`;
}

/** When the rescue ref was created, read from its name; undefined when the name carries no
 * valid timestamp, so the ref's age cannot be established. */
export function rescueRefCreatedAt(ref: string): Date | undefined {
    const separator = ref.lastIndexOf(RESCUE_TIMESTAMP_SEPARATOR);
    if (separator < 0) return undefined;
    const stamp = ref.slice(separator + RESCUE_TIMESTAMP_SEPARATOR.length);
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
    if (!match) return undefined;
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
    // Reject out-of-range fields (month 13, hour 25) that Date.UTC would silently roll over.
    return formatRescueTimestamp(date) === stamp ? date : undefined;
}

/** True for a rescue ref in any spelling a webhook or branch listing can produce. */
export function isRescueRef(ref: string | null | undefined): boolean {
    if (!ref) return false;
    const normalized = ref.trim().replace(/^refs\/heads\//, '');
    return normalized.startsWith(RESCUE_REF_PREFIX) || normalized.startsWith('propr/rescue/');
}

export function getRescueRetentionDays(): number {
    const parsed = Number.parseInt(process.env.PUSH_RESCUE_RETENTION_DAYS ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RESCUE_RETENTION_DAYS;
}

/** Durable location next to the SQLite database unless PUSH_RESCUE_BUNDLE_DIR overrides it. */
export function getRescueBundleDirectory(): string {
    if (process.env.PUSH_RESCUE_BUNDLE_DIR) return path.resolve(process.env.PUSH_RESCUE_BUNDLE_DIR);
    const dataDir = process.env.DATA_DIR
        ?? (process.env.DB_FILENAME ? path.dirname(path.resolve(process.env.DB_FILENAME)) : path.join(process.cwd(), 'data'));
    return path.join(dataDir, 'rescue');
}

export function rescueBundlePath(repoOwner: string, repoName: string, taskId: string, directory = getRescueBundleDirectory()): string {
    return path.join(directory, sanitizeRescueId(repoOwner), sanitizeRescueId(repoName), `${sanitizeRescueId(taskId)}.bundle`);
}

export interface RemoteRescueRef {
    ref: string;
    sha: string;
}

export interface RescueRefPruneDependencies {
    /** Lists `refs/propr/rescue/*` on the remote. */
    listRefs(): Promise<RemoteRescueRef[]>;
    deleteRef(ref: string): Promise<void>;
}

export interface RescueRefPruneResult {
    deleted: string[];
    retained: number;
    failed: number;
}

/** Deletes rescue refs created longer ago than the retention period. Refs whose creation
 * time cannot be read from their name are retained. */
export async function pruneRescueRefs(
    deps: RescueRefPruneDependencies,
    options: { olderThanDays?: number; now?: Date; repository?: string } = {},
): Promise<RescueRefPruneResult> {
    const olderThanDays = options.olderThanDays ?? getRescueRetentionDays();
    const cutoff = (options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000;
    const result: RescueRefPruneResult = { deleted: [], retained: 0, failed: 0 };
    for (const { ref } of await deps.listRefs()) {
        if (!isRescueRef(ref)) continue;
        try {
            const date = rescueRefCreatedAt(ref);
            if (!date || date.getTime() > cutoff) { result.retained++; continue; }
            await deps.deleteRef(ref);
            result.deleted.push(ref);
        } catch (error) {
            result.failed++;
            logger.warn({ repository: options.repository, ref, error: redactAuthenticatedGitUrl((error as Error).message) }, 'Failed to prune rescue ref');
        }
    }
    return result;
}

function authenticatedUrl(repoUrl: string, token: string): string {
    return repoUrl.replace('https://', `https://x-access-token:${token}@`);
}

/** Remote-only operations: nothing is fetched into a clone, so rescue refs never become
 * local or remote-tracking branches. */
export function createGitRescueRefPruneDependencies(options: {
    repoUrl: string;
    token: string;
}): RescueRefPruneDependencies {
    const git = createHooklessGit();
    const url = authenticatedUrl(options.repoUrl, options.token);
    const run = async (args: string[]) => {
        try {
            return await git.raw(args);
        } catch (error) {
            throw new Error(redactAuthenticatedGitUrl((error as Error).message).replaceAll(options.token, '[REDACTED]'));
        }
    };
    return {
        async listRefs() {
            const output = await run(['ls-remote', url, `${RESCUE_REF_PREFIX}*`]);
            return output.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2)
                .map(([sha, ref]) => ({ sha, ref }));
        },
        async deleteRef(ref) {
            await run(['push', url, `:${ref}`]);
        },
    };
}

export interface RescueBundlePruneResult {
    deleted: string[];
    retained: number;
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Non-recursive, so a bundle a worker writes into the directory after the sweep emptied
 * it is never deleted with it: the removal then fails with ENOTEMPTY instead. */
async function removeDirectoryIfEmpty(dir: string): Promise<void> {
    try {
        await fs.rmdir(dir);
    } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw error;
    }
}

/** Deletes bundles older than the retention period and the directories they leave empty. */
export async function pruneRescueBundles(options: { olderThanDays?: number; directory?: string; now?: Date } = {}): Promise<RescueBundlePruneResult> {
    const directory = options.directory ?? getRescueBundleDirectory();
    const olderThanDays = options.olderThanDays ?? getRescueRetentionDays();
    const cutoff = (options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000;
    const result: RescueBundlePruneResult = { deleted: [], retained: 0 };
    if (!await fs.pathExists(directory)) return result;

    const visit = async (dir: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (errorCode(error) === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
                await removeDirectoryIfEmpty(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.bundle')) {
                const stats = await fs.stat(entryPath);
                if (stats.mtime.getTime() <= cutoff) {
                    await fs.remove(entryPath);
                    result.deleted.push(entryPath);
                } else {
                    result.retained++;
                }
            }
        }
    };
    await visit(directory);
    return result;
}
