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
    const cleaned = taskId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '').replace(/\.lock$/i, '-lock');
    return cleaned.slice(0, 200) || 'task';
}

export function rescueRefName(taskId: string): string {
    return `${RESCUE_REF_PREFIX}${sanitizeRescueId(taskId)}`;
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
    /** When the salvaged commit was created; undefined when it cannot be determined. */
    commitDate(sha: string): Promise<Date | undefined>;
    deleteRef(ref: string): Promise<void>;
}

export interface RescueRefPruneResult {
    deleted: string[];
    retained: number;
    failed: number;
}

/** Deletes rescue refs whose salvaged commit is older than the retention period. */
export async function pruneRescueRefs(
    deps: RescueRefPruneDependencies,
    options: { olderThanDays?: number; now?: Date; repository?: string } = {},
): Promise<RescueRefPruneResult> {
    const olderThanDays = options.olderThanDays ?? getRescueRetentionDays();
    const cutoff = (options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000;
    const result: RescueRefPruneResult = { deleted: [], retained: 0, failed: 0 };
    for (const { ref, sha } of await deps.listRefs()) {
        if (!isRescueRef(ref)) continue;
        try {
            const date = await deps.commitDate(sha);
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
    commitDate: (sha: string) => Promise<Date | undefined>;
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
        commitDate: options.commitDate,
        async deleteRef(ref) {
            await run(['push', url, `:${ref}`]);
        },
    };
}

export interface RescueBundlePruneResult {
    deleted: string[];
    retained: number;
}

/** Deletes bundles older than the retention period and the directories they leave empty. */
export async function pruneRescueBundles(options: { olderThanDays?: number; directory?: string; now?: Date } = {}): Promise<RescueBundlePruneResult> {
    const directory = options.directory ?? getRescueBundleDirectory();
    const olderThanDays = options.olderThanDays ?? getRescueRetentionDays();
    const cutoff = (options.now ?? new Date()).getTime() - olderThanDays * 24 * 60 * 60 * 1000;
    const result: RescueBundlePruneResult = { deleted: [], retained: 0 };
    if (!await fs.pathExists(directory)) return result;

    const visit = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
                if ((await fs.readdir(entryPath)).length === 0) await fs.remove(entryPath);
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
