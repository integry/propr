import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

const logLevel = process.env.LOG_LEVEL || 'info';

const baseLogger = pino({
    level: logLevel,
    transport: process.env.NODE_ENV !== 'production' ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
        },
    } : undefined,
});

/**
 * Creates a child logger with correlation ID
 * @param {string} correlationId - Correlation ID to include in all log messages
 * @param {object} additionalContext - Additional context to include
 * @returns {object} Child logger instance
 */
function createCorrelatedLogger(correlationId, additionalContext = {}) {
    return baseLogger.child({
        correlationId,
        ...additionalContext
    });
}

/**
 * Generates a new correlation ID
 * @returns {string} UUID-based correlation ID
 */
function generateCorrelationId() {
    return uuidv4();
}

/**
 * Enhanced logger with correlation ID support
 */
const logger = {
    // Standard logging methods from base logger
    trace: baseLogger.trace.bind(baseLogger),
    debug: baseLogger.debug.bind(baseLogger),
    info: baseLogger.info.bind(baseLogger),
    warn: baseLogger.warn.bind(baseLogger),
    error: baseLogger.error.bind(baseLogger),
    fatal: baseLogger.fatal.bind(baseLogger),

    // Correlation ID utilities
    createCorrelatedLogger,
    generateCorrelationId,

    // Enhanced logging methods that automatically handle correlation IDs
    withCorrelation(correlationId, additionalContext = {}) {
        return createCorrelatedLogger(correlationId, additionalContext);
    },

    // Log with automatic correlation ID extraction from context
    logWithContext(level, messageOrObj, ...args) {
        if (typeof messageOrObj === 'object' && messageOrObj.correlationId) {
            const { correlationId, ...rest } = messageOrObj;
            const correlatedLogger = createCorrelatedLogger(correlationId);
            correlatedLogger[level](rest, ...args);
        } else {
            baseLogger[level](messageOrObj, ...args);
        }
    }
};

export { generateCorrelationId, createCorrelatedLogger };
export default logger;