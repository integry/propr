import { pino, Logger, LoggerOptions } from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { redactVisualPreviewValue } from '../services/visualPreviewPaths.js';

const logLevel: string = process.env.LOG_LEVEL ?? 'info';

// node:test gives the child process's stdout to a v8 deserializer, while pino
// writes from its own transport worker thread. A log line that lands inside a
// half-written report frame leaves the runner unable to deserialize it and the
// whole file fails with an uncaught "Unable to deserialize cloned data". Under
// the runner (NODE_TEST_CONTEXT is set only there) every log therefore goes to
// stderr, which the runner forwards verbatim.
const logFileDescriptor: 1 | 2 = process.env.NODE_TEST_CONTEXT === undefined ? 1 : 2;

const baseOptions: LoggerOptions = {
    hooks: {
        streamWrite: line => /(?:\.propr|propr-previews)/i.test(line)
            ? JSON.stringify(redactVisualPreviewValue(JSON.parse(line))) + '\n'
            : line,
    },
    level: logLevel,
};

const baseLogger: Logger = process.env.NODE_ENV !== 'production'
    ? pino({
        ...baseOptions,
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
                destination: logFileDescriptor,
            },
        },
    })
    : logFileDescriptor === 1
        ? pino(baseOptions)
        : pino(baseOptions, pino.destination(logFileDescriptor));

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
export type { EnhancedLogger };
export default logger;
