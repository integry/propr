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

/** A statement the driver only finishes once the test lets it. */
interface Stall {
    pattern: RegExp;
    until: Promise<void>;
}

interface PreparedStatement {
    reader: boolean;
    all(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
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

/** A promise the test resolves itself, to order two things by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve = (): void => {};
    const promise = new Promise<void>(settle => {
        resolve = () => settle();
    });
    return { promise, resolve };
}

/** Lets everything already queued on the event loop run to completion. */
async function drainEventLoop(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }
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
// The pooled connection itself, so a test can read connection state without
// queueing a query behind the one that is retrying on it.
let connectionUnderTest: PreparingConnection | undefined;
let faults: Fault[] = [];
let stalls: Stall[] = [];
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
    connectionUnderTest = connection;
    const prepare = connection.prepare.bind(connection);
    const pragma = connection.pragma.bind(connection);
    connection.prepare = (sql: string) => {
        statements.push(sql);
        const fault = faults.find(candidate => candidate.pattern.test(sql));
        if (fault) {
            fault.attempts += 1;
            if (fault.attempts <= fault.failures) throw contention(fault.code);
        }
        const statement = prepare(sql) as PreparedStatement;
        const stall = stalls.find(candidate => candidate.pattern.test(sql));
        if (!stall) return statement;
        // knex awaits the statement's result, so one that resolves later
        // keeps the statement's turn on the connection open until then —
        // which is what lets a test dispatch statements behind it.
        return {
            reader: statement.reader,
            all: async (...args: unknown[]) => {
                await stall.until;
                return statement.all(...args);
            },
            run: async (...args: unknown[]) => {
                await stall.until;
                return statement.run(...args);
            }
        };
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

/** Keeps statements matching `pattern` running on the driver until released. */
function stallStatements(pattern: RegExp): { release: () => void } {
    const released = deferred();
    stalls.push({ pattern, until: released.promise });
    return { release: released.resolve };
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
    connectionUnderTest = undefined;
    faults = [];
    stalls = [];
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
                        withBlockingWaitLimit: (ms, attempt) => {
                            blockingWaitMs = ms;
                            return attempt();
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
                    withBlockingWaitLimit: (ms, attempt) => {
                        calls.push(ms);
                        try {
                            return attempt();
                        } finally {
                            calls.push('restored');
                        }
                    }
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
        // would ever run. Each cap is taken back down before the attempt that
        // installed it hands the event loop back.
        assert.deepEqual(calls, [30, 'restored', 30, 'restored', 30, 'restored']);
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
                        withBlockingWaitLimit: (ms, attempt) => {
                            limits.push(ms);
                            try {
                                return attempt();
                            } finally {
                                limits.push('restored');
                            }
                        }
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
        assert.deepEqual(limits, [30, 'restored', 20, 'restored']);
    });

    test('keeps the backoff timer holding the process open', async () => {
        // A worker awaiting a retry has nothing else pending while the backoff
        // runs. An unref'd timer would let the process exit right there, and
        // the awaited operation would neither finish nor reject — so this uses
        // the shipped sleep rather than the test seam.
        const referencedTimers = (): number => process
            .getActiveResourcesInfo()
            .filter(resource => resource === 'Timeout')
            .length;
        let beforeBackoff = 0;
        let duringBackoff = 0;
        let attempts = 0;

        const result = await retryOnSqliteContention(
            async () => {
                attempts += 1;
                if (attempts > 1) return 'done';
                beforeBackoff = referencedTimers();
                // Runs once the retry is asleep on its backoff timer.
                setImmediate(() => {
                    duringBackoff = referencedTimers();
                });
                throw contention();
            },
            { operation: 'test' },
            { baseDelayMs: 25, maxDelayMs: 25, random: () => 1 }
        );

        assert.equal(result, 'done');
        assert.equal(duringBackoff, beforeBackoff + 1);
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

    test('abandons a pending retry when its transaction ends first', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        installSqliteRetry(db, {
            random: () => 1,
            // A deferred BEGIN is what lets contention land on a statement
            // inside the callback instead of on the BEGIN before it.
            immediateTransactions: false,
            sleep: async () => {
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        const finished = assert.rejects(
            db.transaction(async trx => {
                await Promise.all([
                    trx('widgets').insert({ id: 1 }),
                    // Whatever else the callback was doing fails once the
                    // insert is already waiting to try again.
                    backingOff.promise.then(() => {
                        throw new Error('callback failed');
                    })
                ]);
            }),
            /callback failed/
        );

        // The transaction loses its race, rolls back and hands the connection
        // back to the pool while the insert is still backing off.
        await finished;

        // Only now does the lock clear. Replaying the insert here would run it
        // outside the transaction that was rolled back, on a connection the
        // transaction no longer owns, and commit it on its own.
        lockCleared.resolve();
        await drainEventLoop();

        assert.deepEqual(await db('widgets').pluck('id'), []);
        assert.equal(insert.attempts, 1);
    });

    test('abandons a pending retry when its nested transaction rolls back first', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const nestedRolledBack = deferred();
        const lockCleared = deferred();
        const parentMayCommit = deferred();
        installSqliteRetry(db, {
            random: () => 1,
            // With a deferred BEGIN, the write lock is first contended at the
            // nested insert rather than at the BEGIN before the callback.
            immediateTransactions: false,
            sleep: async () => {
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        let nestedError: unknown;
        const finished = db.transaction(async trx => {
            try {
                await trx.transaction(async nested => {
                    await Promise.all([
                        nested('widgets').insert({ id: 1 }),
                        // A sibling fails once the insert is already waiting
                        // to try again, which rolls the savepoint back.
                        backingOff.promise.then(() => {
                            throw new Error('nested callback failed');
                        })
                    ]);
                });
            } catch (error) {
                nestedError = error;
                nestedRolledBack.resolve();
            }
            // The parent survives the nested failure and stays open past
            // the point where the lock clears.
            await parentMayCommit.promise;
        });

        await nestedRolledBack.promise;
        assert.match(String(nestedError), /nested callback failed/);
        assert.ok(statements.some(sql => /^rollback to savepoint/i.test(sql)));

        // Only now does the lock clear. Replaying the insert here would run
        // it inside the parent, restoring a write the savepoint rolled back,
        // and the parent's COMMIT would then make it permanent.
        lockCleared.resolve();
        await drainEventLoop();
        parentMayCommit.resolve();
        await finished;

        assert.deepEqual(await db('widgets').pluck('id'), []);
        assert.equal(insert.attempts, 1);
    });

    for (const [open, rollBack, release] of [
        // A bare identifier ends where the comment begins, so SQLite names
        // this savepoint `s`, not `s/*`.
        ['SAVEPOINT s/* marker */', 'ROLLBACK TO s', 'RELEASE s'],
        // A doubled quote stands for itself inside a quoted identifier.
        ['SAVEPOINT "s""q"', 'ROLLBACK TO [s"q]', 'RELEASE `s"q`'],
        // A quote delimiter starts a token of its own, so SQLite needs no
        // whitespace between the keyword and a quoted name.
        ['SAVEPOINT s', 'ROLLBACK TO"s"', 'RELEASE SAVEPOINT"s"'],
        // A bare `;` is an empty statement, which SQLite skips, so each of
        // these is still the savepoint statement after it.
        ['; SAVEPOINT s', ';; ROLLBACK TO s', '; /* done */ ; RELEASE s']
    ]) {
        test(`abandons a pending retry under \`${open}\` once \`${rollBack}\` runs`, async () => {
            const db = await createDatabase();
            const insert = failStatements(/^insert/i, 1);
            const backingOff = deferred();
            const lockCleared = deferred();
            installSqliteRetry(db, {
                random: () => 1,
                immediateTransactions: false,
                sleep: async () => {
                    backingOff.resolve();
                    await lockCleared.promise;
                }
            });

            let insertError: unknown;
            await db.transaction(async trx => {
                await trx.raw(open);
                const pending = trx('widgets').insert({ id: 1 }).catch(error => {
                    insertError = error;
                });
                await backingOff.promise;
                // The rollback names the same savepoint SQLite opened above,
                // so it undoes everything issued under it, the pending insert
                // included.
                await trx.raw(rollBack);
                await trx.raw(release);
                // Only now does the lock clear. Replaying the insert here
                // would put the write back for the transaction to commit.
                lockCleared.resolve();
                await pending;
            });

            assert.match(String(insertError), /database is locked/);
            assert.equal(insert.attempts, 1);
            assert.deepEqual(await db('widgets').pluck('id'), []);
        });
    }

    test('abandons a pending retry issued together with the savepoint that is rolled back', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        installSqliteRetry(db, {
            random: () => 1,
            immediateTransactions: false,
            sleep: async () => {
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        let insertError: unknown;
        await db.transaction(async trx => {
            // Issued together, the savepoint first: it runs before the insert,
            // but the insert reaches the retry before the savepoint has been
            // recorded, so it must not take the connection's savepoints for
            // its own before the statement ahead of it is accounted for.
            const opened = trx.raw('SAVEPOINT s').then(() => undefined);
            const pending = trx('widgets').insert({ id: 1 }).catch(error => {
                insertError = error;
            });
            await opened;
            await backingOff.promise;
            // The rollback undoes everything issued under the savepoint, the
            // pending insert included, and the release closes it.
            await trx.raw('ROLLBACK TO SAVEPOINT s');
            await trx.raw('RELEASE SAVEPOINT s');
            // Only now does the lock clear. Replaying the insert here would
            // put the write back for the transaction to commit.
            lockCleared.resolve();
            await pending;
        });

        assert.match(String(insertError), /database is locked/);
        assert.equal(insert.attempts, 1);
        assert.deepEqual(await db('widgets').pluck('id'), []);
    });

    test('tells savepoint names apart the way SQLite does, by ASCII case only', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        installSqliteRetry(db, {
            random: () => 1,
            immediateTransactions: false,
            sleep: async () => {
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        let insertError: unknown;
        await db.transaction(async trx => {
            await trx.raw('SAVEPOINT "Ä"');
            const pending = trx('widgets').insert({ id: 1 }).catch(error => {
                insertError = error;
            });
            await backingOff.promise;
            // SQLite folds only ASCII letters when it matches savepoint
            // names, so `"ä"` opens a second savepoint inside `"Ä"` rather
            // than shadowing it. Rolling back to the outer one undoes the
            // pending insert and closes the inner one with it.
            await trx.raw('SAVEPOINT "ä"');
            await trx.raw('ROLLBACK TO "Ä"');
            await trx.raw('RELEASE "Ä"');
            // Only now does the lock clear. Had the two names been tracked as
            // one, the rollback would have been recorded against the inner
            // savepoint, leaving the insert owned by the outer one and free
            // to replay a write the rollback undid.
            lockCleared.resolve();
            await pending;
        });

        assert.match(String(insertError), /database is locked/);
        assert.equal(insert.attempts, 1);
        assert.deepEqual(await db('widgets').pluck('id'), []);
    });

    test('keeps a parent retry pending while a nested transaction completes', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        installSqliteRetry(db, {
            random: () => 1,
            immediateTransactions: false,
            sleep: async () => {
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        await db.transaction(async trx => {
            await Promise.all([
                trx('widgets').insert({ id: 1 }),
                // A nested transaction opens and releases its savepoint
                // while the parent's insert is backing off. That ends the
                // nested transaction, not the parent's.
                backingOff.promise
                    .then(() => trx.transaction(async nested => {
                        await nested('widgets').insert({ id: 2 });
                    }))
                    .then(() => lockCleared.resolve())
            ]);
        });

        assert.ok(statements.some(sql => /^release savepoint/i.test(sql)));
        assert.deepEqual(await db('widgets').pluck('id'), [1, 2]);
        assert.equal(insert.attempts, 3);
    });

    test('holds a parent retry back until the nested transaction it resumed under rolls back', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        const nestedRolledBack = deferred();
        let sleeps = 0;
        installSqliteRetry(db, {
            random: () => 1,
            immediateTransactions: false,
            sleep: async () => {
                sleeps += 1;
                if (sleeps > 1) {
                    // Held back: the retry is waiting for the nested
                    // transaction to close rather than for the lock.
                    await nestedRolledBack.promise;
                    return;
                }
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        let nestedError: unknown;
        await db.transaction(async trx => {
            await Promise.all([
                trx('widgets').insert({ id: 1 }),
                backingOff.promise
                    .then(() => trx.transaction(async nested => {
                        await nested('widgets').insert({ id: 2 });
                        // The lock clears while the savepoint is still open.
                        // Resuming the parent's insert here would put its
                        // write inside the nested transaction, and the
                        // rollback below would silently take it away from
                        // the parent's commit.
                        lockCleared.resolve();
                        await drainEventLoop();
                        throw new Error('nested callback failed');
                    }))
                    .catch(error => {
                        nestedError = error;
                        nestedRolledBack.resolve();
                    })
            ]);
        });

        assert.match(String(nestedError), /nested callback failed/);
        assert.equal(sleeps, 2);
        // The replay ran in the parent's own scope, after the savepoint
        // rolled back, so the parent commits its write and only its write.
        const rolledBackAt = statements.findIndex(sql => /^rollback to savepoint/i.test(sql));
        const replayedAt = statements.findLastIndex(sql => /^insert/i.test(sql));
        assert.ok(rolledBackAt >= 0);
        assert.ok(replayedAt > rolledBackAt);
        assert.equal(insert.attempts, 3);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
    });

    test('fails a held-back retry without running it when the savepoint outlives the budget', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        let sleeps = 0;
        installSqliteRetry(db, {
            random: () => 1,
            maxAttempts: 3,
            immediateTransactions: false,
            sleep: async () => {
                sleeps += 1;
                if (sleeps > 1) return;
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        let nestedError: unknown;
        await db.transaction(async trx => {
            // Started now, awaited from inside the nested transaction: the
            // query only runs once something waits on it.
            const pending = Promise.resolve(trx('widgets').insert({ id: 1 }));
            await backingOff.promise;
            try {
                await trx.transaction(async () => {
                    // The nested transaction waits for the parent's pending
                    // insert, so the lock only clears while its savepoint is
                    // open — and it stays open until that insert settles.
                    lockCleared.resolve();
                    await pending;
                });
            } catch (error) {
                nestedError = error;
            }
        });

        // Every remaining attempt found the savepoint still open. The insert
        // reports the contention it last saw rather than running inside a
        // scope that is not its own.
        assert.match(String(nestedError), /database is locked/);
        assert.equal(sleeps, 2);
        assert.equal(insert.attempts, 1);
        assert.deepEqual(await db('widgets').pluck('id'), []);
    });

    test('holds a parent retry back while a savepoint the caller rolled back to stays open', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        const savepointReleased = deferred();
        let sleeps = 0;
        installSqliteRetry(db, {
            random: () => 1,
            immediateTransactions: false,
            sleep: async () => {
                sleeps += 1;
                if (sleeps > 1) {
                    // Held back: the savepoint is still open after the
                    // rollback, and the retry waits for its release.
                    await savepointReleased.promise;
                    return;
                }
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        await db.transaction(async trx => {
            await Promise.all([
                trx('widgets').insert({ id: 1 }),
                (async () => {
                    await backingOff.promise;
                    // A savepoint the caller issues itself is not a nested
                    // transaction: SQLite keeps it open after `ROLLBACK TO`,
                    // so it can be rolled back to again.
                    await trx.raw('SAVEPOINT s');
                    await trx.raw('ROLLBACK TO SAVEPOINT s');
                    // The lock clears with the savepoint still open. A replay
                    // made here would land under it, and the second rollback
                    // would silently take the parent's acknowledged write.
                    lockCleared.resolve();
                    await drainEventLoop();
                    await trx.raw('ROLLBACK TO SAVEPOINT s');
                    await trx.raw('RELEASE SAVEPOINT s');
                    savepointReleased.resolve();
                })()
            ]);
        });

        assert.equal(sleeps, 2);
        // The replay ran only once the savepoint was released, so the
        // parent's commit keeps its write.
        const releasedAt = statements.findIndex(sql => /^release savepoint/i.test(sql));
        const replayedAt = statements.findLastIndex(sql => /^insert/i.test(sql));
        assert.ok(releasedAt >= 0);
        assert.ok(replayedAt > releasedAt);
        assert.equal(insert.attempts, 2);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
    });

    test('holds an autocommit retry back while a transaction is open on its connection', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1);
        const backingOff = deferred();
        const lockCleared = deferred();
        const rolledBack = deferred();
        let sleeps = 0;
        installSqliteRetry(db, {
            random: () => 1,
            sleep: async () => {
                sleeps += 1;
                if (sleeps > 1) {
                    // Held back: the retry is waiting for the transaction
                    // that opened on its connection to close, not for the lock.
                    await rolledBack.promise;
                    return;
                }
                backingOff.resolve();
                await lockCleared.promise;
            }
        });

        // Issued on the connection directly rather than through the pool,
        // the insert does not keep the connection to itself: the transaction
        // below takes it from the pool while the insert is backing off.
        const connection = connectionUnderTest as PreparingConnection;
        const pending = Promise.resolve(db('widgets').connection(connection).insert({ id: 1 }));
        await backingOff.promise;

        let callbackError: unknown;
        await db.transaction(async trx => {
            await trx('widgets').insert({ id: 2 });
            // The lock clears while the transaction is open. Resuming the
            // insert here would put its write inside a transaction it was
            // never part of, and the rollback below would silently take the
            // row away after the insert had reported success.
            lockCleared.resolve();
            await drainEventLoop();
            throw new Error('callback failed');
        }).catch(error => {
            callbackError = error;
            rolledBack.resolve();
        });
        await pending;

        assert.match(String(callbackError), /callback failed/);
        assert.equal(sleeps, 2);
        // The replay ran in autocommit mode, after the transaction rolled
        // back, so its write is the one that persists.
        const rolledBackAt = statements.findIndex(sql => /^rollback;?$/i.test(sql));
        const replayedAt = statements.findLastIndex(sql => /^insert/i.test(sql));
        assert.ok(rolledBackAt >= 0, statements.join('\n'));
        assert.ok(replayedAt > rolledBackAt, statements.join('\n'));
        assert.equal(insert.attempts, 3);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
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
        // attempts may spend — and puts the connection's own value back at the
        // end of every one of them, never holding the cap across a wait.
        assert.deepEqual(
            pragmas.filter(source => source.startsWith('busy_timeout =')),
            [
                'busy_timeout = 25',
                `busy_timeout = ${configured}`,
                'busy_timeout = 25',
                `busy_timeout = ${configured}`
            ]
        );
    });

    test('puts the connection busy timeout back before the retry yields', async () => {
        const db = await createDatabase();
        const configured = await busyTimeoutMs(db);
        failStatements(/^insert/i, 1);
        const observed: number[] = [];
        installSqliteRetry(db, {
            random: () => 1,
            baseDelayMs: 25,
            maxTotalMs: 100,
            maxAttempts: 4,
            // The backoff is the only moment another caller on this connection
            // gets to run, so it is where the cap must already be gone: the
            // pragma is connection-wide, and a concurrent read would otherwise
            // see the retry's internal value and a concurrent write would be
            // undone by the restore.
            sleep: async () => {
                observed.push(
                    Number(connectionUnderTest?.pragma('busy_timeout', { simple: true }))
                );
            }
        });

        await db('widgets').insert({ id: 1 });

        assert.deepEqual(observed, [configured]);
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

    test('preserves busy_timeout statements written in any valid form', async () => {
        const db = await createDatabase();
        const configured = await busyTimeoutMs(db);
        installSqliteRetry(db, {
            random: () => 1,
            baseDelayMs: 25,
            maxTotalMs: 100,
            maxAttempts: 4
        });
        pragmas.length = 0;

        // Quoting a name and putting a comment in front of it are both ordinary
        // SQL, so the limiter has to keep its hands off these too: it would
        // answer the read with its own internal cap and undo the assignments
        // when it restored the value it saw.
        const quotedRead = await db.raw('PRAGMA "busy_timeout"') as Array<
            Record<string, number>
        >;
        assert.equal(
            Number(quotedRead[0]?.timeout ?? quotedRead[0]?.busy_timeout),
            configured
        );

        await db.raw('-- raise the lock wait\nPRAGMA `busy_timeout` = 1234');
        assert.equal(await busyTimeoutMs(db), 1234);

        await db.raw('/* schema-qualified */ PRAGMA main.[busy_timeout] = 4321');
        assert.equal(await busyTimeoutMs(db), 4321);

        await db.raw("PRAGMA 'busy_timeout'(2468)");
        assert.equal(await busyTimeoutMs(db), 2468);

        // A bare `;` is an empty statement, which SQLite skips, so these are
        // the pragma too. The limiter would otherwise put the value it saw
        // back over the assignment.
        await db.raw('; PRAGMA busy_timeout = 0');
        assert.equal(await busyTimeoutMs(db), 0);

        await db.raw(';; /* two empty statements */ PRAGMA busy_timeout = 1357');
        assert.equal(await busyTimeoutMs(db), 1357);

        const emptyPrefixedRead = await db.raw('; PRAGMA busy_timeout') as Array<
            Record<string, number>
        >;
        assert.equal(
            Number(emptyPrefixedRead[0]?.timeout ?? emptyPrefixedRead[0]?.busy_timeout),
            1357
        );

        assert.deepEqual(pragmas.filter(source => source.startsWith('busy_timeout')), []);
    });

    test('keeps deferred transactions on connections with query_only set', async () => {
        const db = await createDatabase();
        installSqliteRetry(db, instantRetries);
        await db('widgets').insert({ id: 3 });

        // `query_only` forbids writes on a connection to a writable file without
        // touching the driver's `readonly` flag, and `BEGIN IMMEDIATE` is a
        // write it rejects with SQLITE_READONLY — which no retry can clear.
        await db.raw('PRAGMA query_only = ON');
        statements.length = 0;

        const ids = await db.transaction(trx => trx('widgets').pluck('id'));

        assert.deepEqual(ids, [3]);
        assert.ok(statements.some(sql => /^BEGIN;?$/i.test(sql)), statements.join('\n'));
        assert.ok(!statements.some(sql => /^BEGIN IMMEDIATE/i.test(sql)), statements.join('\n'));
    });

    test('decides how to open a transaction once the statements ahead of it have run', async () => {
        const db = await createDatabase();
        installSqliteRetry(db, instantRetries);
        await db('widgets').insert({ id: 3 });
        const connection = connectionUnderTest as PreparingConnection;
        statements.length = 0;

        // A statement that holds its turn on the connection until released,
        // so the two dispatched behind it are queued rather than run.
        const stalled = stallStatements(/^select `id`/i);
        const ahead = Promise.resolve(db('widgets').connection(connection).select('id'));
        await drainEventLoop();

        // The pragma is dispatched first and the transaction right behind
        // it, both on the same connection. Whether the connection is read-only
        // is decided by the pragma, which has not run when the BEGIN is
        // issued — so the decision has to wait for the BEGIN's own turn.
        const readOnly = Promise.resolve(db.raw('PRAGMA query_only = ON'));
        await drainEventLoop();
        const ids = db.transaction(trx => trx('widgets').pluck('id'), { connection });
        await drainEventLoop();
        assert.deepEqual(statements, ['select `id` from `widgets`']);

        stalled.release();
        await Promise.all([ahead, readOnly]);

        assert.deepEqual(await ids, [3]);
        assert.deepEqual(statements, [
            'select `id` from `widgets`',
            'PRAGMA query_only = ON',
            'BEGIN;',
            'select `id` from `widgets`',
            'COMMIT;'
        ]);
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
