import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { createWorker, ANALYSIS_QUEUE_NAME, issueQueue } from '@propr/core';
import type { AnalysisJobData, JobResult, CommentJobData, UnprocessedComment } from '@propr/core';
import { logger } from '@propr/core';
import { generateCorrelationId } from '@propr/core';
import { db } from '@propr/core';
import { getExecutionAnalysis } from '@propr/core';
import { loadSettings, loadAutoFollowupScoreThreshold } from '@propr/core';
import { resolveModelAlias } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';

process.on('uncaughtException', (error: Error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception in analysis worker');
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    logger.fatal({ reason }, 'Unhandled rejection in analysis worker');
    process.exit(1);
});

interface AnalysisResult extends JobResult {
    success: boolean;
}

interface AnalysisReport {
    generatedAt: string;
    modelUsed: string;
    report: string;
}

interface ParsedAnalysisReport {
    implementation_critique_score?: number;
    implementation_critique?: string;
    recommendations?: string[];
    efficiency_score?: number;
    efficiency_notes?: string;
    prompt_quality_score?: number;
    prompt_improvements?: string;
}

interface TaskRecord {
    task_id: string;
    repository: string;
    issue_number: number;
    pr_number?: number;
}

/**
 * Parse the implementation_critique_score from the analysis report.
 * The report may be a JSON string or already parsed.
 */
function parseAnalysisReport(report: string): ParsedAnalysisReport | null {
    try {
        // The report field contains the LLM's JSON response as a string
        return JSON.parse(report);
    } catch {
        return null;
    }
}

/**
 * Generate a follow-up comment based on the analysis critique.
 */
function generateFollowupComment(parsedReport: ParsedAnalysisReport): string {
    const score = parsedReport.implementation_critique_score ?? 'N/A';
    const critique = parsedReport.implementation_critique || 'No critique available.';
    const recommendations = parsedReport.recommendations || [];

    let comment = `## Auto-Followup: Implementation Review\n\n`;
    comment += `**Implementation Critique Score:** ${score}/10\n\n`;
    comment += `### Critique\n${critique}\n\n`;

    if (recommendations.length > 0) {
        comment += `### Recommendations\n`;
        recommendations.forEach((rec, index) => {
            comment += `${index + 1}. ${rec}\n`;
        });
        comment += '\n';
    }

    comment += `---\n`;
    comment += `*This automated follow-up was triggered because the implementation critique score (${score}) was at or below the configured threshold. Please address the issues identified above.*\n\n`;
    comment += `**ProPR** - Please review and address the critique above.`;

    return comment;
}

/**
 * Check the implementation critique score and trigger auto-followup if needed.
 * Posts a comment to the related issue/PR and queues it for processing.
 */
