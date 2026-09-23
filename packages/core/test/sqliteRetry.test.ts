import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import {
    installSqliteRetry,
    isSqliteContentionError,
    isSqliteSnapshotConflict,
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
}

let database: Knex | undefined;
let faults: Fault[] = [];

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
    connection.prepare = (sql: string) => {
        const fault = faults.find(candidate => candidate.pattern.test(sql));
        if (fault) {
            fault.attempts += 1;
            if (fault.attempts <= fault.failures) throw contention(fault.code);
        }
        return prepare(sql);
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

afterEach(async () => {
    await database?.destroy();
    database = undefined;
    faults = [];
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
        // A busy handler that already blocked this thread for its full timeout
        // is not transient contention; retrying would only freeze the process
        // again. Attempts before the budget is spent still run.
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

    test('replays the whole transaction when its snapshot goes stale', async () => {
        const db = await createDatabase();
        const insert = failStatements(/^insert/i, 1, 'SQLITE_BUSY_SNAPSHOT');
        installSqliteRetry(db, instantRetries);

        let containerRuns = 0;
        await db.transaction(async trx => {
            containerRuns += 1;
            await trx('widgets').insert({ id: 1 });
        });

        // The statement is not replayed in place: only a rollback clears a
        // stale snapshot, so the container runs a second time.
        assert.equal(containerRuns, 2);
        assert.equal(insert.attempts, 2);
        assert.deepEqual(await db('widgets').pluck('id'), [1]);
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
