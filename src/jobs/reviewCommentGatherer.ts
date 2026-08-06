/**
 * Gathers unprocessed AI review comments from a PR for inclusion in /fix prompts.
 *
 * When /fix runs it should automatically pick up AI review comments that:
 *   - Are still present on the PR (not deleted).
 *   - Have not already been consumed by a prior successful /fix run.
 *
 * New structured reviews are consumed per F#/S# record so selecting F1 does
 * not discard F2 from the same comment. The legacy whole-comment Redis set is
 * still honored for reviews processed before record-level tracking existed.
 */

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { getProcessedReviewCommentsKey } from '@propr/core';
import { isReviewComment } from './reviewCommentFormatter.js';

export interface AIReviewComment {
    id: number;
    /** Actionable-only rendering retained for backwards-compatible callers. */
    body: string;
    author: string;
    created_at: string;
    actionableFindings: ActionableFinding[];
    suggestions: ReviewSuggestion[];
    score: number | null;
}

export interface ActionableFinding {
    id: string;
    title: string;
    violatedRequirement: string;
    evidence: string;
    introducedByPR: true;
    introducedByPRExplanation: string;
    requiredForMerge: true;
    minimumCorrection: string;
}

export interface ReviewSuggestion {
    id: string;
    title: string;
    summary: string;
    autoFix: false;
}

export interface PendingReviewState {
    /** Unprocessed AI review comments (boilerplate already stripped). */
    unprocessedComments: AIReviewComment[];
    /** The most recent valid review score (1–10), or null if none found. */
    latestScore: number | null;
    /** Whether any unprocessed actionable findings exist. */
    hasPendingReview: boolean;
}

interface PRComment {
    id: number;
    body: string | null;
    user: { login: string; type?: string };
    created_at: string;
}

export interface GatherOptions {
    repoOwner: string;
    repoName: string;
    pullRequestNumber: number;
    redisClient: Redis;
    correlatedLogger: Logger;
    /** Maximum age of review comments to include, in milliseconds. Defaults to 7 days. */
    maxAgeMs?: number;
}

/** Default max age: 7 days */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * RegExp matching a "Score: N/10" line in the review body.
 * Accepts optional whitespace and the integer 1–10.
 */
const SCORE_RE = /Score:\s*(\d{1,2})\s*\/\s*10/;

/**
 * RegExp matching the error variant of the AI review marker.
 * Uses the structured marker format rather than a brittle substring check.
 */
const ERROR_MARKER_RE = /<!-- propr:ai-review [^>]*error="true"[^>]* -->/;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(body: string, heading: string): string {
    const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}(?:[ \\t]+.*)?$`, 'im');
    const match = headingRe.exec(body);
    if (!match) return '';
    const contentStart = match.index + match[0].length;
    const rest = body.slice(contentStart);
    const nextHeading = /^##\s+/m.exec(rest);
    return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function extractRecordFields(block: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
        const bold = line.match(/^[-*]\s+\*\*([^*]+)\*\*\s*(.*)$/);
        const plain = line.match(/^[-*]\s+([A-Za-z][A-Za-z0-9 -]*):\s*(.*)$/);
        const rawKey = bold?.[1] ?? plain?.[1];
        if (!rawKey) continue;
        const key = rawKey.replace(/:$/, '').replace(/[\s-]/g, '').toLowerCase();
        const value = (bold?.[2] ?? plain?.[2] ?? '').replace(/^:\s*/, '').trim();
        fields.set(key, value);
    }
    return fields;
}

interface MarkdownRecord {
    id: string;
    title: string;
    body: string;
}

function extractMarkdownRecords(section: string, prefix: 'F' | 'S'): MarkdownRecord[] {
    const headingRe = new RegExp(`^###[ \\t]+(${prefix}\\d+)[ \\t]*(?::|[-—])[ \\t]*(.+)$`, 'gim');
    const matches = [...section.matchAll(headingRe)];
    return matches.map((match, index) => ({
        id: match[1].toUpperCase(),
        title: match[2].trim(),
        body: section.slice(
            (match.index ?? 0) + match[0].length,
            matches[index + 1]?.index ?? section.length,
        ).trim(),
    }));
}

/**
 * Parse only blocker records that satisfy the complete review-to-fix contract.
 * Incomplete or non-affirmative records are deliberately excluded from
 * automation even if they appeared under the actionable heading.
 */
