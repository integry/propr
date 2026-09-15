import { db, getAuthenticatedOctokit } from '@propr/core';
import type { PullRequestGitTarget, PullRequestHead } from './prGitTarget.js';

export interface ContinuationRecord {
    repository: string;
    source_pr: number;
    source_sha: string;
    base_branch: string;
    branch_name: string;
    source_title: string;
    source_body: string;
    source_author: string;
    continuation_pr: number | null;
    continuation_url: string | null;
    comment_id: number | null;
    publication_bundle: string | null;
    publication_completion: string | null;
}

export interface Contribution {
    head: PullRequestHead;
    base: { ref: string };
    title: string;
    body: string | null;
    user: { login: string };
}

export interface PullRequestReference {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
/** Publishes saved implementation commits to the reserved branch when GitHub would
 * otherwise reject the continuation PR as having no commits ahead of its base.
 */
export type PublishContinuationHead = (target: PullRequestGitTarget) => Promise<unknown>;
const repositoryKey = (ref: PullRequestReference) => `${ref.repoOwner}/${ref.repoName}`.toLowerCase();
/** GitHub rejects pull request bodies above this many characters. */
export const MAX_PULL_REQUEST_BODY_LENGTH = 65536;

export async function findPRContinuation(ref: PullRequestReference, octokit?: Octokit): Promise<ContinuationRecord | undefined> {
    const mapped = await db<ContinuationRecord>('pr_continuations').where({ repository: repositoryKey(ref) })
        .andWhere(builder => builder.where({ source_pr: ref.pullRequestNumber }).orWhere({ continuation_pr: ref.pullRequestNumber })).first();
    if (mapped || !octokit) return mapped;
    // GitHub can expose the PR before the creating worker receives its response.
    // Resolve its durable reservation before choosing a processing lease.
    const reservations = await db<ContinuationRecord>('pr_continuations')
        .where({ repository: repositoryKey(ref) }).whereNull('continuation_pr');
    if (!reservations.length) return;
    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: ref.repoOwner, repo: ref.repoName, pull_number: ref.pullRequestNumber,
    });
    const record = reservations.find(candidate =>
        pr.head.repo?.full_name.toLowerCase() === candidate.repository &&
        pr.base.ref === candidate.base_branch &&
        pr.head.ref === candidate.branch_name &&
        pr.body?.includes(`<!-- propr-continuation:${candidate.source_pr}:${candidate.source_sha} -->`));
    if (!record) return;
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr })
        .whereNull('continuation_pr').update({ continuation_pr: pr.number, continuation_url: pr.html_url });
    return findPRContinuation(ref);
}

export function continuationTarget(record: ContinuationRecord): PullRequestGitTarget {
    const [repoOwner, repoName] = record.repository.split('/');
    return { repoOwner, repoName, branchName: record.branch_name, isFork: false };
}

export function continuationStatus(record?: ContinuationRecord): string {
    return record?.continuation_url
        ? `Implementation destination: [continuation PR #${record.continuation_pr}](${record.continuation_url}). Original discussion: https://github.com/${record.repository}/pull/${record.source_pr}.`
        : '';
}

export async function reserveContinuation(ref: PullRequestReference, source: Contribution): Promise<ContinuationRecord> {
    if (!source.head.sha || !/^[a-f0-9]{40}$/i.test(source.head.sha)) throw new Error('Cannot continue contribution without its exact head SHA');
    const repository = repositoryKey(ref);
    await db('pr_continuations').insert({
        repository, source_pr: ref.pullRequestNumber, source_sha: source.head.sha,
        base_branch: source.base.ref, branch_name: `propr/continuation-pr-${ref.pullRequestNumber}`,
        source_title: source.title, source_body: source.body || '', source_author: source.user.login,
    }).onConflict(['repository', 'source_pr']).ignore();
    return (await findPRContinuation(ref))!;
}

async function ensureBranch(octokit: Octokit, record: ContinuationRecord): Promise<void> {
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    try {
        await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner, repo, ref: `refs/heads/${record.branch_name}`, sha: record.source_sha,
        });
    } catch (error) {
        if ((error as { status?: number }).status !== 422) throw error;
        // An earlier attempt may already have created/advanced the branch. Never reset it.
        const { data: comparison } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
            owner, repo, basehead: `${record.source_sha}...${record.branch_name}`,
        });
        if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
            throw new Error(`Continuation branch ${record.branch_name} does not contain source commit ${record.source_sha}`);
        }
    }
}

/** GitHub's 422 for a head with no commits ahead of the base, from either the error
 * message or the validation error list, in the API's own wording.
 */
export function isEmptyPullRequestError(error: unknown): boolean {
    const { status, message, response } = error as {
        status?: number; message?: string; response?: { data?: { errors?: Array<{ message?: string } | string> } };
    };
    if (status !== 422) return false;
    const details = (response?.data?.errors ?? []).map(detail => typeof detail === 'string' ? detail : detail?.message);
    return [message, ...details].some(text => /no commits between/i.test(text ?? ''));
}

/** The stored source_body stays complete for execution context; only the displayed
 * copy is bounded so a valid original body can never make PR creation fail.
 */
