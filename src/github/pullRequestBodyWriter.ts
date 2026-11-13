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
    recordPullRequestStatusBlock?: (repository: string, prNumber: number) => Promise<void>;
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
 * The status block a new ProPR pull request is created with when the
 * repository shows the status, so the status is in the body from the start.
 * Null when the setting is off or cannot be read.
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
 * Records that a new pull request was created with a status block, so turning
 * the setting off removes it later even if no update rewrote it. Never throws.
 */
export async function recordPullRequestStatusBlock(repository: string, prNumber: number, block: string | null): Promise<void> {
    if (!block) return;
    const record = (await loadCore())?.recordPullRequestStatusBlock;
    if (!record) return;
    try {
        await record(repository, prNumber);
    } catch {
        // The next status update records it.
    }
}

/** Puts a new pull request's status block first; the body itself is unchanged. */
export function withPullRequestStatusBlock(body: string, block: string | null): string {
    if (!block) return body;
    return body ? `${block}\n\n${body}` : block;
}

/** Characters the status block takes from a new pull request body's length budget. */
export function pullRequestStatusBlockLength(block: string | null): number {
    return block ? block.length + 2 : 0;
}