export function extractActionableFindings(body: string): ActionableFinding[] {
    const section = extractMarkdownSection(body, 'Actionable Findings');
    const findings: ActionableFinding[] = [];
    for (const record of extractMarkdownRecords(section, 'F')) {
        const fields = extractRecordFields(record.body);
        const violatedRequirement = fields.get('violatedrequirement') ?? '';
        const evidence = fields.get('evidence') ?? '';
        const introducedByPR = fields.get('introducedbypr') ?? '';
        const requiredForMerge = fields.get('requiredformerge') ?? '';
        const minimumCorrection = fields.get('minimumcorrection') ?? '';
        const introducedByPRExplanation = introducedByPR.replace(/^true\b\s*(?:[-—:]\s*)?/i, '').trim();
        if (!violatedRequirement || !evidence || !introducedByPRExplanation || !minimumCorrection) continue;
        if (!/^true\b/i.test(introducedByPR) || !/^true\b/i.test(requiredForMerge)) continue;
        findings.push({
            id: record.id,
            title: record.title,
            violatedRequirement,
            evidence,
            introducedByPR: true,
            introducedByPRExplanation,
            requiredForMerge: true,
            minimumCorrection,
        });
    }
    return findings;
}

/** Parse public suggestion records while forcing their automation policy off. */
export function extractReviewSuggestions(body: string): ReviewSuggestion[] {
    const section = extractMarkdownSection(body, 'Suggestions and Follow-ups');
    return extractMarkdownRecords(section, 'S').map(record => {
        const fields = extractRecordFields(record.body);
        return {
            id: record.id,
            title: record.title,
            summary: fields.get('summary') || record.title,
            autoFix: false,
        };
    });
}

export function formatActionableFindings(findings: ActionableFinding[]): string {
    return findings.map(finding => [
        `### ${finding.id}: ${finding.title}`,
        `- **violatedRequirement:** ${finding.violatedRequirement}`,
        `- **evidence:** ${finding.evidence}`,
        `- **introducedByPR:** true — ${finding.introducedByPRExplanation}`,
        `- **requiredForMerge:** true`,
        `- **minimumCorrection:** ${finding.minimumCorrection}`,
    ].join('\n')).join('\n\n');
}

/**
 * Strip machine-readable markers and the /fix instruction tip from a review
 * comment body so the implementation prompt only contains actionable content.
 */
export function stripReviewBoilerplate(body: string): string {
    // Remove the HTML marker comment
    let cleaned = body.replace(/\n?<!-- propr:ai-review [^>]* -->/g, '');
    // Remove the /fix tip blockquote section
    cleaned = cleaned.replace(/\n?---\n> 💡 \*\*(?:Tip|Next step):\*\* Comment `\/fix`[^\n]*(?:\n>[^\n]*)*/g, '');
    return cleaned.trimEnd();
}

function getProcessedReviewFindingsKey(repoOwner: string, repoName: string, pullRequestNumber: number): string {
    return `${getProcessedReviewCommentsKey(repoOwner, repoName, pullRequestNumber)}:findings`;
}

function findingConsumptionKey(commentId: number, kind: 'F' | 'S', findingId: string): string {
    return `${commentId}:${kind}:${findingId.toUpperCase()}`;
}

/**
 * Scan all PR comments and return recent AI review comments that have not yet
 * been processed by a prior /fix run.
 *
 * "Recent" is defined by `maxAgeMs` (default 7 days) — older review comments
 * are excluded to keep the implementation prompt focused on current feedback.
 */
export async function gatherUnprocessedReviewComments(
    allComments: PRComment[],
    options: GatherOptions,
): Promise<AIReviewComment[]> {
    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger, maxAgeMs = DEFAULT_MAX_AGE_MS } = options;

    const cutoff = Date.now() - maxAgeMs;

    // 1. Filter to AI review comments using the structured marker.
    const aiReviewComments = allComments.filter(c => c.body && isReviewComment(c.body));

    if (aiReviewComments.length === 0) {
        correlatedLogger.debug({ pullRequestNumber }, 'No AI review comments found on PR');
        return [];
    }

    // 2. Load the set of already-processed review comment IDs from Redis.
    const redisKey = getProcessedReviewCommentsKey(repoOwner, repoName, pullRequestNumber);
    let processedIds: Set<string>;
    let processedFindings: Set<string>;
    try {
        const [members, findingMembers] = await Promise.all([
            redisClient.smembers(redisKey),
            redisClient.smembers(getProcessedReviewFindingsKey(repoOwner, repoName, pullRequestNumber)),
        ]);
        processedIds = new Set(members);
        processedFindings = new Set(findingMembers);
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to load processed review findings from Redis, treating all as unprocessed');
        processedIds = new Set();
        processedFindings = new Set();
    }

    // 3. Return only recent comments not yet processed.
    const unprocessed: AIReviewComment[] = [];
    for (const comment of aiReviewComments) {
        if (processedIds.has(String(comment.id))) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id }, 'AI review comment already processed, skipping');
            continue;
        }
        // Skip error review comments using the structured marker regex
        if (ERROR_MARKER_RE.test(comment.body!)) {
            continue;
        }
        // Skip comments older than the recency cutoff
        if (new Date(comment.created_at).getTime() < cutoff) {
            correlatedLogger.debug({ pullRequestNumber, commentId: comment.id }, 'AI review comment too old, skipping');
            continue;
        }
        const cleanedBody = stripReviewBoilerplate(comment.body!);
        const actionableFindings = extractActionableFindings(cleanedBody).filter(finding =>
            !processedFindings.has(findingConsumptionKey(comment.id, 'F', finding.id)),
        );
        const suggestions = extractReviewSuggestions(cleanedBody).filter(suggestion =>
            !processedFindings.has(findingConsumptionKey(comment.id, 'S', suggestion.id)),
        );
        unprocessed.push({
            id: comment.id,
            body: formatActionableFindings(actionableFindings),
            author: comment.user.login,
            created_at: comment.created_at,
            actionableFindings,
            suggestions,
            score: extractReviewScore(cleanedBody),
        });
    }

    correlatedLogger.info(
        { pullRequestNumber, totalReviewComments: aiReviewComments.length, unprocessedCount: unprocessed.length },
        'Gathered unprocessed AI review comments for /fix',
    );

    return unprocessed;
}

