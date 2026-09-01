export interface MigrationDatabase {
    raw(sql: string): Promise<unknown>;
    migrate: {
        latest(): Promise<unknown>;
    };
}

export interface MigrationGateOptions {
    lockRetryAttempts?: number;
    lockRetryDelayMs?: number;
    wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MIGRATION_LOCK_RETRY_ATTEMPTS = 60;
const DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS = 1_000;

function isMigrationLockError(error: unknown): error is Error {
    return error instanceof Error
        && (error.name === 'MigrationLocked'
            || error.message === 'Migration table is already locked');
}

async function migrateWithLockRetry(
    database: MigrationDatabase,
    options: MigrationGateOptions,
): Promise<void> {
    const retryAttempts = options.lockRetryAttempts
        ?? DEFAULT_MIGRATION_LOCK_RETRY_ATTEMPTS;
    const retryDelayMs = options.lockRetryDelayMs
        ?? DEFAULT_MIGRATION_LOCK_RETRY_DELAY_MS;
    const wait = options.wait
        ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

    for (let attempt = 0; ; attempt += 1) {
        try {
            await database.migrate.latest();
            return;
        } catch (error) {
            if (!isMigrationLockError(error) || attempt >= retryAttempts) throw error;
            await wait(retryDelayMs);
        }
    }
}

/**
 * Apply every pending migration before a process is allowed to start.
 *
 * SQLite foreign keys are disabled only for the migration window because some
 * schema changes recreate tables. Re-enabling them is part of the gate: either
 * operation failing rejects startup instead of leaving a process on an unknown
 * schema or connection state.
 */
export async function applyDatabaseMigrations(
    database: MigrationDatabase,
    options: MigrationGateOptions = {},
): Promise<void> {
    await database.raw('PRAGMA foreign_keys = OFF');

    let migrationFailed = false;
    let migrationFailure: unknown;
    try {
        await migrateWithLockRetry(database, options);
    } catch (error) {
        migrationFailed = true;
        migrationFailure = error;
    }

    try {
        await database.raw('PRAGMA foreign_keys = ON');
    } catch (restoreError) {
        if (migrationFailed) {
            throw new AggregateError(
                [migrationFailure, restoreError],
                'Database migration failed and foreign keys could not be re-enabled',
            );
        }
        throw restoreError;
    }

    if (migrationFailed) throw migrationFailure;
}
