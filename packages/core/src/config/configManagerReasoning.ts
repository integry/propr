import {
    CLAUDE_REASONING_LEVELS,
    CODEX_REASONING_LEVELS,
    REASONING_LEVELS,
    getReasoningLevelsForAgentType,
    isReasoningLevelSupportedByAgentType,
    isReasoningLevel,
    type AgentType,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';

export type ModelReasoningLevel = ReasoningLevel | '';

const CODEX_RUNTIME_REASONING_LEVELS: readonly ReasoningLevel[] = CODEX_REASONING_LEVELS;
const CLAUDE_RUNTIME_REASONING_LEVELS: readonly ReasoningLevel[] = CLAUDE_REASONING_LEVELS.filter(level => level !== 'auto');

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

export function validateModelReasoningLevelForAgentType(
    raw: unknown,
    agentType: AgentType
): { valid: true; value: ModelReasoningLevel } | { valid: false; error: string } {
    const result = validateModelReasoningLevel(raw);
    if (!result.valid || result.value === '') return result;
    if (isReasoningLevelSupportedByAgentType(agentType, result.value)) return result;

    const values = getReasoningLevelsForAgentType(agentType).join(', ');
    const supportedText = values ? `${values}, or an empty string` : 'an empty string';
    return {
        valid: false,
        error: `model_reasoning_level "${result.value}" is not supported by ${agentType} agents; use ${supportedText}`
    };
}

export function resolveRuntimeModelReasoningLevel(
    agentType: AgentType,
    level: ModelReasoningLevel
): ReasoningLevel | null {
    if (level === '') return null;
    if (agentType === 'codex' && CODEX_RUNTIME_REASONING_LEVELS.includes(level)) return level;
    if (agentType === 'claude' && CLAUDE_RUNTIME_REASONING_LEVELS.includes(level)) return level;

    logger.warn({ agentType, model_reasoning_level: level }, 'Ignoring unsupported model reasoning level for agent runtime');
    return null;
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
