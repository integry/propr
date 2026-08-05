import { hashTaskAttemptToken, recordLLMMetrics, type AnalysisResult } from '@propr/core';
import type { Redis } from 'ioredis';
import { persistPRCommentRemoteOutcome } from './prCommentRemoteOutcome.js';

export interface ReviewAssignment {
    agentAlias: string;
    model: string;
    label: string;
}

export interface ReviewResult {
    assignment: ReviewAssignment;
    analysisResult: AnalysisResult;
    commentUrl?: string;
    error?: string;
    prompt?: string;
    recovered?: boolean;
}

interface PublishedReviewComment {
    body: string | null;
    html_url?: string;
    user: { type?: string };
}

export function buildReviewAssignmentMarker(
    taskId: string,
    assignment: ReviewAssignment,
    assignmentIndex: number,
    status: 'success' | 'error',
): string {
    const key = Buffer.from(
        `${taskId}\0${assignmentIndex}\0${assignment.agentAlias}\0${assignment.model}\0${assignment.label}`,
    ).toString('base64url');
    return `<!-- propr:review-assignment key=${key} status=${status} -->`;
}

export function recoverPublishedReview(
    comments: PublishedReviewComment[],
    taskId: string,
    assignment: ReviewAssignment,
    assignmentIndex: number,
): ReviewResult | null {
    for (const status of ['success', 'error'] as const) {
        const marker = buildReviewAssignmentMarker(taskId, assignment, assignmentIndex, status);
        const comment = comments.find(candidate => (
            candidate.user.type === 'Bot' && candidate.body?.includes(marker)
        ));
        if (!comment) continue;
        const success = status === 'success';
        return {
            assignment,
            analysisResult: {
                response: '',
                modelUsed: assignment.model,
                executionTimeMs: 0,
                success,
                ...(!success && { error: 'Recovered previously published review error' }),
            },
            commentUrl: comment.html_url,
            ...(!success && { error: 'Recovered previously published review error' }),
            recovered: true,
        };
    }
    return null;
}

export async function recordReviewMetrics(
    reviewResults: ReviewResult[],
    issueRef: { pullRequestNumber: number; repoOwner: string; repoName: string; correlationId: string; taskId: string },
): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, correlationId, taskId } = issueRef;
    for (const result of reviewResults) {
        if (result.recovered) continue;
        const timestamp = new Date().toISOString();
        const conversationLog = [
            { type: 'user', timestamp, message: { content: [{ type: 'text', text: result.prompt || 'Review prompt not captured' }] } },
            { type: 'assistant', timestamp, message: { content: [{ type: 'text', text: result.analysisResult.response || result.error || 'No response' }] } },
        ];

        const metricsResult: Parameters<typeof recordLLMMetrics>[0] = {
            success: result.analysisResult.success,
            model: result.analysisResult.modelUsed || result.assignment.model,
            executionTime: result.analysisResult.executionTimeMs,
            sessionId: result.analysisResult.sessionId || null,
            tokenUsage: result.analysisResult.tokenUsage,
            conversationLog,
            ...(result.analysisResult.success ? {} : { error: result.analysisResult.error || result.error }),
        };
        await recordLLMMetrics(
            metricsResult,
            { number: pullRequestNumber, repoOwner, repoName },
            { jobType: 'pr_review', correlationId, taskId, executionType: 'pr-review' },
        );
    }
}

export async function persistReviewRemoteOutcome(
    redisClient: Redis,
    options: {
        taskId: string;
        repoOwner: string;
        repoName: string;
        pullRequestNumber: number;
        prProcessingLockToken: string;
        reviewsPosted: number;
        reviewsFailed: number;
    },
) {
    const result = {
        status: 'complete',
        pullRequestNumber: options.pullRequestNumber,
        reviewsPosted: options.reviewsPosted,
        reviewsFailed: options.reviewsFailed,
        prProcessingAttemptGeneration: hashTaskAttemptToken(options.prProcessingLockToken),
    };
    await persistPRCommentRemoteOutcome(redisClient, {
        taskId: options.taskId,
        lockKey: `lock:pr:${options.repoOwner}:${options.repoName}:${options.pullRequestNumber}`,
        lockToken: options.prProcessingLockToken,
        result,
    });
    return result;
}
