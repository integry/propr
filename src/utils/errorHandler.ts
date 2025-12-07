import logger from './logger.ts';
import { getAuthenticatedOctokit } from '../auth/githubAuth.ts';

/**
 * Error categories for classification
 */
export const ErrorCategories = {
    GITHUB_API: 'github_api',
    CLAUDE_EXECUTION: 'claude_execution',
    GIT_OPERATION: 'git_operation',
    DOCKER_OPERATION: 'docker_operation',
    REDIS_OPERATION: 'redis_operation',
    POST_PROCESSING: 'post_processing',
    AUTHENTICATION: 'authentication',
    NETWORK: 'network',
    VALIDATION: 'validation',
    UNKNOWN: 'unknown'
} as const;

export type ErrorCategory = typeof ErrorCategories[keyof typeof ErrorCategories];

export interface ErrorDetails {
    category: ErrorCategory;
    message: string;
    stack?: string;
    code?: string;
    status?: number;
    context: string;
    timestamp: string;
}

export interface ErrorHandlerOptions {
    correlationId?: string;
    exit?: boolean;
    issueRef?: IssueRef | null;
}

export interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
    triggeringLabel?: string;
}

interface ErrorLike {
    message?: string;
    code?: string;
    status?: number;
    stack?: string;
}

/**
 * Generates a failure label based on triggering label and error category
 * @param triggeringLabel - The primary label that triggered processing
 * @param errorCategory - The error category
 * @returns The failure label
 */
function generateFailureLabel(triggeringLabel: string, errorCategory: ErrorCategory): string {
    const categorySuffix: Record<ErrorCategory, string> = {
        [ErrorCategories.GITHUB_API]: 'github-api',
        [ErrorCategories.CLAUDE_EXECUTION]: 'claude',
        [ErrorCategories.GIT_OPERATION]: 'git',
        [ErrorCategories.DOCKER_OPERATION]: 'docker',
        [ErrorCategories.REDIS_OPERATION]: 'redis',
        [ErrorCategories.POST_PROCESSING]: 'post-processing',
        [ErrorCategories.AUTHENTICATION]: 'auth',
        [ErrorCategories.NETWORK]: 'network',
        [ErrorCategories.VALIDATION]: 'validation',
        [ErrorCategories.UNKNOWN]: ''
    };

    const suffix = categorySuffix[errorCategory] ?? '';
    return suffix ? `${triggeringLabel}-failed-${suffix}` : `${triggeringLabel}-failed`;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);

const MESSAGE_CATEGORY_MAP: [string, ErrorCategory][] = [
    ['docker', ErrorCategories.DOCKER_OPERATION],
    ['claude', ErrorCategories.CLAUDE_EXECUTION],
    ['git', ErrorCategories.GIT_OPERATION],
    ['repository', ErrorCategories.GIT_OPERATION],
    ['redis', ErrorCategories.REDIS_OPERATION],
    ['github', ErrorCategories.GITHUB_API],
    ['api', ErrorCategories.GITHUB_API],
    ['auth', ErrorCategories.AUTHENTICATION],
];

const CONTEXT_CATEGORY_MAP: [string, ErrorCategory][] = [
    ['claude', ErrorCategories.CLAUDE_EXECUTION],
    ['git', ErrorCategories.GIT_OPERATION],
    ['github', ErrorCategories.GITHUB_API],
    ['api', ErrorCategories.GITHUB_API],
    ['post', ErrorCategories.POST_PROCESSING],
];

function categorizeByErrorCode(error: ErrorLike): ErrorCategory | null {
    if (!error.code) return null;
    if (NETWORK_CODES.has(error.code)) return ErrorCategories.NETWORK;
    if (error.code.includes('GIT')) return ErrorCategories.GIT_OPERATION;
    return null;
}

function categorizeByHttpStatus(error: ErrorLike): ErrorCategory | null {
    if (!error.status) return null;
    if (error.status === 401 || error.status === 403) return ErrorCategories.AUTHENTICATION;
    if (error.status >= 400 && error.status < 500) return ErrorCategories.GITHUB_API;
    return null;
}

function categorizeByText(text: string, categoryMap: [string, ErrorCategory][]): ErrorCategory | null {
    const textLower = text.toLowerCase();
    for (const [keyword, category] of categoryMap) {
        if (textLower.includes(keyword)) return category;
    }
    return null;
}

/**
 * Categorizes an error based on its properties
 * @param error - The error to categorize
 * @param context - Context where the error occurred
 * @returns Error category
 */
export function categorizeError(error: Error | unknown, context: string = ''): ErrorCategory {
    const err = error as ErrorLike;
    return categorizeByErrorCode(err)
        ?? categorizeByHttpStatus(err)
        ?? categorizeByText(err.message ?? '', MESSAGE_CATEGORY_MAP)
        ?? categorizeByText(context, CONTEXT_CATEGORY_MAP)
        ?? ErrorCategories.UNKNOWN;
}

/**
 * Enhanced error handler for async operations with correlation ID support
 * @param error - The error object
 * @param context - Context where the error occurred
 * @param options - Additional options
 * @returns Error details including category
 */
