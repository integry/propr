/**
 * The follow-up assignment gate: when `followup_requires_assignment` is on,
 * only people assigned to a pull request may start follow-up work on it.
 *
 * Both comment intake paths (webhook `processCommentEvent` and polling
 * `collectUnprocessedComments`) ask this module, so they cannot disagree.
 *
 * - A pull request with no assignees is unaffected.
 * - ProPR's own system comments (CI-failure follow-up, system `/ultrafix`) are
 *   authenticated by their marker, not by a person, and are never gated.
 * - The gate fails closed: when the live assignee read fails, the comment is
 *   refused.
 *
 * With the setting off, nothing here calls GitHub.
 */

import type { Redis } from 'ioredis';
import type { AttributedUser } from '@propr/shared';
import { loadFollowupRequiresAssignment } from '../config/configManagerAssignment.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { syncSubjectAssignees, type TaskAssignmentClient } from '../services/taskAssignmentService.js';
import { withRetry } from '../utils/retryHandler.js';
import logger from '../utils/logger.js';
import { getBotUsername } from '../daemon/configLoader.js';
import { parseSlashCommand } from './slashCommandParser.js';
import { isCiFailureFollowupComment } from './ciFailureFollowup.js';

export type FollowupGateReason =
    | 'gate_disabled'
    | 'system_authored'
    | 'no_assignees'
    | 'author_assigned'
    | 'author_not_assigned'
    | 'assignment_unavailable';

export interface FollowupGateDecision {
    allowed: boolean;
    reason: FollowupGateReason;
}

export interface FollowupGatePullRequest {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
}

export interface FollowupGateAuthor {
    authorId?: number | string | null;
    authorLogin: string;
    /** True for ProPR's own marker-authenticated comments, which are never gated. */
    systemAuthored?: boolean;
}

export type FollowupGateInput = FollowupGatePullRequest & FollowupGateAuthor;

export interface FollowupGateOptions {
    /** Defaults to the installation's authenticated Octokit. */
    github?: TaskAssignmentClient;
    /** Defaults to the `followup_requires_assignment` setting. */
    isEnabled?: () => Promise<boolean>;
    now?: () => Date;
}

/** Decides for one author at a time against a single live assignee read. */
export interface FollowupGateEvaluator {
    decide(author: FollowupGateAuthor): Promise<FollowupGateDecision>;
}

/** How long a refused author is not told again on the same pull request. */
export const FOLLOWUP_ASSIGNMENT_NOTICE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The logins ProPR itself comments as. */
export function getSystemBotUsernames(): Set<string> {
    return new Set(
        [getBotUsername(), process.env.GITHUB_BOT_USERNAME, 'propr-dev[bot]']
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
    );
}

/** Whether a login is one of ProPR's own, compared as GitHub does, without case. */
function isSystemBotLogin(login: string): boolean {
    const lower = login.toLowerCase();
    return [...getSystemBotUsernames()].some(username => username.toLowerCase() === lower);
}

/**
 * Whether a comment is one of ProPR's own system follow-ups — a CI-failure
 * follow-up (authenticated by its marker) or a system `/ultrafix` — posted by
 * one of ProPR's logins. Both intake paths use this to exempt such comments
 * from the assignment gate.
 */
export function isSystemFollowupComment(
    commentAuthor: string,
    body: string | null | undefined,
    botUsernames: Set<string> = getSystemBotUsernames(),
): boolean {
    if (!botUsernames.has(commentAuthor)) return false;
    return isCiFailureFollowupComment(body) || parseSlashCommand(body)?.command === 'ultrafix';
}

const DISABLED: FollowupGateDecision = Object.freeze({ allowed: true, reason: 'gate_disabled' });

function isAssignee(assignees: AttributedUser[], author: FollowupGateAuthor): boolean {
    const authorId = author.authorId === null || author.authorId === undefined ? '' : String(author.authorId);
    const login = author.authorLogin.toLowerCase();
    return assignees.some(assignee => (authorId !== '' && assignee.id === authorId) || assignee.login.toLowerCase() === login);
}

/**
 * Creates an evaluator for one pull request. The setting is read once, and
 * the live assignees are read from GitHub at most once, on the first
 * non-system author, so a pull request with comments from several people
 * costs a single GitHub call.
 */
export async function createFollowupGateEvaluator(pullRequest: FollowupGatePullRequest, options: FollowupGateOptions = {}): Promise<FollowupGateEvaluator> {
    const enabled = await (options.isEnabled ?? loadFollowupRequiresAssignment)();
    if (!enabled) return { decide: async () => DISABLED };

    let assignees: Promise<AttributedUser[] | null> | null = null;
    const readAssignees = (): Promise<AttributedUser[] | null> => {
        assignees ??= (async () => {
            try {
                const github = options.github ?? await getAuthenticatedOctokit() as unknown as TaskAssignmentClient;
                return await syncSubjectAssignees(
                    { owner: pullRequest.repoOwner, repo: pullRequest.repoName, number: pullRequest.pullRequestNumber, kind: 'pull_request' },
                    { github, now: options.now },
                );
            } catch (error) {
                logger.warn({
                    repository: `${pullRequest.repoOwner}/${pullRequest.repoName}`,
                    pullRequestNumber: pullRequest.pullRequestNumber,
                    error: (error as Error).message,
                }, 'Failed to read live pull request assignees; follow-up assignment gate is closed');
                return null;
            }
        })();
        return assignees;
    };

    return {
        async decide(author) {
            if (author.systemAuthored) return { allowed: true, reason: 'system_authored' };
            const live = await readAssignees();
            if (live === null) return { allowed: false, reason: 'assignment_unavailable' };
            if (live.length === 0) return { allowed: true, reason: 'no_assignees' };
            return isAssignee(live, author)
                ? { allowed: true, reason: 'author_assigned' }
                : { allowed: false, reason: 'author_not_assigned' };
        },
    };
}

