import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// Core is loaded lazily so suites that replace `@propr/core` with a fixed export list still link.
type Core = typeof import('@propr/core');
const loadCore = (): Promise<Core> => import('@propr/core');

/** Open ProPR pull requests inspected for shared files when a new one is opened. */
const MAX_OPEN_PULL_REQUESTS = 10;
const MAX_LISTED_OVERLAPS = 10;
const LOOKUP_TIMEOUT_MS = 10_000;
const FILES_PER_PAGE = 100;
/** GitHub lists at most 3000 files for a pull request, so pages past this one are always empty. */
const MAX_FILE_PAGES = 30;

interface OverlapOctokit {
    request(route: string, params: Record<string, unknown>): Promise<{ data: unknown }>;
}

export interface PullRequestOverlapNoteOptions {
    octokit: OverlapOctokit;
    /** Only consulted when connected; a disconnected client never delays PR creation. */
    redis?: Pick<Redis, 'status' | 'zremrangebyscore' | 'zrange' | 'mget'> | null;
    repoOwner: string;
    repoName: string;
    taskId?: string;
    branchName: string;
    prLabel: string;
    paths: readonly string[];
    correlatedLogger?: Pick<Logger, 'debug'>;
}

export interface OverlapSource { key: string; label: string; paths: string[] }

type PullRequestSummary = { number?: unknown; head?: { ref?: unknown }; labels?: Array<{ name?: unknown }> };

async function activeTaskSources(core: Core, options: PullRequestOverlapNoteOptions): Promise<OverlapSource[]> {
    const redis = options.redis;
    if (!redis || redis.status !== 'ready') return [];
    const { listActiveFileChangesTasks, readChangedPaths, describeTask } = core;
    const repository = `${options.repoOwner}/${options.repoName}`;
    const active = (await listActiveFileChangesTasks(redis as Redis, repository)).filter(taskId => taskId !== options.taskId);
    const changed = await readChangedPaths(redis as Redis, active);
    return active.map(taskId => ({ key: `task:${taskId}`, label: `Active ${describeTask(taskId)}`, paths: changed.get(taskId) ?? [] }));
}

async function openPullRequestSources(options: PullRequestOverlapNoteOptions): Promise<OverlapSource[]> {
    const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
    const { octokit, repoOwner: owner, repoName: repo } = options;
    const list = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open', per_page: 50 });
    if (!Array.isArray(list.data)) return [];
    const pulls = (list.data as PullRequestSummary[])
        .filter(pull => typeof pull.number === 'number' && pull.head?.ref !== options.branchName
            && Array.isArray(pull.labels) && pull.labels.some(label => label?.name === options.prLabel))
        .slice(0, MAX_OPEN_PULL_REQUESTS);
    const sources: OverlapSource[] = [];
    for (const pull of pulls) {
        sources.push({ key: `pr:${pull.number}`, label: `Open PR #${pull.number}`, paths: await pullRequestFilePaths(options, pull.number as number, deadline) });
    }
    return sources;
}

/**
 * Every changed file of one pull request, page by page. Stops at the lookup deadline, by which
 * point the note has already gone without open PRs, so a partial list is never compared.
 */
async function pullRequestFilePaths(options: PullRequestOverlapNoteOptions, pullNumber: number, deadline: number): Promise<string[]> {
    const { octokit, repoOwner: owner, repoName: repo } = options;
    const paths: string[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        if (Date.now() >= deadline) throw new Error(`Changed files of PR #${pullNumber} were not read before the lookup deadline`);
        const files = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { owner, repo, pull_number: pullNumber, per_page: FILES_PER_PAGE, page });
        if (!Array.isArray(files.data)) break;
        for (const file of files.data as Array<{ filename?: unknown }>) if (typeof file?.filename === 'string') paths.push(file.filename);
        if (files.data.length < FILES_PER_PAGE) break;
    }
    return paths;
}

