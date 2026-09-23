import type { Knex } from 'knex';
import logger from '../utils/logger.js';

/**
 * Generic SQLite lock-contention retries.
 *
 * SQLite reports contention with a dedicated result code instead of applying a
 * partial write: the statement that returned SQLITE_BUSY never ran, so it can
 * be replayed verbatim. `busy_timeout` alone is not enough to make that
 * invisible to callers. better-sqlite3 waits for the lock synchronously, so a
 * writer in another process (or another pooled connection in this one) can hold
 * the lock for the entire timeout and the query then fails outright. Every
 * query issued through a database patched by {@link installSqliteRetry} instead
 * waits on an asynchronous timer and tries again, which also lets whichever
 * connection owns the lock finish its work on this event loop. Retries are
 * bounded by a wall-clock budget so they shorten contention rather than
 * multiplying a blocked thread.
 */

/** Result codes that mean "someone else holds the lock right now". */
const SQLITE_CONTENTION_CODES = new Set([
    'SQLITE_BUSY',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_BUSY_TIMEOUT',
    'SQLITE_BUSY_RECOVERY',
    'SQLITE_LOCKED',
    'SQLITE_LOCKED_SHAREDCACHE'
]);

/** Drivers that lose the result code still carry SQLite's contention message. */
const SQLITE_CONTENTION_MESSAGE =
    /database (?:is locked|table is locked|schema is locked)/i;

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 500;
const DEFAULT_BUSY_TIMEOUT_MS = 30000;
// A connection that fails lock acquisition immediately still deserves a real
// retry window: without this floor, `SQLITE_BUSY_TIMEOUT_MS=0` would leave no
// budget at all for the asynchronous backoff that replaces the blocking wait.
const MIN_TOTAL_MS = 5000;

/** Marks a dialect prototype whose `_query` already consults the options below. */
const RETRY_PATCHED = Symbol.for('propr.sqliteRetryPatched');
/** Carries the retry options on the knex config every client of a database shares. */
const RETRY_OPTIONS = Symbol.for('propr.sqliteRetryOptions');
/** Lets the per-query path reuse options instead of re-reading the environment. */
const RETRY_RESOLVED = Symbol('propr.sqliteRetryResolved');

export interface SqliteRetryOptions {
    /** Total attempts, including the first one. */
    maxAttempts?: number;
    /** Delay before the first retry; doubles per attempt up to `maxDelayMs`. */
    baseDelayMs?: number;
    maxDelayMs?: number;
    /**
     * Wall-clock budget for the whole operation, defaulting to the connection's
     * `busy_timeout`. Contention that the busy handler already waited out is not
     * transient, and better-sqlite3 waits for it by blocking this thread — so
     * retrying past that point would multiply a freeze rather than shorten it.
     */
    maxTotalMs?: number;
    /** Retry whole transaction callbacks whose contention cannot be replayed in place. */
    retryTransactions?: boolean;
    /** Test seams. */
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
}

interface ResolvedRetryOptions {
    [RETRY_RESOLVED]: true;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxTotalMs: number;
    retryTransactions: boolean;
    sleep: (ms: number) => Promise<void>;
    random: () => number;
    now: () => number;
}

interface RetryContext {
    /** Describes the retried work for logs; never includes bindings. */
    operation: string;
    /** Lets the statement-level retry decline contention it cannot replay. */
    isRetryable?: (error: unknown) => boolean;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code as string | undefined
        : undefined;
}

/** True when `error` is SQLite refusing to proceed because of a held lock. */
export function isSqliteContentionError(error: unknown): boolean {
    const code = errorCode(error);
    if (typeof code === 'string' && SQLITE_CONTENTION_CODES.has(code)) return true;
    return error instanceof Error && SQLITE_CONTENTION_MESSAGE.test(error.message);
}

/**
 * True for the one contention flavour a statement cannot recover from on its
 * own: the transaction's read snapshot is stale, so only a rollback and a
 * replay of the whole transaction can make progress.
 */
