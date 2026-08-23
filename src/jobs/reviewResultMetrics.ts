import { recordLLMMetrics, type AnalysisResult } from '@propr/core';

interface ReviewMetricResult {
    assignment: { model: string };
    analysisResult: AnalysisResult;
    error?: string;
    prompt?: string;
}

interface ReviewMetricIssueRef {
    pullRequestNumber: number;
    repoOwner: string;
    repoName: string;
    correlationId: string;
    taskId: string;
}

export async function recordReviewMetrics(
    reviewResults: ReviewMetricResult[],
    issueRef: ReviewMetricIssueRef,
): Promise<void> {
    const { pullRequestNumber, repoOwner, repoName, correlationId, taskId } = issueRef;
    for (const result of reviewResults) {
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
