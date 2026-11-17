import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyDatabaseMigrations,
    assertDatabaseNotNewerThanCode,
    DatabaseNewerThanCodeError,
    findNewerMigrations,
    type AppliedMigrationSource,
    type MigrationDatabase,
} from '../packages/core/src/db/migrationGate.js';

function fakeDatabase(options: {
    migrationError?: Error;
    migrationErrors?: Error[];
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
                    const migrationError = options.migrationErrors?.shift();
                    if (migrationError) throw migrationError;
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

test('migration gate waits for a concurrent migrator and retries the lock', async () => {
    const migrationLock = new Error('Migration table is already locked');
    migrationLock.name = 'MigrationLocked';
    const { database, calls } = fakeDatabase({ migrationErrors: [migrationLock] });
    const waits: number[] = [];

    await applyDatabaseMigrations(database, {
        lockRetryDelayMs: 25,
        wait: async milliseconds => { waits.push(milliseconds); },
    });

    assert.deepEqual(waits, [25]);
    assert.deepEqual(calls, [
        'PRAGMA foreign_keys = OFF',
        'migrate.latest',
        'migrate.latest',
        'PRAGMA foreign_keys = ON',
    ]);
});

test('migration gate rejects after exhausting migration lock retries', async () => {
    const firstLock = new Error('Migration table is already locked');
    firstLock.name = 'MigrationLocked';
    const finalLock = new Error('Migration table is already locked');
    finalLock.name = 'MigrationLocked';
    const { database, calls } = fakeDatabase({
        migrationErrors: [firstLock, finalLock],
    });

    await assert.rejects(
        applyDatabaseMigrations(database, {
            lockRetryAttempts: 1,
            wait: async () => undefined,
        }),
        finalLock,
    );
    assert.deepEqual(calls, [
        'PRAGMA foreign_keys = OFF',
        'migrate.latest',
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

function appliedMigrations(names: string[] | null): AppliedMigrationSource {
    return {
        schema: { hasTable: async () => names !== null },
        select: () => ({ from: async () => (names ?? []).map(name => ({ name })) }),
    };
}

async function withMigrationDirectory(files: string[], run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'propr-migration-directory-'));
    try {
        for (const file of files) await writeFile(join(directory, file), '');
        await run(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('newer-database check passes a blank, current or behind database', async () => {
    await withMigrationDirectory(['001_a.js', '002_b.js', 'README.md'], async directory => {
        assert.deepEqual(await findNewerMigrations(appliedMigrations(null), directory), []);
        assert.deepEqual(await findNewerMigrations(appliedMigrations(['001_a.js']), directory), []);
        await assertDatabaseNotNewerThanCode(appliedMigrations(['001_a.js', '002_b.js']), directory);
    });
});

test('newer-database check names how many migrations are newer and the latest one', async () => {
    await withMigrationDirectory(['001_a.js'], async directory => {
        const database = appliedMigrations(['001_a.js', '003_newest.js', '002_newer.js']);
        assert.deepEqual(await findNewerMigrations(database, directory), ['003_newest.js', '002_newer.js']);
        await assert.rejects(
            assertDatabaseNotNewerThanCode(database, directory),
            (error: unknown) => error instanceof DatabaseNewerThanCodeError
                && error.message === 'This database was migrated by a newer ProPR version (2 newer migrations, latest: 003_newest.js). Start that version or newer, or restore a backup taken before the upgrade.',
        );
    });
});
