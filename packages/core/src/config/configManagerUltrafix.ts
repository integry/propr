import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configManager.js';
import { validatePrReviewModelValue } from './prReviewModelValidator.js';

// --- PR Review Model ---

export async function loadPrReviewModel(): Promise<string> {
    const model = await getConfig<string>('pr_review_model', '');
    if (typeof model !== 'string') {
        logger.warn({ stored_value: model }, 'Invalid pr_review_model in DB, using default');
        return '';
    }
    if (model !== '') {
        const result = await validatePrReviewModelValue(model);
        if (!result.valid) {
            logger.warn({ stored_value: model, reason: result.error }, 'Stored pr_review_model is no longer valid, using default');
            return '';
        }
    }
    logger.info({ pr_review_model: model }, 'Successfully loaded PR review model');
    return model;
}

export async function savePrReviewModel(model: string): Promise<boolean> {
    if (typeof model !== 'string') {
        throw new Error('pr_review_model must be a string');
    }
    const result = await validatePrReviewModelValue(model);
    if (!result.valid) {
        throw new Error(result.error ?? 'pr_review_model validation failed');
    }
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
    if (!Number.isInteger(goal) || goal < 1 || goal > 10) {
        throw new Error('ultrafix_rating_goal must be an integer between 1 and 10');
    }
    await saveConfig('ultrafix_rating_goal', goal);
    logger.info({ ultrafix_rating_goal: goal }, 'Successfully saved ultrafix rating goal');
    return true;
}

export async function loadUltrafixMaxCycles(): Promise<number> {
    const cycles = await getConfig<number>('ultrafix_max_cycles', DEFAULT_ULTRAFIX_MAX_CYCLES);
    if (typeof cycles !== 'number' || isNaN(cycles) || !Number.isSafeInteger(cycles) || cycles < 1) {
        logger.warn({ stored_value: cycles }, 'Invalid ultrafix_max_cycles in DB, using default');
        return DEFAULT_ULTRAFIX_MAX_CYCLES;
    }
    logger.info({ ultrafix_max_cycles: cycles }, 'Successfully loaded ultrafix max cycles');
    return cycles;
}

export async function saveUltrafixMaxCycles(cycles: number): Promise<boolean> {
    if (!Number.isInteger(cycles) || cycles < 1 || !Number.isSafeInteger(cycles)) {
        throw new Error('ultrafix_max_cycles must be a positive safe integer');
    }
    await saveConfig('ultrafix_max_cycles', cycles);
    logger.info({ ultrafix_max_cycles: cycles }, 'Successfully saved ultrafix max cycles');
    return true;
}

export async function loadUltrafixPauseSeconds(): Promise<number> {
    const pause = await getConfig<number>('ultrafix_pause_seconds', DEFAULT_ULTRAFIX_PAUSE_SECONDS);
    if (typeof pause !== 'number' || isNaN(pause) || !Number.isSafeInteger(pause) || pause < 0) {
        logger.warn({ stored_value: pause }, 'Invalid ultrafix_pause_seconds in DB, using default');
        return DEFAULT_ULTRAFIX_PAUSE_SECONDS;
    }
    logger.info({ ultrafix_pause_seconds: pause }, 'Successfully loaded ultrafix pause seconds');
    return pause;
}

export async function saveUltrafixPauseSeconds(seconds: number): Promise<boolean> {
    if (!Number.isInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds)) {
        throw new Error('ultrafix_pause_seconds must be a non-negative safe integer');
    }
    await saveConfig('ultrafix_pause_seconds', seconds);
    logger.info({ ultrafix_pause_seconds: seconds }, 'Successfully saved ultrafix pause seconds');
    return true;
}
