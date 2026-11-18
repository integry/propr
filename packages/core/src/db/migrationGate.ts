import { readdir } from 'node:fs/promises';

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

/** Read-only view of the database used to compare applied migrations with this build's directory. */
export interface AppliedMigrationSource {
    schema: { hasTable(tableName: string): PromiseLike<boolean> };
    select(column: string): { from(tableName: string): PromiseLike<Array<{ name: string }>> };
}

// The file extensions knex loads from a migration directory (its default loadExtensions).
const MIGRATION_FILE = /\.(?:co|coffee|eg|iced|js|cjs|litcoffee|mjs|ls|ts)$/;

/**
 * Thrown before any migration runs when the database records migrations this
 * build does not ship: a newer ProPR version upgraded it. Knex would otherwise
 * report a "corrupt" migration directory, which sends operators looking for
 * damaged files instead of the version mismatch.
 */
export class DatabaseNewerThanCodeError extends Error {
    readonly newerMigrations: string[];

    constructor(newerMigrations: string[]) {
        const latest = [...newerMigrations].sort().at(-1);
        super(`This database was migrated by a newer ProPR version (${newerMigrations.length} newer migrations, latest: ${latest}). Start that version or newer, or restore a backup taken before the upgrade.`);
        this.name = 'DatabaseNewerThanCodeError';
        this.newerMigrations = newerMigrations;
    }
}

/** Applied migration names that are missing from `directory`, in application order. */
export async function findNewerMigrations(
    database: AppliedMigrationSource,
    directory: string,
    tableName = 'knex_migrations',
): Promise<string[]> {
    // A blank database has no migration table yet; knex creates it on first run.
    if (!(await database.schema.hasTable(tableName))) return [];
    const shipped = new Set((await readdir(directory)).filter(name => MIGRATION_FILE.test(name)));
    const applied = await database.select('name').from(tableName);
    return applied.map(row => row.name).filter(name => !shipped.has(name));
}

/** Refuse to migrate a database that a newer ProPR version already upgraded. */
export async function assertDatabaseNotNewerThanCode(
    database: AppliedMigrationSource,
    directory: string,
    tableName = 'knex_migrations',
): Promise<void> {
    const newer = await findNewerMigrations(database, directory, tableName);
    if (newer.length > 0) throw new DatabaseNewerThanCodeError(newer);
}
