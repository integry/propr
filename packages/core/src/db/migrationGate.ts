export interface MigrationDatabase {
    raw(sql: string): Promise<unknown>;
    migrate: {
        latest(): Promise<unknown>;
    };
}

/**
 * Apply every pending migration before a process is allowed to start.
 *
 * SQLite foreign keys are disabled only for the migration window because some
 * schema changes recreate tables. Re-enabling them is part of the gate: either
 * operation failing rejects startup instead of leaving a process on an unknown
 * schema or connection state.
 */
export async function applyDatabaseMigrations(database: MigrationDatabase): Promise<void> {
    await database.raw('PRAGMA foreign_keys = OFF');

    let migrationFailed = false;
    let migrationFailure: unknown;
    try {
        await database.migrate.latest();
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
