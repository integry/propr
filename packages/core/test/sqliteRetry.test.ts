import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import {
    installSqliteRetry,
    isSqliteContentionError,
    isSqliteSnapshotConflict,
    replayableTransaction,
    retryOnSqliteContention,
    sqliteRetryDelayMs,
    type SqliteRetryOptions
} from '../src/db/sqliteRetry.js';

interface Fault {
    pattern: RegExp;
    failures: number;
    code: string;
    attempts: number;
}

interface PreparingConnection {
    prepare(sql: string): unknown;
    pragma(source: string, options?: { simple?: boolean }): unknown;
}

/** A clock that only moves when the retry loop waits on it. */
function fakeClock(startMs = 0): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
} {
    let clock = startMs;
    const sleeps: number[] = [];
    return {
        now: () => clock,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
        },
        sleeps
    };
}

/** Runs `body` with the SQLite retry environment back at its shipped defaults. */
async function withDefaultRetryEnv(body: () => Promise<void>): Promise<void> {
    const keys = [
        'SQLITE_BUSY_TIMEOUT_MS',
        'SQLITE_RETRY_MAX_ATTEMPTS',
        'SQLITE_RETRY_BASE_DELAY_MS',
        'SQLITE_RETRY_MAX_DELAY_MS',
        'SQLITE_RETRY_MAX_TOTAL_MS'
    ];
    const saved = keys.map(key => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    try {
        await body();
    } finally {
        for (const [key, value] of saved) {
            if (value !== undefined) process.env[key] = value;
        }
    }
}

let database: Knex | undefined;
let faults: Fault[] = [];
let statements: string[] = [];
let pragmas: string[] = [];

// Deterministic retries: no real waiting, no jitter.
const instantRetries: SqliteRetryOptions = { sleep: async () => undefined, random: () => 1 };

function contention(code = 'SQLITE_BUSY'): Error {
    return Object.assign(new Error('database is locked'), { code });
}

/**
 * Fail the registered statements from inside the driver, which is the one seam
 * every knex client shares — including the bare client knex rebuilds for each
 * transaction.
 */
function injectFaults(connection: PreparingConnection): void {
    const prepare = connection.prepare.bind(connection);
    const pragma = connection.pragma.bind(connection);
    connection.prepare = (sql: string) => {
        statements.push(sql);
        const fault = faults.find(candidate => candidate.pattern.test(sql));
        if (fault) {
            fault.attempts += 1;
            if (fault.attempts <= fault.failures) throw contention(fault.code);
        }
        return prepare(sql);
    };
    connection.pragma = (source: string, options?: { simple?: boolean }) => {
        pragmas.push(source);
        return pragma(source, options);
    };
}

/** Fails statements matching `pattern` for their first `failures` attempts. */
function failStatements(pattern: RegExp, failures: number, code = 'SQLITE_BUSY'): Fault {
    const fault: Fault = { pattern, failures, code, attempts: 0 };
    faults.push(fault);
    return fault;
}

async function createDatabase(): Promise<Knex> {
    // One connection: separate `:memory:` connections would each open their own
    // empty database, and a single connection is what contention races anyway.
    database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: {
            min: 1,
            max: 1,
            afterCreate(
                connection: PreparingConnection,
                done: (error: Error | null, connection: PreparingConnection) => void
            ) {
                injectFaults(connection);
                done(null, connection);
            }
        }
    });
    await database.schema.createTable('widgets', table => {
        table.integer('id').primary();
    });
    return database;
}

async function busyTimeoutMs(db: Knex): Promise<number> {
    const rows = await db.raw('PRAGMA busy_timeout') as Array<Record<string, number>>;
    return Number(rows[0]?.timeout ?? rows[0]?.busy_timeout);
}

afterEach(async () => {
    await database?.destroy();
    database = undefined;
    faults = [];
    statements = [];
    pragmas = [];
});

