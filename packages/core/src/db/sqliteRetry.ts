import { AsyncLocalStorage } from 'node:async_hooks';
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
 * connection owns the lock finish its work on this event loop.
 *
 * Only statements are replayed. A transaction callback is application code: a
 * rollback undoes its SQL, not the items it took off a queue, the requests it
 * sent or the JavaScript state it captured, so running it twice is not
 * something this layer may decide on its own. Transactions instead open with
 * `BEGIN IMMEDIATE`, which moves lock acquisition ahead of the callback where
 * the statement retry can replay it harmlessly; callbacks that genuinely are
 * safe to run again opt in through {@link replayableTransaction}.
 *
 * Retries are bounded by a wall-clock budget so they shorten contention rather
 * than multiplying a blocked thread. The budget bounds the asynchronous waits,
 * the driver's own blocking waits, and every retry nested inside a retried
 * transaction, so an operation cannot outlive the deadline it was given. Each
 * attempt may block for no more than its share of that budget, which is what
 * leaves room for the attempts after it: an uncapped first attempt would sit in
 * the busy handler for the whole `busy_timeout` and there would be nothing left
 * to retry with.
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

/** knex opens an outermost transaction with a deferred `BEGIN`. */
const DEFERRED_BEGIN = /^\s*begin\s*;?\s*$/i;

/**
 * A statement that reads or sets `busy_timeout`, with or without a schema
 * prefix and in either assignment form (`= 5000`, `(5000)`).
 */
