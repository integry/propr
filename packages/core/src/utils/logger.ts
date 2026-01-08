import { pino, Logger } from 'pino';
import { v4 as uuidv4 } from 'uuid';

const logLevel: string = process.env.LOG_LEVEL ?? 'info';

// In test mode, disable pino-pretty to prevent worker threads from keeping the process alive
// In production, use raw JSON output for better log aggregation
// Only use pino-pretty in development mode
const shouldUsePrettyPrint = process.env.NODE_ENV === 'development' ||
    (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test');

const baseLogger: Logger = pino({
    level: logLevel,
    transport: shouldUsePrettyPrint ? {
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
 * @param correlationId - Correlation ID to include in all log messages
 * @param additionalContext - Additional context to include
 * @returns Child logger instance
 */
function createCorrelatedLogger(correlationId: string, additionalContext: Record<string, unknown> = {}): Logger {
    return baseLogger.child({
        correlationId,
        ...additionalContext
    });
}

/**
 * Generates a new correlation ID
 * @returns UUID-based correlation ID
 */
function generateCorrelationId(): string {
    return uuidv4();
}

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface EnhancedLogger {
    trace: Logger['trace'];
    debug: Logger['debug'];
    info: Logger['info'];
    warn: Logger['warn'];
    error: Logger['error'];
    fatal: Logger['fatal'];
    createCorrelatedLogger: typeof createCorrelatedLogger;
    generateCorrelationId: typeof generateCorrelationId;
    withCorrelation: (correlationId: string, additionalContext?: Record<string, unknown>) => Logger;
    logWithContext: (level: LogLevel, messageOrObj: unknown, ...args: unknown[]) => void;
}

/**
 * Enhanced logger with correlation ID support
 */
const logger: EnhancedLogger = {
    trace: baseLogger.trace.bind(baseLogger),
    debug: baseLogger.debug.bind(baseLogger),
    info: baseLogger.info.bind(baseLogger),
    warn: baseLogger.warn.bind(baseLogger),
    error: baseLogger.error.bind(baseLogger),
    fatal: baseLogger.fatal.bind(baseLogger),

    createCorrelatedLogger,
    generateCorrelationId,

    withCorrelation(correlationId: string, additionalContext: Record<string, unknown> = {}): Logger {
        return createCorrelatedLogger(correlationId, additionalContext);
    },

    logWithContext(level: LogLevel, messageOrObj: unknown, ...args: unknown[]): void {
        if (typeof messageOrObj === 'object' && messageOrObj !== null && 'correlationId' in messageOrObj) {
            const { correlationId, ...rest } = messageOrObj as { correlationId: string; [key: string]: unknown };
            const correlatedLogger = createCorrelatedLogger(correlationId);
            (correlatedLogger[level] as (...args: unknown[]) => void)(rest, ...args);
        } else {
            (baseLogger[level] as (...args: unknown[]) => void)(messageOrObj, ...args);
        }
    }
};

export { generateCorrelationId, createCorrelatedLogger };
export default logger;
