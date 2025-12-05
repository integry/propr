import logger from './logger.js';

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG = {
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

/**
 * Calculates delay for exponential backoff with optional jitter
 * @param {number} attempt - Current attempt number (0-based)
 * @param {object} config - Retry configuration
 * @returns {number} Delay in milliseconds
 */
function calculateDelay(attempt, config) {
    const exponentialDelay = config.baseDelay * Math.pow(config.exponentialBase, attempt);
    let delay = Math.min(exponentialDelay, config.maxDelay);

    if (config.jitter) {
        // Add ±25% jitter to prevent thundering herd
        const jitterAmount = delay * 0.25;
        delay += (Math.random() - 0.5) * 2 * jitterAmount;
    }

    return Math.max(delay, 0);
}

/**
 * Determines if an error is retryable
 * @param {Error} error - The error to check
 * @param {object} config - Retry configuration
 * @returns {boolean} Whether the error is retryable
 */
function isRetryableError(error, config) {
    // Check error code/type
    if (error.code && config.retryableErrors.includes(error.code)) {
        return true;
    }

    // Check HTTP status codes for API errors
    if (error.status) {
        // Retryable HTTP status codes
        const retryableStatuses = [429, 500, 502, 503, 504];
        return retryableStatuses.includes(error.status);
    }

    // Check error message patterns
    const retryablePatterns = [
        /rate limit/i,
        /timeout/i,
        /network/i,
        /connection/i,
        /temporary/i,
        /try again/i,
        /authentication failed/i,
        /invalid username or token/i,
        /credentials/i
    ];

    return retryablePatterns.some(pattern =>
        pattern.test(error.message) || pattern.test(error.toString())
    );
}

/**
 * Executes a function with exponential backoff retry logic
 * @param {Function} fn - The async function to retry
 * @param {object} options - Retry configuration options
 * @param {string} context - Context for logging (operation name)
 * @returns {Promise<any>} Result of the function
 */
export async function withRetry(fn, options = {}, context = 'operation') {
    const config = { ...DEFAULT_RETRY_CONFIG, ...options };
    const correlationId = options.correlationId || 'unknown';

    let lastError;

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

            logger.warn({
                correlationId,
                context,
                attempt: attempt + 1,
                maxAttempts: config.maxAttempts,
                error: {
                    message: error.message,
                    code: error.code,
                    status: error.status
                }
            }, `${context} failed on attempt ${attempt + 1}`);

            // If this is the last attempt, don't retry
            if (attempt === config.maxAttempts - 1) {
                logger.error({
                    correlationId,
                    context,
                    totalAttempts: config.maxAttempts,
                    finalError: {
                        message: error.message,
                        code: error.code,
                        status: error.status,
                        stack: error.stack
                    }
                }, `${context} failed after all retry attempts`);
                break;
            }

            // Check if error is retryable
            if (!isRetryableError(error, config)) {
                logger.error({
                    correlationId,
                    context,
                    attempt: attempt + 1,
                    error: {
                        message: error.message,
                        code: error.code,
                        status: error.status
                    }
                }, `${context} failed with non-retryable error`);
                break;
            }

            // Calculate delay for next attempt
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

    // If we reach here, all attempts failed
    throw lastError;
}

/**
 * Sleep for the specified number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a retry wrapper with predefined configuration for specific operations
 * @param {object} config - Default retry configuration
 * @returns {Function} Retry wrapper function
 */
export function createRetryWrapper(config = {}) {
    const mergedConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

    return function retryWrapper(fn, context = 'operation', options = {}) {
        const finalConfig = { ...mergedConfig, ...options };
        return withRetry(fn, finalConfig, context);
    };
}

/**
 * Predefined retry configurations for common operations
 */
export const retryConfigs = {
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