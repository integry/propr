import {
    DEFAULT_GOAL_QUESTION_MAX_WAIT_MS,
    GOAL_QUESTION_MAX_WAIT_SETTING,
    MIN_GOAL_QUESTION_MAX_WAIT_MS,
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig } from './configStore.js';

export function isValidGoalQuestionMaxWaitMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_GOAL_QUESTION_MAX_WAIT_MS;
}

/**
 * How long an `ask_operator` question in a Claude goal waits for an answer
 * before the agent is told nobody answered: the instance setting
 * `goal_question_max_wait_ms`, default 24 hours.
 */
export async function loadGoalQuestionMaxWaitMs(): Promise<number> {
    const stored = await getConfig<unknown>(GOAL_QUESTION_MAX_WAIT_SETTING, DEFAULT_GOAL_QUESTION_MAX_WAIT_MS);
    if (!isValidGoalQuestionMaxWaitMs(stored)) {
        logger.warn({ stored_value: stored }, `Invalid ${GOAL_QUESTION_MAX_WAIT_SETTING} in DB, using default`);
        return DEFAULT_GOAL_QUESTION_MAX_WAIT_MS;
    }
    return stored;
}

/** The wait one question may take: the setting, never longer than the attempt may run. */
export function boundGoalQuestionMaxWaitMs(settingMs: number, agentDeadlineMs: number): number {
    return Math.max(1_000, Math.min(settingMs, agentDeadlineMs));
}
