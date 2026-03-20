import logger from './logger.js';

export interface RetryConfig {
    maxAttempts: number;
    baseDelay: number;
    maxDelay: number;
    exponentialBase: number;
    jitter: boolean;
    retryableErrors: string[];
}

export interface RetryOptions extends Partial<RetryConfig> {
    correlationId?: string;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    exponentialBase: 2,
    jitter: true,
    retryableErrors: [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
        'NETWORK_ERROR', 'API_RATE_LIMIT', 'TEMPORARY_FAILURE'
    ]
};

interface ErrorLike {
    code?: string;
    status?: number;
    message?: string;
}

/**
 * Calculates delay for exponential backoff with optional jitter
 * @param attempt - Current attempt number (0-based)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
    const exponentialDelay = config.baseDelay * Math.pow(config.exponentialBase, attempt);
    let delay = Math.min(exponentialDelay, config.maxDelay);

    if (config.jitter) {
        const jitterAmount = delay * 0.25;
        delay += (Math.random() - 0.5) * 2 * jitterAmount;
    }

    return Math.max(delay, 0);
}

/**
 * Determines if an error is retryable
 * @param error - The error to check
 * @param config - Retry configuration
 * @returns Whether the error is retryable
 */
function isRetryableError(error: Error | unknown, config: RetryConfig): boolean {
    const err = error as ErrorLike;

    if (err.code && config.retryableErrors.includes(err.code)) {
        return true;
    }

    // Check status codes - but don't short-circuit, also check message patterns below
    if (err.status) {
        const retryableStatuses = [429, 500, 502, 503, 504];
        if (retryableStatuses.includes(err.status)) {
            return true;
        }
    }

    const retryablePatterns = [
        /rate limit/i,
        /timeout/i,
        /network/i,
        /connection/i,
        /temporary/i,
        /try again/i,
        /authentication failed/i,
        /invalid username or token/i,
        /credentials/i,
        /server.*unavailable/i,
        /no server.*available/i,
        /service unavailable/i,
        /bad gateway/i,
        /could not resolve to a node/i, // GitHub API propagation delay
        /unprocessable.*node/i
    ];

    const errorMessage = err.message ?? '';
    const errorString = error?.toString() ?? '';

    return retryablePatterns.some(pattern =>
        pattern.test(errorMessage) || pattern.test(errorString)
    );
}

/**
 * Executes a function with exponential backoff retry logic
 * @param fn - The async function to retry
 * @param options - Retry configuration options
 * @param context - Context for logging (operation name)
 * @returns Result of the function
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
    context: string = 'operation'
): Promise<T> {
    const config: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...options };
    const correlationId = options.correlationId ?? 'unknown';

    let lastError: Error | unknown;

    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
        try {
            logger.debug({
                correlationId,
                context,
                attempt: attempt + 1,
                maxAttempts: config.maxAttempts
            }, `Attempting ${context}`);

            const result = await fn();

            if (attempt > 0) {
                logger.info({
                    correlationId,
                    context,
                    attempt: attempt + 1,
                    totalAttempts: attempt + 1
                }, `${context} succeeded after retry`);
            }

            return result;

        } catch (error) {
            lastError = error;
            const err = error as ErrorLike;

            logger.warn({
                correlationId,
                context,
                attempt: attempt + 1,
                maxAttempts: config.maxAttempts,
                error: {
                    message: err.message,
                    code: err.code,
                    status: err.status
                }
            }, `${context} failed on attempt ${attempt + 1}`);

            if (attempt === config.maxAttempts - 1) {
                logger.error({
                    correlationId,
                    context,
                    totalAttempts: config.maxAttempts,
                    finalError: {
                        message: err.message,
                        code: err.code,
                        status: err.status,
                        stack: (error as Error).stack
                    }
                }, `${context} failed after all retry attempts`);
                break;
            }

            if (!isRetryableError(error, config)) {
                logger.error({
                    correlationId,
                    context,
                    attempt: attempt + 1,
                    error: {
                        message: err.message,
                        code: err.code,
                        status: err.status
                    }
                }, `${context} failed with non-retryable error`);
                break;
            }

            const delay = calculateDelay(attempt, config);

            logger.info({
                correlationId,
                context,
                attempt: attempt + 1,
                nextAttemptIn: delay,
                retryReason: 'retryable_error'
            }, `Retrying ${context} in ${delay}ms`);

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Sleep for the specified number of milliseconds
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a retry wrapper with predefined configuration for specific operations
 * @param config - Default retry configuration
 * @returns Retry wrapper function
 */
export function createRetryWrapper(config: Partial<RetryConfig> = {}): <T>(
    fn: () => Promise<T>,
    context?: string,
    options?: RetryOptions
) => Promise<T> {
    const mergedConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

    return function retryWrapper<T>(
        fn: () => Promise<T>,
        context: string = 'operation',
        options: RetryOptions = {}
    ): Promise<T> {
        const finalConfig = { ...mergedConfig, ...options };
        return withRetry(fn, finalConfig, context);
    };
}

/**
 * Predefined retry configurations for common operations
 */
export const retryConfigs: Record<string, Partial<RetryConfig>> = {
    // GitHub API operations
    githubApi: {
        maxAttempts: 3,
        baseDelay: 2000,
        maxDelay: 30000,
        exponentialBase: 2,
        retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']
    },

    // Git operations
    git: {
        maxAttempts: 2,
        baseDelay: 1000,
        maxDelay: 10000,
        exponentialBase: 2,
        retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'NETWORK_ERROR']
    },

    // Git push operations (with authentication retry)
    gitPush: {
        maxAttempts: 3,
        baseDelay: 2000,
        maxDelay: 15000,
        exponentialBase: 2,
        retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'NETWORK_ERROR', 'EAUTH', 'ENOTFOUND']
    },

    // Claude Code execution
    claude: {
        maxAttempts: 2,
        baseDelay: 5000,
        maxDelay: 60000,
        exponentialBase: 2,
        retryableErrors: ['TIMEOUT', 'DOCKER_ERROR', 'NETWORK_ERROR']
    },

    // Database/Redis operations
    redis: {
        maxAttempts: 5,
        baseDelay: 500,
        maxDelay: 5000,
        exponentialBase: 2,
        retryableErrors: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']
    }
};

export default withRetry;
