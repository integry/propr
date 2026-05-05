import { db } from '../db/connection.js';
import logger from '../utils/logger.js';

/**
 * Helper to get a config value from DB with a fallback.
 * Exported for reuse by sibling config modules.
 */
export async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
    try {
        const result = await db('system_configs').where({ key }).first();
        if (result && result.value !== undefined && result.value !== null) {
            return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
        }
        return defaultValue;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, key }, 'Failed to load config from DB');
        return defaultValue;
    }
}

/**
 * Helper to save a config value to DB.
 * Exported for reuse by sibling config modules.
 */
export async function saveConfig<T>(key: string, value: T): Promise<boolean> {
    try {
        const jsonValue = JSON.stringify(value);
        await db('system_configs')
            .insert({
                key,
                value: jsonValue,
                updated_at: db.fn.now(),
                created_at: db.fn.now()
            })
            .onConflict('key')
            .merge({
                value: jsonValue,
                updated_at: db.fn.now()
            });
        return true;
    } catch (error) {
        const err = error as Error;
        logger.error({ error: err.message, key }, 'Failed to save config to DB');
        throw error;
    }
}
