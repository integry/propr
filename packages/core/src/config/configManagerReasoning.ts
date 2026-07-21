import {
    REASONING_LEVELS,
    normalizeModelReasoningLevel,
    type AgentType,
    type ModelReasoningLevel,
    type ReasoningLevel
} from '@propr/shared';
import logger from '../utils/logger.js';
import { getConfig, saveConfig } from './configStore.js';

export { normalizeModelReasoningLevel };
export type { ModelReasoningLevel };

export type CodexRuntimeReasoningLevel = Exclude<ReasoningLevel, 'auto' | 'ultracode'>;
export type ClaudeRuntimeReasoningLevel = Exclude<ReasoningLevel, 'ultra'>;
export type RuntimeReasoningLevel = CodexRuntimeReasoningLevel | ClaudeRuntimeReasoningLevel;

const REASONING_LEVEL_MIN_CLI_VERSION: Partial<Record<AgentType, string>> = {
    claude: '2.1.68',
    codex: '0.144.0'
};

function parseSemverParts(version: string): [number, number, number] | null {
    // The gate only needs the semver core; prerelease/build suffixes are ignored deliberately.
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverish(left: string, right: string): number | null {
    const leftParts = parseSemverParts(left);
    const rightParts = parseSemverParts(right);
    if (!leftParts || !rightParts) return null;
    for (let index = 0; index < leftParts.length; index += 1) {
        const diff = leftParts[index] - rightParts[index];
        if (diff !== 0) return diff;
    }
    return 0;
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

export function resolveCodexReasoningLevel(level: ModelReasoningLevel): CodexRuntimeReasoningLevel | null {
    if (level === '' || level === 'auto') return null;
    if (level === 'ultracode') return 'ultra';
    return level;
}

export function resolveClaudeReasoningLevel(level: ModelReasoningLevel): ClaudeRuntimeReasoningLevel | null {
    if (level === '') return null;
    if (level === 'ultra') return 'max';
    return level;
}

export function resolveRuntimeModelReasoningLevel(
    agentType: AgentType,
    level: ModelReasoningLevel
): RuntimeReasoningLevel | null {
    if (agentType === 'codex') return resolveCodexReasoningLevel(level);
    if (agentType === 'claude') return resolveClaudeReasoningLevel(level);
    return null;
}

export function assertReasoningLevelCliVersionSupported({
    agentType,
    agentAlias,
    cliVersion,
    reasoningLevel
}: {
    agentType: AgentType;
    agentAlias?: string;
    cliVersion?: string;
    reasoningLevel: RuntimeReasoningLevel | '';
}): void {
    if (!reasoningLevel) return;
    const minimumVersion = REASONING_LEVEL_MIN_CLI_VERSION[agentType];
    if (!minimumVersion || !cliVersion) return;

    const comparison = compareSemverish(cliVersion, minimumVersion);
    if (comparison === null || comparison >= 0) return;

    const aliasText = agentAlias ? ` '${agentAlias}'` : '';
    throw new Error(
        `${agentType} agent${aliasText} is pinned to CLI ${cliVersion}, but model_reasoning_level requires ` +
        `${agentType} CLI ${minimumVersion} or newer. Update the agent CLI version or clear model_reasoning_level.`
    );
}

export async function loadModelReasoningLevel(): Promise<ModelReasoningLevel> {
    const level = await getConfig<unknown>('model_reasoning_level', '');
    const result = validateModelReasoningLevel(level);
    if (!result.valid) {
        logger.warn({ stored_value: level, reason: result.error }, 'Invalid model_reasoning_level in DB, using agent default');
        return '';
    }
    logger.debug({ model_reasoning_level: result.value }, 'Successfully loaded model reasoning level');
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
