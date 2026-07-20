import {
    REASONING_LEVELS,
    isReasoningLevel,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';

export type ModelReasoningLevel = ReasoningLevel | '';

export function normalizeModelReasoningLevel(raw: string): ModelReasoningLevel | null {
    const trimmed = raw.trim();
    if (trimmed === '') return raw.length === 0 ? '' : null;
    const normalized = trimmed.toLowerCase();
    return isReasoningLevel(normalized) ? normalized : null;
}

export function validateModelReasoningLevel(raw: unknown): { valid: true; value: ModelReasoningLevel } | { valid: false; error: string } {
    if (typeof raw !== 'string') {
        return { valid: false, error: 'model_reasoning_level must be a string' };
    }
    const normalized = normalizeModelReasoningLevel(raw);
    if (normalized === null) {
        const values = REASONING_LEVELS.join(', ');
        if (raw.trim() === '') {
            return { valid: false, error: 'model_reasoning_level must not be whitespace-only; use an empty string to clear' };
        }
        return { valid: false, error: `model_reasoning_level must be one of: ${values}, or an empty string` };
    }
    return { valid: true, value: normalized };
}

export async function loadModelReasoningLevel(): Promise<ModelReasoningLevel> {
    const level = await getConfig<unknown>('model_reasoning_level', '');
    const result = validateModelReasoningLevel(level);
    if (!result.valid) {
        logger.warn({ stored_value: level, reason: result.error }, 'Invalid model_reasoning_level in DB, using agent default');
        return '';
    }
    logger.info({ model_reasoning_level: result.value }, 'Successfully loaded model reasoning level');
    return result.value;
}

export async function saveModelReasoningLevel(level: string): Promise<boolean> {
    const result = validateModelReasoningLevel(level);
    if (!result.valid) {
        throw new Error(result.error);
    }
    await saveConfig('model_reasoning_level', result.value);
    logger.info({ model_reasoning_level: result.value }, 'Successfully saved model reasoning level');
    return true;
}