describe('SQLite contention detection', () => {
    test('recognizes contention result codes', () => {
        for (const code of [
            'SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT',
            'SQLITE_BUSY_RECOVERY', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE'
        ]) {
            assert.equal(isSqliteContentionError(contention(code)), true, code);
        }
    });

    test('recognizes the contention message when the driver drops the code', () => {
        const message = "update `goals` set `session_id` = 'a' - database is locked";
        assert.equal(isSqliteContentionError(new Error(message)), true);
        assert.equal(isSqliteContentionError(new Error('database table is locked')), true);
    });

    test('leaves unrelated failures alone', () => {
        assert.equal(isSqliteContentionError(new Error('no such table: goals')), false);
        assert.equal(
            isSqliteContentionError(
                Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT' })
            ),
            false
        );
        assert.equal(isSqliteContentionError(undefined), false);
    });

    test('separates snapshot conflicts from replayable contention', () => {
        assert.equal(isSqliteSnapshotConflict(contention('SQLITE_BUSY_SNAPSHOT')), true);
        assert.equal(isSqliteSnapshotConflict(contention('SQLITE_BUSY')), false);
    });
});

describe('retry backoff', () => {
    test('grows exponentially and stops at the ceiling', () => {
        const options = { baseDelayMs: 25, maxDelayMs: 100, random: () => 1 };
        assert.deepEqual(
            [1, 2, 3, 4, 5].map(attempt => sqliteRetryDelayMs(attempt, options)),
            [25, 50, 100, 100, 100]
        );
    });

    test('jitters the delay so contending writers separate', () => {
        const options = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.25 };
        assert.equal(sqliteRetryDelayMs(3, options), 100);
    });
});