export function isSqliteSnapshotConflict(error: unknown): boolean {
    return errorCode(error) === 'SQLITE_BUSY_SNAPSHOT';
}

/** An unset or blank environment variable must not read as zero. */
function configuredNumber(value: unknown): number {
    return value === undefined || value === null || value === '' ? NaN : Number(value);
}

function positiveInteger(value: unknown, fallback: number): number {
    const parsed = configuredNumber(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
    const parsed = configuredNumber(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        // Retries must never hold a worker process open on their own.
        timer.unref?.();
    });
}

function resolveOptions(options: SqliteRetryOptions = {}): ResolvedRetryOptions {
    if ((options as ResolvedRetryOptions)[RETRY_RESOLVED]) {
        return options as ResolvedRetryOptions;
    }
    return {
        [RETRY_RESOLVED]: true,
        maxAttempts: positiveInteger(
            options.maxAttempts ?? process.env.SQLITE_RETRY_MAX_ATTEMPTS,
            DEFAULT_MAX_ATTEMPTS
        ),
        baseDelayMs: nonNegativeNumber(
            options.baseDelayMs ?? process.env.SQLITE_RETRY_BASE_DELAY_MS,
            DEFAULT_BASE_DELAY_MS
        ),
        maxDelayMs: nonNegativeNumber(
            options.maxDelayMs ?? process.env.SQLITE_RETRY_MAX_DELAY_MS,
            DEFAULT_MAX_DELAY_MS
        ),
        maxTotalMs: nonNegativeNumber(
            options.maxTotalMs ?? process.env.SQLITE_RETRY_MAX_TOTAL_MS,
            Math.max(
                MIN_TOTAL_MS,
                nonNegativeNumber(process.env.SQLITE_BUSY_TIMEOUT_MS, DEFAULT_BUSY_TIMEOUT_MS)
            )
        ),
        retryTransactions: options.retryTransactions
            ?? process.env.SQLITE_RETRY_TRANSACTIONS !== '0',
        sleep: options.sleep ?? delay,
        random: options.random ?? Math.random,
        now: options.now ?? Date.now
    };
}

/**
 * Exponential backoff with full jitter. Contending processes that back off by
 * the same amount would keep colliding on every retry.
 */
export function sqliteRetryDelayMs(
    attempt: number,
    options: Pick<ResolvedRetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>
): number {
    const exponential = options.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const ceiling = Math.min(exponential, options.maxDelayMs);
    return Math.round(ceiling * options.random());
}

/**
 * Run `operation`, replaying it while SQLite reports lock contention.
 *
 * The final attempt's error is rethrown unchanged so callers keep seeing the
 * SQLite result code and message they expect.
 */
export async function retryOnSqliteContention<T>(
    operation: () => Promise<T>,
    context: RetryContext,
    options: SqliteRetryOptions = {}
): Promise<T> {
    const resolved = resolveOptions(options);
    const isRetryable = context.isRetryable ?? isSqliteContentionError;
    const startedAt = resolved.now();

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            const elapsedMs = resolved.now() - startedAt;
            const exhausted = attempt >= resolved.maxAttempts
                || elapsedMs >= resolved.maxTotalMs;
            if (exhausted || !isRetryable(error)) {
                if (attempt > 1 && isSqliteContentionError(error)) {
                    logger.warn({
                        operation: context.operation,
                        attempts: attempt,
                        elapsedMs,
                        code: errorCode(error)
                    }, 'SQLite stayed locked across every retry');
                }
                throw error;
            }

            const waitMs = sqliteRetryDelayMs(attempt, resolved);
            logger.debug({
                operation: context.operation,
                attempt,
                waitMs,
                code: errorCode(error)
            }, 'SQLite is locked; retrying');
            await resolved.sleep(waitMs);
        }
    }
}

