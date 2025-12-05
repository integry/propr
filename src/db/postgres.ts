import knex, { Knex } from 'knex';
import knexConfig from '../../knexfile.js';
import logger from '../utils/logger.js';

const isEnabled: boolean = process.env.ENABLE_DB_PERSISTENCE === 'true';

type KnexEnvironment = 'development' | 'production';

interface KnexConfigFile {
    development: Knex.Config;
    production: Knex.Config;
}

let db: Knex | null = null;

if (!isEnabled) {
    logger.info('PostgreSQL persistence is disabled (ENABLE_DB_PERSISTENCE != true)');
} else {
    try {
        const environment = (process.env.NODE_ENV ?? 'development') as KnexEnvironment;
        const config = (knexConfig as KnexConfigFile)[environment];

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