export function handleError(error: Error | unknown, context: string, options: ErrorHandlerOptions = {}): ErrorDetails {
    const {
        correlationId,
        exit = false,
        issueRef = null
    } = options;

    const err = error as ErrorLike;
    const category = categorizeError(error, context);
    const correlatedLogger = correlationId ?
        logger.withCorrelation(correlationId) : logger;

    const errorDetails: ErrorDetails = {
        category,
        message: err.message ?? 'Unknown error',
        stack: err.stack,
        code: err.code,
        status: err.status,
        context,
        timestamp: new Date().toISOString()
    };

    correlatedLogger.error({
        msg: `Error in ${context}`,
        error: errorDetails,
        context,
        category
    });

    if (issueRef) {
        handleIssueFailure(issueRef, category, error as Error, correlationId).catch(tagError => {
            logger.warn({
                correlationId,
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                error: (tagError as Error).message
            }, 'Failed to update issue failure tags');
        });
    }

    if (exit) {
        process.exit(1);
    }

    return errorDetails;
}

/**
 * Handles issue failure by updating GitHub labels
 * @param issueRef - GitHub issue reference
 * @param errorCategory - Categorized error type
 * @param originalError - The original error
 * @param correlationId - Correlation ID
 */
async function handleIssueFailure(
    issueRef: IssueRef,
    errorCategory: ErrorCategory,
    originalError: Error,
    correlationId?: string
): Promise<void> {
    const correlatedLogger = correlationId ?
        logger.withCorrelation(correlationId) : logger;

    try {
        const octokit = await getAuthenticatedOctokit();

        const triggeringLabel = issueRef.triggeringLabel ?? process.env.AI_PRIMARY_TAG ?? 'AI';
        const processingTag = `${triggeringLabel}-processing`;
        const failureLabel = generateFailureLabel(triggeringLabel, errorCategory);

        try {
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                issue_number: issueRef.number,
                name: processingTag,
            });
        } catch (removeError) {
            correlatedLogger.debug({
                issueNumber: issueRef.number,
                repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
                error: (removeError as Error).message
            }, 'Could not remove processing tag (may not exist)');
        }

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            labels: [failureLabel],
        });

        const failureComment = `🚨 **AI Processing Failed**

**Error Category:** ${errorCategory}
**Error Message:** ${originalError.message}
**Correlation ID:** ${correlationId ?? 'unknown'}
**Timestamp:** ${new Date().toISOString()}

This issue has been marked as failed and moved to the Dead Letter Queue for manual investigation.

---
*This is an automated message from the Claude-powered GitHub Issue Processor*`;

        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            issue_number: issueRef.number,
            body: failureComment,
        });

        correlatedLogger.info({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            failureLabel,
            errorCategory,
            triggeringLabel
        }, 'Updated issue with failure tags and comment');

    } catch (tagError) {
        correlatedLogger.error({
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            error: (tagError as Error).message,
            originalError: originalError.message
        }, 'Failed to update issue failure tags');
        throw tagError;
    }
}

/**
 * Wraps an async function with enhanced error handling
 * @param fn - The async function to wrap
 * @param context - Context for error logging
 * @param options - Additional options
 * @returns Wrapped function
 */
export function withErrorHandling<T extends (...args: unknown[]) => Promise<unknown>>(
    fn: T,
    context: string,
    options: ErrorHandlerOptions = {}
): (...args: Parameters<T>) => Promise<ReturnType<T>> {
    return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
        try {
            return await fn(...args) as ReturnType<T>;
        } catch (error) {
            handleError(error, context, options);
            throw error;
        }
    };
}

/**
 * Creates a safe async function that doesn't throw
 * @param fn - The async function to wrap
 * @param defaultValue - Default value to return on error
 * @param options - Additional options
 * @returns Wrapped function
 */
export function safeAsync<T, Args extends unknown[]>(
    fn: (...args: Args) => Promise<T>,
    defaultValue: T | null = null,
    options: { correlationId?: string; context?: string } = {}
): (...args: Args) => Promise<T | null> {
    return async (...args: Args): Promise<T | null> => {
        try {
            return await fn(...args);
        } catch (error) {
            const correlatedLogger = options.correlationId ?
                logger.withCorrelation(options.correlationId) : logger;

            correlatedLogger.error('Safe async operation failed', {
                error: (error as Error).message,
                context: options.context ?? 'safe_async'
            });
            return defaultValue;
        }
    };
}

interface IdempotentArg {
    correlationId?: string;
}

/**
 * Creates an idempotent operation wrapper
 * @param fn - The async function to make idempotent
 * @param checkFn - Function to check if operation already completed
 * @param context - Context for logging
 * @returns Idempotent wrapped function
 */
export function makeIdempotent<T, Args extends unknown[]>(
    fn: (...args: Args) => Promise<T>,
    checkFn: (...args: Args) => Promise<T | boolean | null>,
    context: string = 'operation'
): (...args: Args) => Promise<T | boolean | null> {
    return async (...args: Args): Promise<T | boolean | null> => {
        const correlationId = (args.find(arg => (arg as IdempotentArg)?.correlationId) as IdempotentArg | undefined)?.correlationId;
        const correlatedLogger = correlationId ?
            logger.withCorrelation(correlationId) : logger;

        try {
            const alreadyCompleted = await checkFn(...args);
            if (alreadyCompleted) {
                correlatedLogger.info({
                    context,
                    status: 'already_completed'
                }, `${context} already completed, skipping`);
                return alreadyCompleted;
            }

            return await fn(...args);

        } catch (error) {
            handleError(error, `idempotent_${context}`, { correlationId });
            throw error;
        }
    };
}