describe('retryOnSqliteContention', () => {
    test('replays until the lock clears', async () => {
        let attempts = 0;
        const result = await retryOnSqliteContention(
            async () => {
                attempts += 1;
                if (attempts < 3) throw contention();
                return 'done';
            },
            { operation: 'test' },
            instantRetries
        );
        assert.equal(result, 'done');
        assert.equal(attempts, 3);
    });

    test('rethrows the original error once attempts run out', async () => {
        let attempts = 0;
        await assert.rejects(
            retryOnSqliteContention(
                async () => {
                    attempts += 1;
                    throw contention();
                },
                { operation: 'test' },
                { ...instantRetries, maxAttempts: 3 }
            ),
            (error: Error & { code?: string }) => error.code === 'SQLITE_BUSY'
        );
        assert.equal(attempts, 3);
    });

    test('stops once the blocking busy wait has used the whole budget', async () => {
        // A caller without a blocking-wait limiter cannot bound the busy
        // handler, so an attempt that blocked for the entire budget has nothing
        // left to retry with: retrying past it would only freeze the process
        // again.
        let clock = 0;
        let attempts = 0;
        await assert.rejects(
            retryOnSqliteContention(
                async () => {
                    attempts += 1;
                    clock += 30_000;
                    throw contention();
                },
                { operation: 'test' },
                { ...instantRetries, maxTotalMs: 30_000, now: () => clock }
            ),
            /database is locked/
        );
        assert.equal(attempts, 1);
    });

    test('divides the default budget into several blocking attempts', async () => {
        // The default budget is the connection's own `busy_timeout`, so an
        // attempt allowed to block for all of it would leave nothing over and
        // the locked update of issue #2495 would fail after a single try. Each
        // attempt may block for its share of the budget instead.
        await withDefaultRetryEnv(async () => {
            let clock = 0;
            let blockingWaitMs = Number.POSITIVE_INFINITY;
            let attempts = 0;
            await assert.rejects(
                retryOnSqliteContention(
                    async () => {
                        attempts += 1;
                        // Stands in for better-sqlite3 sitting in the busy
                        // handler for the whole wait it was allowed.
                        clock += blockingWaitMs;
                        throw contention();
                    },
                    {
                        operation: 'test',
                        limitBlockingWaitMs: ms => {
                            blockingWaitMs = ms;
                        }
                    },
                    {
                        random: () => 1,
                        now: () => clock,
                        sleep: async (ms: number) => {
                            clock += ms;
                        }
                    }
                ),
                /database is locked/
            );
            // Every default attempt runs, and together with the backoff between
            // them they spend exactly the 30 s budget — never more.
            assert.equal(attempts, 6);
            assert.equal(clock, 30_000);
        });
    });

    test('caps the backoff at the budget that is left', async () => {
        // A 25 ms backoff inside a 10 ms budget would sleep past the deadline
        // and then take another blocking attempt on the far side of it.
        const clock = fakeClock();
        let attempts = 0;
        await assert.rejects(
            retryOnSqliteContention(
                async () => {
                    attempts += 1;
                    throw contention();
                },
                { operation: 'test' },
                {
                    random: () => 1,
                    baseDelayMs: 25,
                    maxTotalMs: 10,
                    now: clock.now,
                    sleep: clock.sleep
                }
            ),
            /database is locked/
        );
        assert.deepEqual(clock.sleeps, [10]);
        assert.equal(attempts, 1);
    });

    test('keeps retrying while the budget allows it', async () => {
        const clock = fakeClock();
        let attempts = 0;
        const result = await retryOnSqliteContention(
            async () => {
                attempts += 1;
                if (attempts < 3) throw contention();
                return 'done';
            },
            { operation: 'test' },
            {
                random: () => 1,
                baseDelayMs: 25,
                maxTotalMs: 1000,
                now: clock.now,
                sleep: clock.sleep
            }
        );
        assert.equal(result, 'done');
        assert.deepEqual(clock.sleeps, [25, 50]);
    });

    test('lowers the driver blocking wait to each attempt\'s share of the budget', async () => {
        const clock = fakeClock();
        const calls: Array<number | 'restored'> = [];
        await assert.rejects(
            retryOnSqliteContention(
                async () => {
                    throw contention();
                },
                {
                    operation: 'test',
                    limitBlockingWaitMs: ms => calls.push(ms),
                    restoreBlockingWait: () => calls.push('restored')
                },
                {
                    random: () => 1,
                    baseDelayMs: 25,
                    maxDelayMs: 25,
                    maxTotalMs: 90,
                    maxAttempts: 3,
                    now: clock.now,
                    sleep: clock.sleep
                }
            ),
            /database is locked/
        );
        // A third of the budget per attempt, the first one included: an
        // uncapped first attempt would block for the whole budget and no retry
        // would ever run.
        assert.deepEqual(calls, [30, 30, 30, 'restored']);
    });

    test('holds a nested retry to the budget of the retry around it', async () => {
        const clock = fakeClock();
        const limits: Array<number | 'restored'> = [];
        let innerAttempts = 0;
        await assert.rejects(
            retryOnSqliteContention(
                async () => retryOnSqliteContention(
                    async () => {
                        innerAttempts += 1;
                        throw contention();
                    },
                    {
                        operation: 'inner',
                        limitBlockingWaitMs: ms => limits.push(ms),
                        restoreBlockingWait: () => limits.push('restored')
                    },
                    {
                        random: () => 1,
                        baseDelayMs: 10,
                        maxTotalMs: 60_000,
                        now: clock.now,
                        sleep: clock.sleep
                    }
                ),
                { operation: 'outer', sharesBudget: true },
                {
                    random: () => 1,
                    baseDelayMs: 10,
                    maxTotalMs: 30,
                    maxAttempts: 1,
                    now: clock.now,
                    sleep: clock.sleep
                }
            ),
            /database is locked/
        );
        // The inner retry stops at the outer deadline instead of spending the
        // minute-long budget of its own.
        assert.equal(clock.now(), 30);
        assert.equal(innerAttempts, 2);
        // Including the blocking wait of the nested operation's first attempt:
        // the budget it inherited was already running, and what is left of it
        // is less than the share an attempt would otherwise get.
        assert.deepEqual(limits, [30, 20, 'restored']);
    });

    test('does not replay failures that are not contention', async () => {
        let attempts = 0;
        await assert.rejects(
            retryOnSqliteContention(
                async () => {
                    attempts += 1;
                    throw new Error('no such column: missing');
                },
                { operation: 'test' },
                instantRetries
            ),
            /no such column/
        );
        assert.equal(attempts, 1);
    });
});