/** Whether a comment's author may start follow-up work on the pull request. */
export async function commentAuthorMayFollowUp(input: FollowupGateInput, options: FollowupGateOptions = {}): Promise<FollowupGateDecision> {
    const { repoOwner, repoName, pullRequestNumber, ...author } = input;
    const evaluator = await createFollowupGateEvaluator({ repoOwner, repoName, pullRequestNumber }, options);
    return evaluator.decide(author);
}

/**
 * How long intake remembers a comment the assignment gate refused because its
 * author was not assigned. Webhook and polling intake share this record, so a
 * refused comment never starts work later, whether the same webhook is
 * redelivered or polling reads it again, even once its author is assigned:
 * the author is told to comment again, and a new comment is what counts.
 * A refusal caused by an unreadable assignment is not recorded, so it stays
 * retryable.
 */
export const REFUSED_COMMENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface RefusedComment {
    owner: string;
    repo: string;
    prNumber: number;
    commentId: number;
}

export function refusedCommentKey({ owner, repo, prNumber, commentId }: RefusedComment): string {
    return `pr-comment-refused:${owner}:${repo}:${prNumber}:${commentId}`;
}

/** Records a definitive refusal. Throws when it cannot be stored. */
export async function rememberRefusedComment(redisClient: Redis, comment: RefusedComment): Promise<void> {
    await redisClient.setex(refusedCommentKey(comment), REFUSED_COMMENT_TTL_SECONDS, Date.now().toString());
}

/** Whether a comment was definitively refused. Throws when the record cannot be read. */
export async function wasRefused(redisClient: Redis, comment: RefusedComment): Promise<boolean> {
    return Boolean(await redisClient.get(refusedCommentKey(comment)));
}

export function followupAssignmentNoticeKey(pullRequest: FollowupGatePullRequest, authorLogin: string): string {
    return `followup-assignment-notice:${pullRequest.repoOwner}:${pullRequest.repoName}:${pullRequest.pullRequestNumber}:${authorLogin.toLowerCase()}`;
}

export function buildFollowupAssignmentNotice(authorLogin: string): string {
    return `@${authorLogin} ProPR only starts follow-up work on this pull request for people assigned to it, and you are not assigned, so your comment was not acted on. `
        + 'Ask an assignee or a maintainer to assign you, then comment again.';
}

export interface RefuseGatedCommentOptions {
    redisClient: Redis;
    github?: TaskAssignmentClient;
    correlatedLogger?: Pick<typeof logger, 'info' | 'warn'>;
}

/**
 * Logs a refusal and, for an unassigned author, posts a one-time explanatory
 * comment. The notice is deduplicated in Redis per (pull request, author), so
 * a long conversation produces one explanation rather than one per comment.
 * A refusal caused by a failed assignee read is not the author's doing and
 * posts nothing, and neither does one of ProPR's own logins (whitelisted, its
 * comments reach the gate), which would only address the notice to itself.
 * Never throws.
 */
export async function refuseGatedComment(
    input: FollowupGatePullRequest & { authorLogin: string; commentId?: number; decision: FollowupGateDecision },
    options: RefuseGatedCommentOptions,
): Promise<void> {
    const log = options.correlatedLogger ?? logger;
    const { repoOwner, repoName, pullRequestNumber, authorLogin, commentId, decision } = input;
    log.info({
        repository: `${repoOwner}/${repoName}`,
        pullRequestNumber,
        commentId,
        author: authorLogin,
        reason: decision.reason,
    }, 'Follow-up comment refused by the assignment gate');

    if (decision.reason !== 'author_not_assigned') return;
    if (isSystemBotLogin(authorLogin)) return;

    const key = followupAssignmentNoticeKey(input, authorLogin);
    try {
        const claimed = await options.redisClient.set(key, Date.now().toString(), 'EX', FOLLOWUP_ASSIGNMENT_NOTICE_TTL_SECONDS, 'NX');
        if (claimed !== 'OK') return;
    } catch (error) {
        log.warn({ repository: `${repoOwner}/${repoName}`, pullRequestNumber, author: authorLogin, error: (error as Error).message }, 'Failed to claim follow-up assignment notice; not posting it');
        return;
    }

    try {
        const github = options.github ?? await getAuthenticatedOctokit() as unknown as TaskAssignmentClient;
        await withRetry(
            () => github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
                owner: repoOwner,
                repo: repoName,
                issue_number: pullRequestNumber,
                body: buildFollowupAssignmentNotice(authorLogin),
            }),
            { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, exponentialBase: 2 },
            `post_followup_assignment_notice_${repoOwner}_${repoName}_${pullRequestNumber}`,
        );
    } catch (error) {
        // Release the claim so the next refused comment can explain instead.
        await options.redisClient.del(key).catch(() => undefined);
        log.warn({ repository: `${repoOwner}/${repoName}`, pullRequestNumber, author: authorLogin, error: (error as Error).message }, 'Failed to post follow-up assignment notice');
    }
}
