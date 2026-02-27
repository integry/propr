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

    db = knex(config);

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
    try {
        logger.info('Running database migrations...');

        // Disable foreign keys during migrations to prevent cascade deletes
        // when tables are recreated (common in SQLite ALTER TABLE operations)
        await db.raw('PRAGMA foreign_keys = OFF');
        logger.info('Disabled foreign keys for migration safety');

        try {
            await db.migrate.latest();
            logger.info('Database migrations completed successfully');
        } finally {
            // Re-enable foreign keys after migrations
            await db.raw('PRAGMA foreign_keys = ON');
            logger.info('Re-enabled foreign keys after migrations');
        }
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