async function settle<T>(work: Promise<T[]>, log: PullRequestOverlapNoteOptions['correlatedLogger'], what: string): Promise<T[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<T[]>(resolve => { timer = setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS); timer.unref?.(); })]);
    } catch (error) {
        log?.debug({ error: (error as Error).message }, `Could not read ${what} for the file overlap note`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/** Renders the note; empty when nothing overlaps. Pure, so the wording is testable on its own. */
export function renderPullRequestOverlapNote(core: Pick<Core, 'computeFileOverlaps' | 'boundOverlapPaths' | 'describeOverlapPaths'>, paths: readonly string[], sources: readonly OverlapSource[], hotPaths: readonly string[] = []): string {
    const { computeFileOverlaps, boundOverlapPaths, describeOverlapPaths } = core;
    const self = '__self__';
    const overlaps = computeFileOverlaps([{ taskId: self, paths }, ...sources.map(source => ({ taskId: source.key, paths: source.paths }))], { hotPaths });
    const labels = new Map(sources.map(source => [source.key, source.label]));
    const lines = overlaps
        .filter(overlap => overlap.taskIds.includes(self))
        .map(overlap => {
            const other = overlap.taskIds[0] === self ? overlap.taskIds[1] : overlap.taskIds[0];
            const bounded = boundOverlapPaths(overlap.paths);
            return `- ${labels.get(other) ?? other}: ${describeOverlapPaths(bounded.paths, bounded.totalPaths)}`;
        });
    if (!lines.length) return '';
    const listed = lines.slice(0, MAX_LISTED_OVERLAPS);
    if (lines.length > listed.length) listed.push(`- …and ${lines.length - listed.length} more`);
    return `### ⚠️ Also being changed elsewhere\n\nOther active work on this repository changes the same files as this pull request. Nothing was delayed; check for merge conflicts before merging.\n\n${listed.join('\n')}`;
}

/** Notes, for a pull request being opened, other active tasks and open ProPR PRs changing the same files. */
export async function buildPullRequestOverlapNote(options: PullRequestOverlapNoteOptions): Promise<string> {
    if (!options.paths.length) return '';
    const core = await loadCore();
    if (typeof core.computeFileOverlaps !== 'function') return '';
    const [tasks, pulls] = await Promise.all([
        settle(activeTaskSources(core, options), options.correlatedLogger, 'active tasks'),
        settle(openPullRequestSources(options), options.correlatedLogger, 'open pull requests'),
    ]);
    return renderPullRequestOverlapNote(core, options.paths, [...tasks, ...pulls], core.configuredHotPaths());
}

/** Appends the note when it still fits within `maxLength`; otherwise the body is unchanged. */
export function appendOverlapNote(body: string, note: string, maxLength: number): string {
    if (!note) return body;
    const combined = `${body}\n\n---\n\n${note}`;
    return combined.length <= maxLength ? combined : body;
}

export interface PullRequestChangedPathsOptions {
    worktreePath?: string;
    baseBranch: string;
    commitResult?: { filesChanged?: string[] } | null;
    claudeResult?: { modifiedFiles?: string[] } | null;
    correlatedLogger?: Pick<Logger, 'debug'>;
    /** Seam for tests: the branch's changed paths against the base. */
    branchDiffPaths?: (worktreePath: string, baseRef: string) => Promise<string[]>;
}

async function gitBranchDiffPaths(worktreePath: string, baseRef: string): Promise<string[]> {
    const { createHooklessGit } = await loadCore();
    const output = await createHooklessGit(worktreePath).raw(['diff', '--name-only', '-z', `${baseRef}...HEAD`]);
    return output.split('\0').filter(Boolean);
}

/**
 * The PR's changed files: the whole branch diff against the PR base, so commits the agent
 * made itself count alongside the final post-processing commit. When the diff cannot be read
 * in time, falls back to the union of the final commit's files and the agent's report.
 */
export async function changedPathsForOverlap(options: PullRequestChangedPathsOptions): Promise<string[]> {
    const fallback = [...new Set([...(options.commitResult?.filesChanged ?? []), ...(options.claudeResult?.modifiedFiles ?? [])])];
    if (!options.worktreePath) return fallback;
    const diff = await settle((options.branchDiffPaths ?? gitBranchDiffPaths)(options.worktreePath, `origin/${options.baseBranch}`),
        options.correlatedLogger, 'the branch diff');
    return diff.length ? [...new Set([...diff, ...fallback])] : fallback;
}

/** `body` with the overlap note appended when there is one and it fits; never throws. */
export async function withPullRequestOverlapNote(body: string, maxLength: number, options: PullRequestOverlapNoteOptions): Promise<string> {
    try {
        return appendOverlapNote(body, await buildPullRequestOverlapNote(options), maxLength);
    } catch (error) {
        options.correlatedLogger?.debug({ error: (error as Error).message }, 'Could not build the file overlap note');
        return body;
    }
}