type SqliteQueryConnection = { inTransaction?: boolean };

function isInTransaction(connection: unknown): boolean {
    return typeof connection === 'object'
        && connection !== null
        && (connection as SqliteQueryConnection).inTransaction === true;
}

interface RetryableClient {
    _query(connection: unknown, obj: unknown): Promise<unknown>;
    /**
     * knex rebuilds a bare client for every transaction
     * (`Object.create(client.constructor.prototype)`), copying only a fixed set
     * of fields — the knex config object among them. Retries therefore hang off
     * the prototype and read their options from that shared config, so
     * statements inside a transaction are covered too.
     */
    config?: Record<string | symbol, unknown>;
    constructor: { prototype: RetryableClient & { [RETRY_PATCHED]?: boolean } };
}

interface RetryableContext {
    _transaction(container: unknown, config: unknown, outerTx?: unknown): unknown;
}

function retryStatements(client: RetryableClient): void {
    const prototype = client.constructor.prototype;
    if (Object.prototype.hasOwnProperty.call(prototype, RETRY_PATCHED)) return;
    Object.defineProperty(prototype, RETRY_PATCHED, { value: true });

    const runQuery = prototype._query;
    prototype._query = function patchedQuery(
        this: RetryableClient,
        connection: unknown,
        obj: unknown
    ): Promise<unknown> {
        const options = this.config?.[RETRY_OPTIONS] as ResolvedRetryOptions | undefined;
        if (!options) return runQuery.call(this, connection, obj);

        const sql = typeof obj === 'object' && obj !== null
            ? String((obj as { sql?: unknown }).sql ?? '')
            : '';
        return retryOnSqliteContention(
            () => runQuery.call(this, connection, obj),
            {
                operation: sql,
                // A stale snapshot inside an open transaction can only be
                // cleared by rolling back, so let it reach the transaction
                // retry below instead of replaying a statement that is certain
                // to fail again.
                isRetryable: error => isSqliteContentionError(error)
                    && !(isSqliteSnapshotConflict(error) && isInTransaction(connection))
            },
            options
        );
    };
}

function retryTransactions(database: Knex, options: ResolvedRetryOptions): void {
    const context = ((database as unknown as { context?: RetryableContext }).context
        ?? database) as RetryableContext;
    if (typeof context._transaction !== 'function') return;
    const runTransaction = context._transaction.bind(context);

    context._transaction = function patchedTransaction(
        container: unknown,
        config: unknown,
        outerTx: unknown = null
    ): unknown {
        // Only whole outermost transactions can be replayed: a savepoint shares
        // its parent's stale snapshot, and a transaction opened without a
        // callback is driven by the caller, who owns the retry decision.
        if (typeof container !== 'function' || outerTx) {
            return runTransaction(container, config, outerTx);
        }
        return retryOnSqliteContention(
            async () => await runTransaction(container, config, outerTx),
            { operation: 'transaction' },
            options
        );
    };
}

/**
 * Make every query issued through `database` survive transient lock contention.
 *
 * Retries are installed at knex's single query funnel so they cover query
 * builders, `raw`, migrations and statements inside transactions alike, plus at
 * the transaction boundary for the contention a single statement cannot replay.
 * Only this database is affected: other knex instances sharing the dialect —
 * such as the try-lock connections that depend on seeing SQLITE_BUSY at once —
 * keep failing fast. Installing twice on the same database is a no-op.
 */
export function installSqliteRetry<T extends Knex>(
    database: T,
    options: SqliteRetryOptions = {}
): T {
    const client = database.client as unknown as RetryableClient | undefined;
    if (!client?.config || typeof client._query !== 'function') return database;
    if (client.config[RETRY_OPTIONS]) return database;

    const resolved = resolveOptions(options);
    retryStatements(client);
    client.config[RETRY_OPTIONS] = resolved;
    if (resolved.retryTransactions) retryTransactions(database, resolved);

    return database;
}
