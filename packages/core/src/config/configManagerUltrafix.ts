import logger from '../utils/logger.js';
import { db } from '../db/connection.js';

async function getConfig<T>(key: string, defaultValue: T): Promise<T> {
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

async function saveConfig<T>(key: string, value: T): Promise<boolean> {
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

// --- PR Review Model ---

export async function loadPrReviewModel(): Promise<string> {
    const model = await getConfig<string>('pr_review_model', '');
    if (typeof model !== 'string') {
        logger.warn({ stored_value: model }, 'Invalid pr_review_model in DB, using default');
        return '';
    }
    logger.info({ pr_review_model: model }, 'Successfully loaded PR review model');
    return model;
}

export async function savePrReviewModel(model: string): Promise<boolean> {
    await saveConfig('pr_review_model', model);
    logger.info({ pr_review_model: model }, 'Successfully saved PR review model');
    return true;
}

// --- Ultrafix Settings ---

const DEFAULT_ULTRAFIX_RATING_GOAL = 7;
const DEFAULT_ULTRAFIX_MAX_CYCLES = 5;
const DEFAULT_ULTRAFIX_PAUSE_SECONDS = 60;

export async function loadUltrafixRatingGoal(): Promise<number> {
    const goal = await getConfig<number>('ultrafix_rating_goal', DEFAULT_ULTRAFIX_RATING_GOAL);
    if (typeof goal !== 'number' || isNaN(goal) || goal < 1 || goal > 10) {
        logger.warn({ stored_value: goal }, 'Invalid ultrafix_rating_goal in DB, using default');
        return DEFAULT_ULTRAFIX_RATING_GOAL;
    }
    logger.info({ ultrafix_rating_goal: goal }, 'Successfully loaded ultrafix rating goal');
    return goal;
}

export async function saveUltrafixRatingGoal(goal: number): Promise<boolean> {
    const value = Math.floor(goal);
    if (isNaN(value) || value < 1 || value > 10) {
        throw new Error('ultrafix_rating_goal must be an integer between 1 and 10');
    }
    await saveConfig('ultrafix_rating_goal', value);
    logger.info({ ultrafix_rating_goal: value }, 'Successfully saved ultrafix rating goal');
    return true;
}

export async function loadUltrafixMaxCycles(): Promise<number> {
    const cycles = await getConfig<number>('ultrafix_max_cycles', DEFAULT_ULTRAFIX_MAX_CYCLES);
    if (typeof cycles !== 'number' || isNaN(cycles) || !Number.isInteger(cycles) || cycles < 1) {
        logger.warn({ stored_value: cycles }, 'Invalid ultrafix_max_cycles in DB, using default');
        return DEFAULT_ULTRAFIX_MAX_CYCLES;
    }
    logger.info({ ultrafix_max_cycles: cycles }, 'Successfully loaded ultrafix max cycles');
    return cycles;
}

export async function saveUltrafixMaxCycles(cycles: number): Promise<boolean> {
    const value = Math.floor(cycles);
    if (isNaN(value) || value < 1) {
        throw new Error('ultrafix_max_cycles must be a positive integer');
    }
    await saveConfig('ultrafix_max_cycles', value);
    logger.info({ ultrafix_max_cycles: value }, 'Successfully saved ultrafix max cycles');
    return true;
}

export async function loadUltrafixPauseSeconds(): Promise<number> {
    const pause = await getConfig<number>('ultrafix_pause_seconds', DEFAULT_ULTRAFIX_PAUSE_SECONDS);
    if (typeof pause !== 'number' || isNaN(pause) || !Number.isInteger(pause) || pause < 0) {
        logger.warn({ stored_value: pause }, 'Invalid ultrafix_pause_seconds in DB, using default');
        return DEFAULT_ULTRAFIX_PAUSE_SECONDS;
    }
    logger.info({ ultrafix_pause_seconds: pause }, 'Successfully loaded ultrafix pause seconds');
    return pause;
}

export async function saveUltrafixPauseSeconds(seconds: number): Promise<boolean> {
    const value = Math.floor(seconds);
    if (isNaN(value) || value < 0) {
        throw new Error('ultrafix_pause_seconds must be a non-negative integer');
    }
    await saveConfig('ultrafix_pause_seconds', value);
    logger.info({ ultrafix_pause_seconds: value }, 'Successfully saved ultrafix pause seconds');
    return true;
}
