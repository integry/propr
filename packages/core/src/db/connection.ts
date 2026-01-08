import knex, { Knex } from 'knex';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type KnexEnvironment = 'development' | 'production' | 'test';

// Get database filename from env or use default
function getDbFilename(): string {
    if (process.env.DB_FILENAME) {
        return process.env.DB_FILENAME;
    }
    // Default path: /usr/src/app/data/gitfix.sqlite (inside container)
    // or ./data/gitfix.sqlite (local development)
    const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
    return path.join(dataDir, 'gitfix.sqlite');
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
    const testDbFilename = path.join(path.dirname(dbFilename), 'gitfix.test.sqlite');

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
                afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
                    conn.pragma('foreign_keys = ON');
                    done(null);
                }
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
                afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
                    conn.pragma('foreign_keys = ON');
                    done(null);
                }
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
                afterCreate: (conn: { pragma: (arg: string) => void }, done: (err: Error | null) => void) => {
                    conn.pragma('foreign_keys = ON');
                    done(null);
                }
            }
        }
    };
}

// Lazy-loaded database connection - only created when actually needed
let _db: Knex | null = null;
let dbInitialized = false;

/**
 * Get the database connection, creating it lazily if needed.
 * This avoids creating connections at module load time which can
 * keep the process alive and prevent tests from exiting cleanly.
 */
export function getDb(): Knex {
    if (!_db) {
        const environment = (process.env.NODE_ENV ?? 'development') as KnexEnvironment;
        const knexConfig = createKnexConfig();
        const config = knexConfig[environment];

        if (!config) {
            throw new Error(`No database configuration found for environment: ${environment}`);
        }

        const dbFilename = (config.connection as { filename: string }).filename;

        // Ensure data directory exists
        ensureDataDirectory(dbFilename);

        _db = knex(config);
        dbInitialized = true;

        // Test connection (non-blocking)
        _db.raw('SELECT 1')
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
    }
    return _db;
}

/**
 * Check if database resources have been initialized. Useful for tests.
 */
export function hasDbResources(): boolean {
    return dbInitialized;
}

/**
 * Backwards compatibility: db object that lazily initializes on first property access.
 * This allows existing code using `db.` to continue working without changes,
 * while still benefiting from lazy initialization.
 */
export const db: Knex = new Proxy({} as Knex, {
    get(_target, prop) {
        return Reflect.get(getDb(), prop);
    },
    set(_target, prop, value) {
        return Reflect.set(getDb(), prop, value);
    }
});

export function createKnexConfigForMigrations(): Record<KnexEnvironment, Knex.Config> {
    return createKnexConfig();
}

export async function runMigrations(): Promise<void> {
    try {
        logger.info('Running database migrations...');
        await getDb().migrate.latest();
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
    if (_db && dbInitialized) {
        try {
            await _db.destroy();
            logger.info('SQLite database connection closed');
        } catch (error) {
            const err = error as Error;
            logger.error({
                error: err.message
            }, 'Error closing SQLite database connection');
        }
        _db = null;
        dbInitialized = false;
    }
}
