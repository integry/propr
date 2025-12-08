import knex, { Knex } from 'knex';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isEnabled: boolean = process.env.ENABLE_DB_PERSISTENCE === 'true';

type KnexEnvironment = 'development' | 'production';

function createKnexConfig(): Record<KnexEnvironment, Knex.Config> {
    return {
        development: {
            client: 'pg',
            connection: {
                host: process.env.DB_HOST ?? 'localhost',
                port: parseInt(process.env.DB_PORT ?? '5432', 10),
                user: process.env.DB_USER ?? 'gitfix_user',
                password: process.env.DB_PASSWORD ?? 'gitfix_password',
                database: process.env.DB_NAME ?? 'gitfix_history'
            },
            migrations: {
                directory: path.join(__dirname, 'migrations'),
                tableName: 'knex_migrations'
            },
            pool: {
                min: 2,
                max: 10
            }
        },
        production: {
            client: 'pg',
            connection: {
                host: process.env.DB_HOST ?? 'db',
                port: parseInt(process.env.DB_PORT ?? '5432', 10),
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME
            },
            migrations: {
                directory: path.join(__dirname, 'migrations'),
                tableName: 'knex_migrations'
            },
            pool: {
                min: 2,
                max: 20
            }
        }
    };
}

let db: Knex | null = null;

if (!isEnabled) {
    logger.info('PostgreSQL persistence is disabled (ENABLE_DB_PERSISTENCE != true)');
} else {
    try {
        const environment = (process.env.NODE_ENV ?? 'development') as KnexEnvironment;
        const knexConfig = createKnexConfig();
        const config = knexConfig[environment];

        if (!config) {
            throw new Error(`No database configuration found for environment: ${environment}`);
        }

        db = knex(config);

        const connectionConfig = config.connection as Knex.PgConnectionConfig;

        db.raw('SELECT 1')
            .then(() => {
                logger.info({
                    host: connectionConfig.host,
                    database: connectionConfig.database,
                    environment
                }, 'PostgreSQL connection established successfully');
            })
            .catch((error: Error) => {
                logger.error({
                    error: error.message,
                    host: connectionConfig.host,
                    database: connectionConfig.database
                }, 'PostgreSQL connection test failed - application will continue in fallback mode');
            });

    } catch (error) {
        const err = error as Error;
        logger.error({
            error: err.message,
            stack: err.stack
        }, 'Failed to initialize PostgreSQL connection - application will continue in fallback mode');
        db = null;
    }
}

export { db, isEnabled };

export function createKnexConfigForMigrations(): Record<KnexEnvironment, Knex.Config> {
    return createKnexConfig();
}

export async function closeConnection(): Promise<void> {
    if (db) {
        try {
            await db.destroy();
            logger.info('PostgreSQL connection closed');
        } catch (error) {
            const err = error as Error;
            logger.error({
                error: err.message
            }, 'Error closing PostgreSQL connection');
        }
    }
}