export function continuationBody(record: Pick<ContinuationRecord, 'repository' | 'source_pr' | 'source_sha' | 'source_author' | 'source_body'>, marker: string): string {
    const sourceUrl = `https://github.com/${record.repository}/pull/${record.source_pr}`;
    const prefix = `${marker}\nContinuation of ${sourceUrl}, contributed by @${record.source_author}.\n\nSource SHA: \`${record.source_sha}\`\n\nProPR cannot push to the contributor's branch. Implementation will continue here. Contributor commits and attribution are preserved; the original PR remains open and its discussion remains available.\n\nOriginal objective:\n`;
    if (prefix.length + record.source_body.length <= MAX_PULL_REQUEST_BODY_LENGTH) return prefix + record.source_body;
    const notice = `\n\n_The original objective is truncated here. Read the complete text on ${sourceUrl}._`;
    let excerpt = record.source_body.slice(0, MAX_PULL_REQUEST_BODY_LENGTH - prefix.length - notice.length);
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
    return prefix + excerpt + notice;
}

async function ensurePullRequest(octokit: Octokit, record: ContinuationRecord, publishHead?: PublishContinuationHead): Promise<ContinuationRecord> {
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    const marker = `<!-- propr-continuation:${record.source_pr}:${record.source_sha} -->`;
    const findExisting = async () => {
        const prs = await octokit.paginate('GET /repos/{owner}/{repo}/pulls', {
            owner, repo, head: `${owner}:${record.branch_name}`, state: 'all', per_page: 100,
        });
        const pr = prs.find(pr => pr.body?.includes(marker));
        if (prs.length && !pr) throw new Error(`Continuation branch ${record.branch_name} is already used by an unrelated PR`);
        return pr;
    };
    let pr = record.continuation_pr
        ? (await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: record.continuation_pr })).data
        : await findExisting();
    if (!pr) {
        await ensureBranch(octokit, record);
        const create = async () => (await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner, repo, head: record.branch_name, base: record.base_branch,
            title: `Continue #${record.source_pr}: ${record.source_title}`.slice(0, 256),
            body: continuationBody(record, marker),
        })).data;
        try {
            try {
                pr = await create();
            } catch (error) {
                // The base may contain the captured SHA by now (for example after the
                // contribution merged), so the branch alone has nothing ahead of it. The
                // saved implementation makes it non-empty: publish that HEAD, then create again.
                if (!publishHead || !isEmptyPullRequestError(error)) throw error;
                await publishHead(continuationTarget(record));
                pr = await create();
            }
        } catch (error) {
            // Covers competing creates and a lost response after successful publication.
            // GitHub enforces one open PR for this head. A lookup never creates a second PR.
            pr = await findExisting();
            if (!pr) throw error;
        }
    }
    if (pr.base.ref !== record.base_branch || pr.head.ref !== record.branch_name || pr.head.repo?.full_name.toLowerCase() !== record.repository) {
        throw new Error(`Continuation PR #${pr.number} has an unexpected Git target`);
    }
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr }).update({ continuation_pr: pr.number, continuation_url: pr.html_url });
    record = { ...record, continuation_pr: pr.number, continuation_url: pr.html_url };
    if (pr.state !== 'open') throw new Error(`Continuation PR is closed: ${pr.html_url}. Reopen it to continue implementation.`);
    return record;
}

export async function announceContinuation(octokit: Octokit, record: ContinuationRecord): Promise<void> {
    if (record.comment_id) return;
    const { repoOwner: owner, repoName: repo } = continuationTarget(record);
    const marker = `<!-- propr-continuation-link:${record.source_pr}:${record.continuation_pr} -->`;
    const comments = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.source_pr, per_page: 100,
    });
    const existing = comments.find(comment => comment.body?.includes(marker) && comment.user?.type === 'Bot');
    const comment = existing || (await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner, repo, issue_number: record.source_pr,
        body: `${marker}\nProPR does not have permission to publish to this contribution's branch. ${continuationStatus(record)}\n\nImplementation will continue there, preserving the contributor's commits from source SHA \`${record.source_sha}\`. This PR will remain open. Later implementation requests here will be routed to the continuation. Run /review, /fix, or /ultrafix on the continuation; automated review/fix cycles on this original PR will stop.`,
    })).data;
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr }).update({ comment_id: comment.id });
    record.comment_id = comment.id;
}

/** The caller holds the source PR processing lease. The durable reservation, stable
 * branch and GitHub's head uniqueness also recover partial creates and races.
 */
export async function ensurePRContinuation(octokit: Octokit, ref: PullRequestReference, source: Contribution, publishHead?: PublishContinuationHead): Promise<ContinuationRecord> {
    const record = await findPRContinuation(ref) || await reserveContinuation(ref, source);
    return ensurePullRequest(octokit, record, publishHead);
}

/** Store before adoption/publication; clear only after the remote contains the work. */
export async function savePublicationCheckpoint(record: ContinuationRecord, bundle: string | null, completion?: string | null): Promise<void> {
    await db('pr_continuations').where({ repository: record.repository, source_pr: record.source_pr })
        .update({ publication_bundle: bundle, ...(completion !== undefined && { publication_completion: completion }) });
    record.publication_bundle = bundle;
    if (completion !== undefined) record.publication_completion = completion;
}