async function checkAndTriggerAutoFollowup(
    analysisReport: AnalysisReport,
    executionId: string,
    correlationId: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<void> {
    try {
        // Load the auto-followup threshold
        const threshold = await loadAutoFollowupScoreThreshold();

        // If threshold is 0, the feature is disabled
        if (threshold === 0) {
            correlatedLogger.debug({ executionId, threshold }, 'Auto-followup is disabled (threshold = 0)');
            return;
        }

        // Parse the analysis report to get the score
        const parsedReport = parseAnalysisReport(analysisReport.report);
        if (!parsedReport) {
            correlatedLogger.warn({ executionId }, 'Failed to parse analysis report for auto-followup check');
            return;
        }

        const score = parsedReport.implementation_critique_score;
        if (score === undefined || score === null) {
            correlatedLogger.warn({ executionId }, 'No implementation_critique_score found in analysis report');
            return;
        }

        correlatedLogger.info({
            executionId,
            score,
            threshold
        }, 'Checking auto-followup threshold');

        // Check if score is at or below threshold
        if (score > threshold) {
            correlatedLogger.info({
                executionId,
                score,
                threshold
            }, 'Score above threshold, no auto-followup needed');
            return;
        }

        correlatedLogger.info({
            executionId,
            score,
            threshold
        }, 'Score at or below threshold, triggering auto-followup');

        // Get the task information from the execution
        if (!db) {
            correlatedLogger.error({ executionId }, 'Database not available for auto-followup');
            return;
        }

        const execution = await db('llm_executions')
            .where({ execution_id: executionId })
            .first();

        if (!execution?.task_id) {
            correlatedLogger.error({ executionId }, 'No task_id found for execution');
            return;
        }

        const task: TaskRecord | undefined = await db('tasks')
            .where({ task_id: execution.task_id })
            .first();

        if (!task) {
            correlatedLogger.error({ executionId, taskId: execution.task_id }, 'No task found for auto-followup');
            return;
        }

        const [repoOwner, repoName] = task.repository.split('/');
        // Use PR number if available, otherwise fall back to issue number
        const targetNumber = task.pr_number || task.issue_number;

        // Generate the follow-up comment
        const commentBody = generateFollowupComment(parsedReport);

        // Post the comment to GitHub
        const octokit = await getAuthenticatedOctokit();
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: repoOwner,
            repo: repoName,
            issue_number: targetNumber,
            body: commentBody
        });

        correlatedLogger.info({
            executionId,
            repository: task.repository,
            targetNumber,
            score,
            threshold
        }, 'Posted auto-followup comment to GitHub');

        // Queue as PR comment job - same as user follow-up comments
        // The webhook filters bot comments, so we queue directly
        const followupCorrelationId = generateCorrelationId();
        const unprocessedComment: UnprocessedComment = {
            id: 0,
            body: commentBody,
            author: 'system',
            type: 'issue'
        };
        const jobData: CommentJobData = {
            pullRequestNumber: targetNumber,
            comments: [unprocessedComment],
            repoOwner,
            repoName,
            correlationId: followupCorrelationId,
            title: `Auto-followup for PR #${targetNumber}`,
            subtitle: `Triggered by low implementation score (${score}/${threshold})`
        };

        await issueQueue.add('processPullRequestComment', jobData, {
            priority: 5,
            removeOnComplete: true
        });

        correlatedLogger.info({
            executionId,
            repository: task.repository,
            targetNumber,
            followupCorrelationId,
            score,
            threshold
        }, 'Queued auto-followup as PR comment job');

    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({
            executionId,
            error: err.message,
            stack: err.stack
        }, 'Failed to trigger auto-followup');
        // Don't throw - auto-followup failure shouldn't fail the analysis job
    }
}

async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<AnalysisResult> {
    const { executionId, sessionId, correlationId } = job.data;
    const correlatedLogger = logger.withCorrelation(correlationId);
    correlatedLogger.info({ executionId }, 'Starting execution analysis job...');

    try {
        const settings = await loadSettings();
        const configuredModel = (settings.analysis_model_fast as string) || 'haiku';
        const fastModel = resolveModelAlias(configuredModel);

        const analysisReport = await getExecutionAnalysis({
            executionId,
            sessionId,
            correlationId,
            model: fastModel,
        });

        if (db) {
            await db('llm_executions')
                .where({ execution_id: executionId })
                .update({ analysis_report: JSON.stringify(analysisReport) });
        }

        correlatedLogger.info({ executionId }, 'Execution analysis complete and saved.');

        // Check for auto-followup based on implementation critique score
        await checkAndTriggerAutoFollowup(analysisReport as AnalysisReport, executionId, correlationId, correlatedLogger);

        return { status: 'completed', success: true };
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ executionId, error: err.message }, 'Execution analysis job failed');
        throw error;
    }
}

async function startAnalysisWorker(): Promise<Worker<AnalysisJobData, AnalysisResult>> {
    const workerId = `analysis-worker:${generateCorrelationId()}`;

    logger.info({
        queue: ANALYSIS_QUEUE_NAME,
        concurrency: 2,
        workerId
    }, 'Starting Analysis Worker...');

    const worker = await createWorker<AnalysisJobData, AnalysisResult>(ANALYSIS_QUEUE_NAME, processAnalysisJob, { concurrency: 2 });

    process.on('SIGINT', async () => {
        logger.info('Analysis Worker received SIGINT, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('Analysis Worker received SIGTERM, shutting down gracefully...');
        await worker.close();
        process.exit(0);
    });

    return worker;
}

export { processAnalysisJob, startAnalysisWorker };

if (import.meta.url === `file://${process.argv[1]}`) {
    startAnalysisWorker().catch(err => {
        logger.error({ error: err.message }, 'Failed to start analysis worker');
        process.exit(1);
    });
}
