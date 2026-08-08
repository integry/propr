import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    applyDatabaseMigrations,
    type MigrationDatabase,
} from '../packages/core/src/db/migrationGate.js';

function fakeDatabase(options: {
    migrationError?: Error;
    migrationRejectsWithUndefined?: boolean;
    restoreError?: Error;
} = {}): {
    database: MigrationDatabase;
    calls: string[];
} {
    const calls: string[] = [];
    return {
        calls,
        database: {
            raw: async sql => {
                calls.push(sql);
                if (sql.endsWith('ON') && options.restoreError) throw options.restoreError;
            },
            migrate: {
                latest: async () => {
                    calls.push('migrate.latest');
                    if (options.migrationRejectsWithUndefined) return Promise.reject(undefined);
                    if (options.migrationError) throw options.migrationError;
                },
            },
        },
    };
}

test('migration gate wraps the migration with foreign-key safety', async () => {
    const { database, calls } = fakeDatabase();

    await applyDatabaseMigrations(database);

    assert.deepEqual(calls, [
        'PRAGMA foreign_keys = OFF',
        'migrate.latest',
        'PRAGMA foreign_keys = ON',
    ]);
});

test('migration gate re-enables foreign keys and rejects a failed migration', async () => {
    const migrationError = new Error('broken migration');
    const { database, calls } = fakeDatabase({ migrationError });

    await assert.rejects(applyDatabaseMigrations(database), migrationError);
    assert.equal(calls.at(-1), 'PRAGMA foreign_keys = ON');
});

test('migration gate rejects when a migration rejects with undefined', async () => {
    const { database, calls } = fakeDatabase({ migrationRejectsWithUndefined: true });

    await assert.rejects(applyDatabaseMigrations(database));
    assert.equal(calls.at(-1), 'PRAGMA foreign_keys = ON');
});

test('migration gate reports both migration and connection-restoration failures', async () => {
    const migrationError = new Error('broken migration');
    const restoreError = new Error('foreign keys stayed disabled');
    const { database } = fakeDatabase({ migrationError, restoreError });

    await assert.rejects(
        applyDatabaseMigrations(database),
        (error: unknown) => error instanceof AggregateError
            && error.errors.includes(migrationError)
            && error.errors.includes(restoreError),
    );
});

test('migration gate reports an undefined migration rejection with a restoration failure', async () => {
    const restoreError = new Error('foreign keys stayed disabled');
    const { database } = fakeDatabase({
        migrationRejectsWithUndefined: true,
        restoreError,
    });

    await assert.rejects(
        applyDatabaseMigrations(database),
        (error: unknown) => error instanceof AggregateError
            && error.errors.length === 2
            && error.errors[0] === undefined
            && error.errors[1] === restoreError,
    );
});