describe('installSqliteRetry', () => {
    test('retries a locked statement instead of failing the query', async () => {
        const db = await createDatabase();
        const update = failStatements(/^update/i, 2);
        installSqliteRetry(db, instantRetries);

        await db('widgets').insert({ id: 1 });
        const changed = await db('widgets').where({ id: 1 }).update({ id: 2 });

        assert.equal(changed, 1);
        assert.equal(update.attempts, 3);
        assert.deepEqual(await db('widgets').pluck('id'), [2]);
    });

    test('retries reads and raw statements through the same funnel', async () => {
        const db = await createDatabase();
        const select = failStatements(/^select/i, 1);
        const raw = failStatements(/^pragma/i, 1);
        installSqliteRetry(db, instantRetries);

        assert.deepEqual(await db('widgets').select('id'), []);
        await db.raw('PRAGMA user_version');

        assert.equal(select.attempts, 2);
        assert.equal(raw.attempts, 2);
    });

    test('surfaces the SQLite error when the lock never clears', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, Number.MAX_SAFE_INTEGER);
        installSqliteRetry(db, { ...instantRetries, maxAttempts: 4 });

        await assert.rejects(db('widgets').insert({ id: 1 }), /database is locked/);
        assert.equal(insert.attempts, 4);
    });

    test('replays a locked statement inside a transaction without rerunning it', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        installSqliteRetry(db, instantRetries);

        let containerRuns = 0;
        await db.transaction(async trx => {
            containerRuns += 1;
            await trx('widgets').insert({ id: 1 });
        });

        assert.equal(containerRuns, 1);
        assert.equal(insert.attempts, 2);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
    });

    test('takes the write lock before the transaction callback runs', async () => {
        const db = await createDatabase();
        installSqliteRetry(db, instantRetries);
        statements.length = 0;

        await db.transaction(async trx => {
            await trx('widgets').insert({ id: 1 });
        });

        // A deferred BEGIN would only meet the writer at the callback's first
        // write, where contention can no longer be replayed on its own.
        assert.ok(statements.includes('BEGIN IMMEDIATE;'));
        assert.ok(!statements.includes('BEGIN;'));
    });

    test('retries a locked BEGIN instead of replaying the callback', async () => {
        const db = await createDatabase();
        const begin = failStatements(/^begin/i, 2);
        installSqliteRetry(db, instantRetries);

        let containerRuns = 0;
        await db.transaction(async trx => {
            containerRuns += 1;
            await trx('widgets').insert({ id: 1 });
        });

        assert.equal(begin.attempts, 3);
        assert.equal(containerRuns, 1);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
    });

    test('never replays a transaction callback on its own', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1, 'SQLITE_BUSY_SNAPSHOT');
        installSqliteRetry(db, instantRetries);

        let containerRuns = 0;
        let itemsTaken = 0;
        await assert.rejects(
            db.transaction(async trx => {
                containerRuns += 1;
                // Stands in for the work a rollback cannot undo: an item taken
                // off a queue, a request sent, a counter advanced.
                itemsTaken += 1;
                await trx('widgets').insert({ id: 1 });
            }),
            /database is locked/
        );

        assert.equal(containerRuns, 1);
        assert.equal(itemsTaken, 1);
        assert.equal(insert.attempts, 1);
    });

    test('replays a transaction the caller declared replayable', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1, 'SQLITE_BUSY_SNAPSHOT');
        installSqliteRetry(db, instantRetries);

        let containerRuns = 0;
        await db.transaction(async trx => {
            containerRuns += 1;
            await trx('widgets').insert({ id: 1 });
        }, replayableTransaction());

        // The statement is not replayed in place: only a rollback clears a
        // stale snapshot, so the container runs a second time.
        assert.equal(containerRuns, 2);
        assert.equal(insert.attempts, 2);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
    });

    test('lowers the connection busy timeout to the budget left on a retry', async () => {
        const db = await createDatabase();
        const configured = await busyTimeoutMs(db);
        failStatements(/^insert/i, 1);
        const clock = fakeClock();
        installSqliteRetry(db, {
            random: () => 1,
            baseDelayMs: 25,
            maxTotalMs: 100,
            maxAttempts: 4,
            now: clock.now,
            sleep: clock.sleep
        });
        pragmas.length = 0;

        await db('widgets').insert({ id: 1 });

        // better-sqlite3 blocks this thread for the whole busy_timeout, so the
        // retry lowers it to the quarter of the budget each of the four
        // attempts may spend and puts the connection's own value back
        // afterwards.
        assert.deepEqual(
            pragmas.filter(source => source.startsWith('busy_timeout =')),
            ['busy_timeout = 25', `busy_timeout = ${configured}`]
        );
    });

    test('reports the connection busy timeout to a caller reading it back', async () => {
        const db = await createDatabase();
        const configured = await busyTimeoutMs(db);
        installSqliteRetry(db, {
            random: () => 1,
            baseDelayMs: 25,
            maxTotalMs: 100,
            maxAttempts: 4
        });
        pragmas.length = 0;

        // Retrying may not change what the statement it wraps returns: the cap
        // the retry installs on the driver's blocking wait is internal to it,
        // so a read of the pragma still reports the configured value and the
        // statement runs without the limiter touching the connection.
        assert.equal(await busyTimeoutMs(db), configured);
        assert.deepEqual(pragmas.filter(source => source.startsWith('busy_timeout')), []);

        // Setting it sticks too: restoring the value the limiter saw would
        // undo the write the caller just made.
        await db.raw('PRAGMA busy_timeout = 1234');
        assert.equal(await busyTimeoutMs(db), 1234);
    });

    test('leaves transactions the caller drives to the caller', async () => {
        const db = await createDatabase();
        installSqliteRetry(db, instantRetries);

        const trx = await db.transaction();
        await trx('widgets').insert({ id: 7 });
        await trx.commit();

        assert.deepEqual(await db('widgets').pluck('id'), [7]);
    });

    test('leaves other databases sharing the dialect failing fast', async () => {
        const retried = await createDatabase();
        installSqliteRetry(retried, instantRetries);

        // Try-lock callers open their own connection with `busy_timeout = 0`
        // precisely to see SQLITE_BUSY immediately; the shared dialect patch
        // must not start retrying on their behalf.
        const tryLock = knex({
            client: 'better-sqlite3',
            connection: { filename: ':memory:' },
            useNullAsDefault: true,
            pool: {
                min: 1,
                max: 1,
                afterCreate(
                    connection: PreparingConnection,
                    done: (error: Error | null, connection: PreparingConnection) => void
                ) {
                    injectFaults(connection);
                    done(null, connection);
                }
            }
        });
        try {
            const select = failStatements(/^select/i, 1);
            await assert.rejects(tryLock.raw('SELECT 1'), /database is locked/);
            assert.equal(select.attempts, 1);
        } finally {
            await tryLock.destroy();
        }
    });

    test('installing twice does not stack retries', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, Number.MAX_SAFE_INTEGER);
        installSqliteRetry(db, { ...instantRetries, maxAttempts: 3 });
        installSqliteRetry(db, { ...instantRetries, maxAttempts: 3 });

        await assert.rejects(db('widgets').insert({ id: 1 }), /database is locked/);
        assert.equal(insert.attempts, 3);
    });
});
