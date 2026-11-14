import { PR_STATUS_BLOCK_MAX_LENGTH } from '@propr/shared';

/**
 * Every ProPR rewrite of a pull request body goes through here. Core's
 * `updatePullRequestBody` re-reads the current body under the body lock and
 * carries the live status block over, so a writer never drops or duplicates
 * it. Core is imported lazily so suites mocking `@propr/core` with an
 * enumerated export list keep linking; without it the body is written as given.
 */
type Request = <T = unknown>(route: string, parameters: Record<string, unknown>) => Promise<T>;

export interface PullRequestBodyTarget {
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
}

interface StatusCore {
    updatePullRequestBody?: <T>(github: { request: Request }, target: PullRequestBodyTarget) => Promise<T>;
    initialPullRequestStatusBlock?: (repository: string) => Promise<string | null>;
    initialPullRequestTitle?: (repository: string, title: string) => Promise<string>;
}

async function loadCore(): Promise<StatusCore | null> {
    try {
        return await import('@propr/core') as StatusCore;
    } catch {
        return null;
    }
}

export async function writePullRequestBody<T = { data: { body?: string | null } }>(
    octokit: { request: Request },
    target: PullRequestBodyTarget,
): Promise<T> {
    const update = (await loadCore())?.updatePullRequestBody;
    if (update) return await update<T>(octokit, target);
    return await octokit.request<T>('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: target.owner, repo: target.repo, pull_number: target.pullNumber, body: target.body,
    });
}

/**
 * The status block every new ProPR pull request is created with, so the
 * status is in the body from the start. Null when this process does not
 * maintain the status or core cannot provide it.
 */
export async function initialPullRequestStatusBlock(repository: string): Promise<string | null> {
    const initial = (await loadCore())?.initialPullRequestStatusBlock;
    if (!initial) return null;
    try {
        return await initial(repository);
    } catch {
        return null;
    }
}

/**
 * The title a new ProPR pull request is created with: the `🔨 ` status slot
 * first when this process maintains the status and the repository's
 * prTitleStatus setting is on, so creation costs no rename. Otherwise the
 * title exactly as given.
 */
export async function initialPullRequestTitle(repository: string, title: string): Promise<string> {
    const initial = (await loadCore())?.initialPullRequestTitle;
    if (!initial) return title;
    try {
        return await initial(repository, title);
    } catch {
        return title;
    }
}

/** Puts a new pull request's status block first; the body itself is unchanged. */
export function withPullRequestStatusBlock(body: string, block: string | null): string {
    if (!block) return body;
    return body ? `${block}\n\n${body}` : block;
}

/**
 * Characters a new pull request body reserves for its status block: the most
 * the block can ever take (plus its separator), not the initial block's
 * length, so later, longer statuses still fit within GitHub's body limit.
 */
export function pullRequestStatusBlockReserve(block: string | null): number {
    return block ? Math.max(PR_STATUS_BLOCK_MAX_LENGTH, block.length) + 2 : 0;
}
