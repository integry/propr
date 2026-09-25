import { AsyncLocalStorage } from 'node:async_hooks';
import type { Knex } from 'knex';
import logger from '../utils/logger.js';
import {
    SQL_STATEMENT_START as STATEMENT_START,
    SQL_TRIVIA as TRIVIA,
    atScopeOf,
    isInTransaction,
    knexTransactionId,
    observeSavepoint,
    observeTransaction,
    stillOwnedBy,
    transactionOwnership,
    type TransactionOwner
} from './sqliteTransactionScope.js';

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
 * safe to run again opt in through {@link replayableTransaction}. A replay also
 * belongs where its statement was issued: one whose transaction ended while it
 * was backing off is abandoned rather than run outside that transaction. That
 * holds for nested transactions too, which knex implements as savepoints: a
 * `ROLLBACK TO SAVEPOINT` undoes the statement's write without closing the
 * connection's transaction, so replaying it afterwards would restore a write
 * the rollback undid and let the parent commit it. The scope has to match
 * exactly, not merely still exist: a parent's statement that resumes while a
 * nested transaction is open is held back until that savepoint closes, since
 * a replay made inside it would hand the parent's write to the nested
 * rollback. A savepoint the caller issued directly closes only when it is
 * released: SQLite keeps it open after `ROLLBACK TO`, so a replay made under
 * it could still be rolled back a second time. Which scope a statement was
 * issued in is read when the statement takes its turn on the connection, not
 * when it was dispatched: the driver runs each statement synchronously, but
 * what a savepoint statement did is only recorded once its call returns, and
 * a statement dispatched alongside one would otherwise miss a savepoint that
 * had already run. Every statement on a connection therefore takes one turn
 * per attempt — the ownership checks, the driver call and its recording, with
 * nothing else on that connection in between — and gives it up before backing
 * off, so the rest of the transaction can move while the statement waits.
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

/** A name, bare or in any of the quoting forms SQLite accepts for one. */
const quotedName = (name: string): string =>
    `(?:${name}|"${name}"|\`${name}\`|\\[${name}\\]|'${name}')`;

/**
 * A statement that reads or sets `busy_timeout`, in every form SQLite accepts
 * for it: leading comments and empty statements, a schema prefix, a quoted
 * name, and either assignment syntax (`= 5000`, `(5000)`). A form left
 * unrecognized here would be answered out of the limiter's internal cap, or
 * have its assignment undone when the limiter puts back the value it saw.
 */
const BUSY_TIMEOUT_PRAGMA = new RegExp(
    `^${STATEMENT_START}pragma(?:${TRIVIA}+|(?=["'\`\\[]))`
    + `(?:[^\\s;=()]+${TRIVIA}*\\.${TRIVIA}*)?`
    + `${quotedName('busy_timeout')}${TRIVIA}*(?:[=(]|;?${TRIVIA}*$)`,
    'i'
);

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
    /**
     * Whether the work the operation belongs to is still the one it started
     * in. A statement issued inside a transaction outlives it as soon as that
     * transaction ends, and replaying it then would run it outside the
     * transaction that was rolled back — so the replay is given up instead.
     */
    stillOwned?: () => boolean;
    /**
     * Whether the scope the operation was issued in is the innermost one open
     * right now. A statement's transaction can open a nested one while the
     * statement is backing off; a replay made inside that savepoint would let
     * the nested rollback undo a write that belongs to the parent, so the
     * replay is held back until the savepoint closes.
     */
    inScope?: () => boolean;
    /**
     * Runs one attempt, together with the checks that decide whether it may
     * be made, as one turn on the resource the operation acts on: nothing else
     * on that resource runs between the checks and the attempt they gate, and
     * whatever ran before the turn is fully accounted for by the time it is
     * granted. The turn ends before the backoff, so a pending retry never
     * keeps the resource from the rest of the program.
     */
    takeTurn?: <R>(step: () => Promise<R>) => Promise<R>;
    /**
     * Runs one attempt with the driver's own blocking wait capped at `limitMs`.
     * The cap is connection-wide state, so it is installed and taken back down
     * around the synchronous driver call alone and never spans an await.
     */
    withBlockingWaitLimit?: <R>(limitMs: number, attempt: () => R) => R;
}

