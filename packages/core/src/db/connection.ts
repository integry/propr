import { assertConfiguredResetGeneration, configuredResetFence } from '../fleet/resetFence.js';
import knex, { Knex } from 'knex';
import type { Readable } from 'node:stream';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { applyDatabaseMigrations } from './migrationGate.js';
import { installSqliteRetry } from './sqliteRetry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type KnexEnvironment = 'development' | 'production' | 'test';
export type BetterSqliteConnection = {
    pragma: (arg: string, options?: { simple?: boolean }) => unknown;
};

const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 30000;

function getSqliteBusyTimeoutMs(): number {
    const parsed = Number(process.env.SQLITE_BUSY_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
}

export function configureSqliteConnection(conn: BetterSqliteConnection): void {
    conn.pragma(`busy_timeout = ${getSqliteBusyTimeoutMs()}`);
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
    conn.pragma('foreign_keys = ON');
    conn.pragma('recursive_triggers = ON');

    if (conn.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error('SQLite foreign_keys pragma must be enabled');
    }
    if (conn.pragma('recursive_triggers', { simple: true }) !== 1) {
        throw new Error('SQLite recursive_triggers pragma must be enabled');
    }
}

export function configurePooledSqliteConnection(
    conn: BetterSqliteConnection,
    done: (err: Error | null, connection?: BetterSqliteConnection) => void
): void {
    try {
        configureSqliteConnection(conn);
        done(null, conn);
    } catch (error) {
        done(error as Error);
    }
}

// Get database filename from env or use default
function getDbFilename(): string {
    if (process.env.DB_FILENAME) {
        return process.env.DB_FILENAME;
    }
    // Default path: /usr/src/app/data/propr.sqlite (inside container)
    // or ./data/propr.sqlite (local development)
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
    return path.join(dataDir, 'propr.sqlite');
}

function ensureDataDirectory(filename: string): void {
    const dir = path.dirname(filename);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        logger.info({ directory: dir }, 'Created data directory for SQLite database');
    }
}

function createKnexConfig(): Record<KnexEnvironment, Knex.Config> {
    const dbFilename = getDbFilename();
    const testDbFilename = path.join(path.dirname(dbFilename), 'propr.test.sqlite');

    return {
        development: {
            client: 'better-sqlite3',
            connection: {
                filename: dbFilename
            },
            useNullAsDefault: true,
            migrations: {
                directory: path.join(__dirname, 'migrations'),
                tableName: 'knex_migrations'
            },
            pool: {
                afterCreate: configurePooledSqliteConnection
            }
        },
        production: {
            client: 'better-sqlite3',
            connection: {
                filename: dbFilename
            },
            useNullAsDefault: true,
            migrations: {
                directory: path.join(__dirname, 'migrations'),
                tableName: 'knex_migrations'
            },
            pool: {
                afterCreate: configurePooledSqliteConnection
            }
        },
        test: {
            client: 'better-sqlite3',
            connection: {
                filename: testDbFilename
            },
            useNullAsDefault: true,
            migrations: {
                directory: path.join(__dirname, 'migrations'),
                tableName: 'knex_migrations'
            },
            pool: {
                afterCreate: configurePooledSqliteConnection
            }
        }
    };
}

let db: Knex;

try {
    const environment = (process.env.NODE_ENV ?? 'development') as KnexEnvironment;
    const knexConfig = createKnexConfig();
    const config = knexConfig[environment];

    if (!config) {
        throw new Error(`No database configuration found for environment: ${environment}`);
    }

    const dbFilename = (config.connection as { filename: string }).filename;

    // Ensure data directory exists
    ensureDataDirectory(dbFilename);

    assertConfiguredResetGeneration();
    db = knex(config);
    // Knex schema queries can omit __knexQueryUid, and BEGIN/COMMIT bypass
    // Runner's query-response event altogether. Correlate by invocation instead
    // of event IDs. Transaction clients inherit this prototype and config.
    installSqliteRetry(db);
    const client = db.client;
    const prototype = client.constructor.prototype;
    const managedConfig = client.config;
    for (const method of ['query', 'stream'] as const) {
        const run = prototype[method];
        prototype[method] = async function (...args: unknown[]) {
            const managed = this.config === managedConfig ? configuredResetFence() : undefined;
            let release: (() => void) | undefined;
            try { release = managed?.fence.acquire(managed.identity, 'database-query'); }
            catch (error) {
                // Knex assumes errors after stream connection acquisition have
                // already reached the stream. Refusal must also close it so the
                // caller observes the error and Knex releases the connection.
                if (method === 'stream') (args[2] as Readable).destroy(error as Error);
                throw error;
            }
            try { return await run.apply(this, args); }
            finally { release?.(); }
        };
    }

    // Test connection
    db.raw('SELECT 1')
        .then(() => {
            logger.info({
                filename: dbFilename,
                environment
            }, 'SQLite database connection established successfully');
        })
        .catch((error: Error) => {
            logger.error({
                error: error.message,
                filename: dbFilename
            }, 'SQLite database connection test failed');
        });

} catch (error) {
    const err = error as Error;
    logger.error({
        error: err.message,
        stack: err.stack
    }, 'Failed to initialize SQLite database connection');
    throw err;
}

export { db };

export function createKnexConfigForMigrations(): Record<KnexEnvironment, Knex.Config> {
    return createKnexConfig();
}

export async function runMigrations(): Promise<void> {
    if (process.env.PROPR_MIGRATIONS_PREAPPLIED === '1') {
        logger.info('Database migrations were completed by the launcher migration phase');
        return;
    }

    try {
        logger.info('Running database migrations...');

        await applyDatabaseMigrations(db);
        logger.info('Database migrations completed successfully');
    } catch (error) {
        const err = error as Error;
        logger.error({
            error: err.message,
            stack: err.stack
        }, 'Failed to run database migrations');
        throw err;
    }
}

export async function closeConnection(): Promise<void> {
    if (db) {
        try {
            await db.destroy();
            logger.info('SQLite database connection closed');
        } catch (error) {
            const err = error as Error;
            logger.error({
                error: err.message
            }, 'Error closing SQLite database connection');
        }
    }
}
