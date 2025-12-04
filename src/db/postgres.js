import knex from 'knex'; 
import knexConfig from '../../knexfile.js';
import logger from '../utils/logger.js';

const isEnabled = process.env.ENABLE_DB_PERSISTENCE === 'true';

let db = null;

if (!isEnabled) {
  logger.info('PostgreSQL persistence is disabled (ENABLE_DB_PERSISTENCE != true)');
} else {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const config = knexConfig[environment];
    
    if (!config) {
      throw new Error(`No database configuration found for environment: ${environment}`);
    }
    
    db = knex(config);
    
    db.raw('SELECT 1')
      .then(() => {
        logger.info({
          host: config.connection.host,
          database: config.connection.database,
          environment
        }, 'PostgreSQL connection established successfully');
      })
      .catch((error) => {
        logger.error({
          error: error.message,
          host: config.connection.host,
          database: config.connection.database
        }, 'PostgreSQL connection test failed - application will continue in fallback mode');
      });
    
  } catch (error) {
    logger.error({
      error: error.message,
      stack: error.stack
    }, 'Failed to initialize PostgreSQL connection - application will continue in fallback mode');
    db = null;
  }
}

export { db, isEnabled };
 
export async function closeConnection() {
  if (db) {
    try {
      await db.destroy();
      logger.info('PostgreSQL connection closed');
    } catch (error) {
      logger.error({
        error: error.message
      }, 'Error closing PostgreSQL connection');
    }
  }
}