/**
 * Extract a numeric review score from a review comment body.
 * Looks for the "Score: N/10" pattern emitted by the review prompt.
 * Returns the integer score (1–10) or null if no valid score is found.
 */
export function extractReviewScore(body: string): number | null {
    const cleaned = stripReviewBoilerplate(body);
    const match = cleaned.match(SCORE_RE);
    if (!match) return null;
    const score = parseInt(match[1], 10);
    if (score < 1 || score > 10) return null;
    return score;
}

/**
 * Return the pending review state for orchestration (e.g. /ultrafix).
 *
 * This is a convenience wrapper around `gatherUnprocessedReviewComments` that
 * also extracts the latest usable review score from the unprocessed comments.
 * The most recent comment (by `created_at`) with a valid score wins.
 */
export async function getPendingReviewState(
    allComments: PRComment[],
    options: GatherOptions,
): Promise<PendingReviewState> {
    const unprocessedComments = await gatherUnprocessedReviewComments(allComments, options);

    // Walk comments newest-first to find the most recent valid score.
    let latestScore: number | null = null;
    const sorted = [...unprocessedComments].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    for (const comment of sorted) {
        const score = comment.score;
        if (score !== null) {
            latestScore = score;
            break;
        }
    }

    return {
        unprocessedComments,
        latestScore,
        hasPendingReview: unprocessedComments.some(comment => comment.actionableFindings.length > 0),
    };
}

/**
 * Mark individual selected records as consumed. This preserves unselected F#
 * blockers in the same review for a later `/fix F#` invocation.
 */
export async function markReviewFindingsProcessed(
    comments: AIReviewComment[],
    options: Pick<GatherOptions, 'repoOwner' | 'repoName' | 'pullRequestNumber' | 'redisClient' | 'correlatedLogger'>,
): Promise<void> {
    const keys = comments.flatMap(comment => [
        ...comment.actionableFindings.map(finding => findingConsumptionKey(comment.id, 'F', finding.id)),
        ...comment.suggestions.map(suggestion => findingConsumptionKey(comment.id, 'S', suggestion.id)),
    ]);
    if (keys.length === 0) return;

    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = options;
    const redisKey = getProcessedReviewFindingsKey(repoOwner, repoName, pullRequestNumber);
    const TTL_SECONDS = 30 * 24 * 3600;
    try {
        await redisClient.sadd(redisKey, ...keys);
        await redisClient.expire(redisKey, TTL_SECONDS);
        correlatedLogger.info({ pullRequestNumber, findingCount: keys.length }, 'Marked selected AI review findings as processed');
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to mark selected review findings as processed in Redis');
    }
}

/**
 * Mark the given review comment IDs as processed so subsequent /fix runs skip them.
 * Uses a Redis set with a 30-day TTL.
 */
export async function markReviewCommentsProcessed(
    commentIds: number[],
    options: Pick<GatherOptions, 'repoOwner' | 'repoName' | 'pullRequestNumber' | 'redisClient' | 'correlatedLogger'>,
): Promise<void> {
    if (commentIds.length === 0) return;

    const { repoOwner, repoName, pullRequestNumber, redisClient, correlatedLogger } = options;
    const redisKey = getProcessedReviewCommentsKey(repoOwner, repoName, pullRequestNumber);
    const TTL_SECONDS = 30 * 24 * 3600; // 30 days

    try {
        await redisClient.sadd(redisKey, ...commentIds.map(String));
        await redisClient.expire(redisKey, TTL_SECONDS);
        correlatedLogger.info(
            { pullRequestNumber, count: commentIds.length, commentIds },
            'Marked AI review comments as processed',
        );
    } catch (err) {
        correlatedLogger.warn({ error: (err as Error).message }, 'Failed to mark review comments as processed in Redis');
    }
}