const BUSY_TIMEOUT_PRAGMA =
    /^\s*pragma\s+(?:[^\s;=()]+\s*\.\s*)?busy_timeout\s*(?:[=(]|;?\s*$)/i;

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
/** Marks a transaction config whose callback the caller declared safe to replay. */
const REPLAYABLE = Symbol.for('propr.sqliteRetryReplayable');
/** Lets the per-query path reuse options instead of re-reading the environment. */
const RETRY_RESOLVED = Symbol('propr.sqliteRetryResolved');

/**
 * The deadline of the retried operation currently in flight. A statement retry
 * running inside a retried transaction inherits it, so nested retries share one
 * budget instead of each starting a fresh one.
 */
const retryBudget = new AsyncLocalStorage<{ deadline: number }>();

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
    /**
     * Open outermost transactions with `BEGIN IMMEDIATE` so contention for the
     * write lock surfaces on a statement that can be replayed, before the
     * callback has done anything. On by default.
     */
    immediateTransactions?: boolean;
    /**
     * Replay *every* transaction callback that loses the race for the lock.
     * Off by default: replaying a callback re-runs whatever it does besides
     * SQL. Prefer declaring individual transactions replayable with
     * {@link replayableTransaction}.
     */
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
    immediateTransactions: boolean;
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
    /** Shares this operation's deadline with every retry nested inside it. */
    sharesBudget?: boolean;
    /** Caps the driver's own blocking wait at what is left of the budget. */
    limitBlockingWaitMs?: (remainingMs: number) => void;
    /** Restores the driver's configured blocking wait once retrying is over. */
    restoreBlockingWait?: () => void;
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

/**
 * Declare a transaction callback safe to run again from the start, so the whole
 * transaction can be replayed when contention cannot be resolved in place:
 *
 * ```ts
 * await db.transaction(async trx => { ... }, replayableTransaction());
 * ```
 *
 * Only pass this for callbacks whose non-SQL effects — queue reads, HTTP calls,
 * counters, captured state — either do not exist or are idempotent. Everything
 * the callback did outside the database survives the rollback.
 */
export function replayableTransaction(
    config: Knex.TransactionConfig = {}
): Knex.TransactionConfig {
    return { ...config, [REPLAYABLE]: true } as Knex.TransactionConfig;
}

function isReplayableTransaction(config: unknown): boolean {
    return typeof config === 'object'
        && config !== null
        && (config as Record<symbol, unknown>)[REPLAYABLE] === true;
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
        immediateTransactions: options.immediateTransactions
            ?? process.env.SQLITE_RETRY_IMMEDIATE_TRANSACTIONS !== '0',
        // Opt-in: this replays application code, so it cannot default to on.
        retryTransactions: options.retryTransactions
            ?? process.env.SQLITE_RETRY_TRANSACTIONS === '1',
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
 * Every attempt has to fit inside the remaining wall-clock budget: the driver's
 * blocking wait is lowered to an equal share of the budget before each attempt,
 * the backoff is capped by what is left, and the deadline is rechecked once the
 * wait is over. The final attempt's error is rethrown unchanged so callers keep
 * seeing the SQLite result code and message they expect.
 */
export async function retryOnSqliteContention<T>(
    operation: () => Promise<T>,
    context: RetryContext,
    options: SqliteRetryOptions = {}
): Promise<T> {
    const resolved = resolveOptions(options);
    const isRetryable = context.isRetryable ?? isSqliteContentionError;
    const startedAt = resolved.now();
    const inheritedDeadline = retryBudget.getStore()?.deadline;
    // An outer retry's deadline wins: nested retries may not extend it.
    const deadline = Math.min(
        startedAt + resolved.maxTotalMs,
        inheritedDeadline ?? Number.POSITIVE_INFINITY
    );
    const runAttempt = context.sharesBudget
        ? () => retryBudget.run({ deadline }, operation)
        : operation;
    // better-sqlite3 blocks this thread inside the busy handler for the whole
    // `busy_timeout` on every attempt, so an attempt that is allowed the full
    // budget leaves nothing for the one after it. Each attempt gets an equal
    // share instead, which is what makes the budget divisible into retries.
    const attemptBlockingWaitMs = Math.floor(resolved.maxTotalMs / resolved.maxAttempts);
    const limitBlockingWait = (remainingMs: number): void => {
        context.limitBlockingWaitMs?.(Math.min(attemptBlockingWaitMs, remainingMs));
    };

    const giveUp = (error: unknown, attempts: number): void => {
        if (attempts > 1 && isSqliteContentionError(error)) {
            logger.warn({
                operation: context.operation,
                attempts,
                elapsedMs: resolved.now() - startedAt,
                code: errorCode(error)
            }, 'SQLite stayed locked across every retry');
        }
    };

    try {
        // The first attempt is bounded like every other one, and an inherited
        // budget is already partly spent, so its blocking wait also has to fit
        // in whatever is left of that budget.
        limitBlockingWait(deadline - startedAt);

        for (let attempt = 1; ; attempt += 1) {
            try {
                return await runAttempt();
            } catch (error) {
                const remainingMs = deadline - resolved.now();
                if (attempt >= resolved.maxAttempts
                    || remainingMs <= 0
                    || !isRetryable(error)) {
                    giveUp(error, attempt);
                    throw error;
                }

                const waitMs = Math.min(sqliteRetryDelayMs(attempt, resolved), remainingMs);
                logger.debug({
                    operation: context.operation,
                    attempt,
                    waitMs,
                    code: errorCode(error)
                }, 'SQLite is locked; retrying');
                await resolved.sleep(waitMs);

                // The wait itself can spend the rest of the budget, and the
                // next attempt would block on the lock all over again.
                const leftMs = deadline - resolved.now();
                if (leftMs <= 0) {
                    giveUp(error, attempt);
                    throw error;
                }
                limitBlockingWait(leftMs);
            }
        }
    } finally {
        context.restoreBlockingWait?.();
    }
}

type SqliteQueryConnection = {
    inTransaction?: boolean;
    readonly?: boolean;
    pragma?: (source: string, options?: { simple?: boolean }) => unknown;
};

/** A read-only connection cannot take the write lock `BEGIN IMMEDIATE` asks for. */
function isReadonlyConnection(connection: unknown): boolean {
    return typeof connection === 'object'
        && connection !== null
        && (connection as SqliteQueryConnection).readonly === true;
}

function isInTransaction(connection: unknown): boolean {
    return typeof connection === 'object'
        && connection !== null
        && (connection as SqliteQueryConnection).inTransaction === true;
}

/**
 * Keeps the driver's synchronous lock wait inside the retry budget.
 *
 * better-sqlite3 blocks this thread for the whole `busy_timeout` on every
 * attempt, so a retry made with less budget left than that timeout would
 * overshoot the deadline by the difference. Lowering the pragma for the
 * duration of the retries bounds that wait; the connection's configured value
 * is restored once the statement is done with it.
 */
function blockingWaitLimiter(connection: unknown): Pick<
    RetryContext, 'limitBlockingWaitMs' | 'restoreBlockingWait'
> {
    const pragma = (connection as SqliteQueryConnection | null)?.pragma;
    if (typeof pragma !== 'function') return {};
    const run = pragma.bind(connection as SqliteQueryConnection);
    let configuredMs: number | undefined;
    let appliedMs: number | undefined;

    return {
        limitBlockingWaitMs(remainingMs: number): void {
            try {
                configuredMs ??= Number(run('busy_timeout', { simple: true }));
                if (!Number.isFinite(configuredMs)) return;
                const capped = Math.max(0, Math.floor(remainingMs));
                // Successive attempts usually ask for the same cap; the pragma
                // is only worth writing when it actually changes.
                if (capped >= configuredMs || capped === appliedMs) return;
                run(`busy_timeout = ${capped}`);
                appliedMs = capped;
            } catch {
                // A driver without this pragma still has the wall-clock budget.
            }
        },
        restoreBlockingWait(): void {
            // Nothing was lowered, so there is nothing to put back.
            if (appliedMs === undefined || configuredMs === undefined) return;
            const restored = configuredMs;
            configuredMs = undefined;
            appliedMs = undefined;
            try {
                run(`busy_timeout = ${restored}`);
            } catch {
                // Nothing left to undo: the pragma is gone with the connection.
            }
        }
    };
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

        const query = typeof obj === 'object' && obj !== null
            ? obj as { sql?: unknown }
            : undefined;

        // Take the write lock at BEGIN rather than at the callback's first
        // write: contention then lands on a statement with no side effects to
        // undo, which the retry below simply repeats, and the callback does not
        // start until the lock is held.
        if (options.immediateTransactions
            && query
            && DEFERRED_BEGIN.test(String(query.sql ?? ''))
            && !isInTransaction(connection)
            && !isReadonlyConnection(connection)) {
            query.sql = 'BEGIN IMMEDIATE;';
        }

        const sql = String(query?.sql ?? '');

        return retryOnSqliteContention(
            () => runQuery.call(this, connection, obj),
            {
                operation: sql,
                // A stale snapshot inside an open transaction can only be
                // cleared by rolling back, so let it reach the transaction
                // retry instead of replaying a statement that is certain to
                // fail again.
                isRetryable: error => isSqliteContentionError(error)
                    && !(isSqliteSnapshotConflict(error) && isInTransaction(connection)),
                // Retrying may not change what the statement it wraps does.
                // The limiter lowers `busy_timeout` for the duration of the
                // attempt and puts the old value back afterwards, which would
                // report the retry's internal cap to a caller reading the
                // pragma and would undo a caller writing it. Neither statement
                // waits on a lock, so neither has a blocking wait to bound.
                ...(BUSY_TIMEOUT_PRAGMA.test(sql) ? {} : blockingWaitLimiter(connection))
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
        // Replaying a callback re-runs everything it does besides SQL, so only
        // callbacks whose caller declared them safe are replayed. Savepoints
        // are excluded too: one shares its parent's stale snapshot, and a
        // transaction opened without a callback is driven by the caller, who
        // owns the retry decision.
        const replayable = typeof container === 'function'
            && !outerTx
            && (options.retryTransactions || isReplayableTransaction(config));
        if (!replayable) return runTransaction(container, config, outerTx);

        return retryOnSqliteContention(
            async () => await runTransaction(container, config, outerTx),
            { operation: 'transaction', sharesBudget: true },
            options
        );
    };
}

/**
 * Make every query issued through `database` survive transient lock contention.
 *
 * Retries are installed at knex's single query funnel so they cover query
 * builders, `raw`, migrations and statements inside transactions alike, and at
 * the transaction boundary for callbacks the caller declared replayable with
 * {@link replayableTransaction}. Only this database is affected: other knex
 * instances sharing the dialect — such as the try-lock connections that depend
 * on seeing SQLITE_BUSY at once — keep failing fast. Installing twice on the
 * same database is a no-op.
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
    retryTransactions(database, resolved);

    return database;
}