/** One turn's outcome: an attempt that returned or threw, or one held back. */
type Attempt<T> =
    | { made: false }
    | { made: true; result: T }
    | { made: true; error: unknown };

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
    // The timer stays referenced: a caller is awaiting the retry, and an unref'd
    // timer lets a process with nothing else pending exit between two attempts,
    // so the awaited operation would neither finish nor reject. Shutting down
    // before the backoff is over is the caller's decision to make explicitly —
    // by not issuing the query, or by tearing the connection down — not
    // something a sleep may infer from an idle event loop.
    return new Promise(resolve => {
        setTimeout(resolve, ms);
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
 * blocking wait is lowered to an equal share of the budget for the duration of
 * each attempt, the backoff is capped by what is left, and the deadline is
 * rechecked once the wait is over. A replay whose context is gone — a statement
 * whose transaction ended while it was backing off — is given up rather than
 * run somewhere it no longer belongs. The final attempt's error is rethrown
 * unchanged so callers keep seeing the SQLite result code and message they
 * expect.
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
    const withBlockingWaitLimit = context.withBlockingWaitLimit;
    // The cap is recomputed for every attempt and lives only as long as that
    // attempt: the first one is bounded like all the others, and an inherited
    // budget is already partly spent, so each attempt may block for whichever
    // is smaller — its share of the budget, or what is left of the deadline.
    const attemptOnce = (): Promise<T> => {
        if (!withBlockingWaitLimit) return runAttempt();
        const remainingMs = deadline - resolved.now();
        return withBlockingWaitLimit(
            Math.min(attemptBlockingWaitMs, remainingMs),
            runAttempt
        );
    };

    // The context a retry belongs to can end while the backoff runs, and it is
    // the wait — the only point where the rest of the program gets to move —
    // that has to be rechecked on the other side.
    const abandoned = (): boolean => {
        if (context.stillOwned?.() !== false) return false;
        logger.debug(
            { operation: context.operation },
            'SQLite retry abandoned: the transaction it belonged to ended'
        );
        return true;
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

    // The scope a retry belongs to can also gain a nested transaction while
    // the backoff runs. Replaying inside that savepoint would put the write
    // where the nested rollback undoes it, so the replay is held back until
    // the savepoint closes. A hold spends an attempt the way a replay would,
    // which keeps it inside the same budget: a savepoint that outlives the
    // budget leaves the operation failing with the error it last saw, without
    // having run again.
    const heldBack = (): boolean => {
        if (context.inScope?.() !== false) return false;
        logger.debug(
            { operation: context.operation },
            'SQLite retry held back: a nested transaction is open inside its own'
        );
        return true;
    };

    // Whether the attempt is held back and the attempt itself are decided in
    // one turn: a savepoint that ran on the connection but had not been
    // recorded when the turn was asked for has been by the time it is granted,
    // so the check reads the very scope the attempt would run in.
    const takeTurn = context.takeTurn ?? (step => step());
    const attemptInTurn = (): Promise<Attempt<T>> => takeTurn(async () => {
        if (heldBack()) return { made: false };
        try {
            return { made: true, result: await attemptOnce() };
        } catch (caught) {
            return { made: true, error: caught };
        }
    });

    let error: unknown;
    for (let attempt = 1; ; attempt += 1) {
        const turn = await attemptInTurn();
        if (turn.made) {
            if ('result' in turn) return turn.result;
            error = turn.error;
            if (!isRetryable(error)) {
                giveUp(error, attempt);
                throw error;
            }
        }

        const remainingMs = deadline - resolved.now();
        if (attempt >= resolved.maxAttempts || remainingMs <= 0 || abandoned()) {
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

        // The wait itself can spend the rest of the budget, and the next
        // attempt would block on the lock all over again. It is also where
        // the transaction this operation belongs to can end.
        if (deadline - resolved.now() <= 0 || abandoned()) {
            giveUp(error, attempt);
            throw error;
        }
    }
}

type SqliteQueryConnection = {
    readonly?: boolean;
    pragma?: (source: string, options?: { simple?: boolean }) => unknown;
};

/**
 * A read-only connection cannot take the write lock `BEGIN IMMEDIATE` asks
 * for. Read-only is a property of the connection rather than of the file: a
 * database opened writable is still off limits to writes on a connection with
 * `PRAGMA query_only` set, and that pragma leaves the driver's `readonly` flag
 * alone. A deferred `BEGIN` opens a valid read transaction on either kind of
 * connection, whereas SQLITE_READONLY is not contention and no retry clears it.
 */
function isReadonlyConnection(connection: unknown): boolean {
    if (typeof connection !== 'object' || connection === null) return false;
    const sqlite = connection as SqliteQueryConnection;
    if (sqlite.readonly === true) return true;
    if (typeof sqlite.pragma !== 'function') return false;
    try {
        return Number(sqlite.pragma.call(sqlite, 'query_only', { simple: true })) !== 0;
    } catch {
        // A driver without the pragma answers for itself when `BEGIN` runs.
        return false;
    }
}

/**
 * Keeps the driver's synchronous lock wait inside the retry budget.
 *
 * better-sqlite3 blocks this thread for the whole `busy_timeout` on every
 * attempt, so a retry made with less budget left than that timeout would
 * overshoot the deadline by the difference. The pragma is lowered for one
 * attempt and put back before that attempt yields.
 *
 * `busy_timeout` belongs to the connection, not to the statement, so the window
 * it is lowered in has to be one the rest of the program cannot observe.
 * Everything below therefore runs between the call into the driver and its
 * return — better-sqlite3 does its waiting there, synchronously — and the
 * configured value is read back each time rather than remembered, so a caller
 * that changed the pragma between two attempts keeps the value it set.
 */
function blockingWaitLimiter(connection: unknown): Pick<RetryContext, 'withBlockingWaitLimit'> {
    const pragma = (connection as SqliteQueryConnection | null)?.pragma;
    if (typeof pragma !== 'function') return {};
    const run = pragma.bind(connection as SqliteQueryConnection);

    return {
        withBlockingWaitLimit<R>(limitMs: number, attempt: () => R): R {
            let configuredMs: number;
            try {
                configuredMs = Number(run('busy_timeout', { simple: true }));
            } catch {
                // A driver without this pragma still has the wall-clock budget.
                return attempt();
            }
            const capped = Math.max(0, Math.floor(limitMs));
            // The configured wait already fits in the budget: leave it alone.
            if (!Number.isFinite(configuredMs) || capped >= configuredMs) return attempt();
            try {
                run(`busy_timeout = ${capped}`);
            } catch {
                return attempt();
            }
            try {
                return attempt();
            } finally {
                try {
                    run(`busy_timeout = ${configuredMs}`);
                } catch {
                    // Nothing left to undo: the pragma is gone with the connection.
                }
            }
        }
    };
}

/**
 * The tail of the queue of turns taken on each connection. A turn starts once
 * the one before it is over, whichever way that one ended, so the queue never
 * carries a statement's failure to the statement behind it.
 */
const connectionTurns = new WeakMap<object, Promise<void>>();

/** Runs `step` once every turn already queued on `connection` is over. */
function takeConnectionTurn<R>(connection: unknown, step: () => Promise<R>): Promise<R> {
    if (typeof connection !== 'object' || connection === null) return step();
    const previous = connectionTurns.get(connection) ?? Promise.resolve();
    const turn = previous.then(step);
    connectionTurns.set(connection, turn.then(() => undefined, () => undefined));
    return turn;
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

        const query = typeof obj === 'object' && obj !== null ? obj as { sql?: unknown } : undefined;
        const sql = String(query?.sql ?? '');
        // Read as the statement is issued: knex writes the id of the
        // transaction issuing a statement onto the connection before issuing
        // it, and a savepoint named after that transaction is that
        // transaction's own, which a caller's savepoint issued through `raw`
        // is not.
        const issuedBy = knexTransactionId(connection);
        // The scope this statement belongs to — the transaction open on the
        // connection, or autocommit mode when none is — read as its first
        // attempt takes its turn rather than as it is issued: a replay is
        // only its own statement again while that scope is still the one
        // open on this connection, with every savepoint the statement ran
        // under still open. A statement issued alongside a savepoint runs
        // under that savepoint, but the savepoint is only recorded once its
        // driver call returns — so ownership read at issue would miss it, and
        // a rollback to the savepoint would leave the statement free to
        // replay a write that rollback undid. Read once every statement ahead
        // of it is recorded, the ownership is the scope the statement runs in.
        let transaction: TransactionOwner | undefined;
        let issued = false;

        // Take the write lock at BEGIN rather than at the callback's first
        // write: contention then lands on a statement with no side effects to
        // undo, which the retry below simply repeats, and the callback does not
        // start until the lock is held. Whether to is decided in the same
        // turn, for the same reason: a transaction already open on the
        // connection, or a `PRAGMA query_only` that forbids the write lock,
        // may both have been dispatched just ahead of the BEGIN and not have
        // run yet when it is issued.
        const rewritesBegin = options.immediateTransactions && DEFERRED_BEGIN.test(sql);
        const issue = (): void => {
            transaction = transactionOwnership(connection);
            if (rewritesBegin && query && !transaction?.open && !isReadonlyConnection(connection)) {
                query.sql = 'BEGIN IMMEDIATE;';
            }
            issued = true;
        };

        const runAttempt = async (): Promise<unknown> => {
            try {
                const result = await runQuery.call(this, connection, obj);
                // The savepoint statements of a nested transaction come
                // through here too, as do a caller's own, and only move
                // savepoints when they ran.
                observeSavepoint(connection, sql, issuedBy);
                return result;
            } finally {
                // `BEGIN`, `COMMIT` and `ROLLBACK` all come through here, and
                // this is where what they did to the connection is visible.
                observeTransaction(connection);
            }
        };

        return retryOnSqliteContention(
            runAttempt,
            {
                operation: sql,
                // A stale snapshot inside an open transaction can only be
                // cleared by rolling back, so let it reach the transaction
                // retry instead of replaying a statement that is certain to
                // fail again.
                isRetryable: error => isSqliteContentionError(error)
                    && !(isSqliteSnapshotConflict(error) && isInTransaction(connection)),
                // A transaction can end while one of its statements is backing
                // off — its callback can reject without awaiting the statement,
                // and the rollback and the connection release follow. Replaying
                // it then would run it outside the transaction that was rolled
                // back, on a connection that already belongs to someone else.
                // A nested transaction ends the same way, with a rollback to
                // its savepoint that leaves the parent open: replaying then
                // would put the write back for the parent to commit.
                stillOwned: () => !transaction || stillOwnedBy(connection, transaction),
                // A nested transaction can also open while the statement is
                // backing off. Its savepoint would take the replayed write
                // with it when it rolls back, so the replay waits for the
                // savepoint to close instead of running inside it. So can a
                // transaction on a connection the statement shares with it,
                // when the statement was issued in autocommit mode: the
                // transaction's rollback would take an acknowledged write
                // with it, so the replay waits for the transaction to close.
                inScope: () => !transaction || atScopeOf(connection, transaction),
                // One turn per attempt on the connection, covering the checks
                // above, the driver call and the recording of what it did.
                // Nothing else on the connection runs in between, and a turn
                // is only granted once the statements ahead of it are
                // recorded — a savepoint among them included. The first turn
                // opens by reading the scope the statement is issued in, so
                // the checks that gate the first attempt see it too. The
                // turn is given up before the backoff.
                takeTurn: step => takeConnectionTurn(connection, () => {
                    if (!issued) issue();
                    return step();
                }),
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
