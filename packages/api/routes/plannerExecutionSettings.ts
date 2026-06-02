import { parseExistingContextConfig, type TaskDraftConfig } from '@propr/core';
import {
  buildNormalizedUltrafixUpdate,
  ULTRAFIX_GOAL_MAX,
  ULTRAFIX_GOAL_MIN,
  ULTRAFIX_MAX_CYCLES_MIN,
  validateRunUltrafixValue,
  validateUltrafixPayload,
  validateUltrafixValue
} from './planIssueRouteUtils.js';

export class ExecutionSettingsValidationError extends Error {}
export class ExecutionSettingsContextConfigError extends Error {}

export type DraftExecutionConfig = Partial<TaskDraftConfig> & {
  useEpic?: boolean;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number | null;
  ultrafixMaxCycles?: number | null;
};

function parseExecutionConfigRecord(contextConfig: unknown): Record<string, unknown> {
  if (!contextConfig) return {};
  if (typeof contextConfig !== 'string') {
    if (typeof contextConfig === 'object' && !Array.isArray(contextConfig)) {
      return { ...(contextConfig as Record<string, unknown>) };
    }
    throw new ExecutionSettingsContextConfigError('Failed to parse existing execution settings: context_config must be a JSON object');
  }

  try {
    const parsed = JSON.parse(contextConfig) as unknown;
    if (!parsed) return {};
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new ExecutionSettingsContextConfigError('Failed to parse existing execution settings: context_config must be a JSON object');
  } catch (error) {
    if (error instanceof ExecutionSettingsContextConfigError) throw error;
    throw new ExecutionSettingsContextConfigError(`Failed to parse existing execution settings: ${(error as Error).message}`);
  }
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ExecutionSettingsValidationError(`${fieldName} must be a boolean`);
  return value;
}

function validateUltrafixSettings(body: Record<string, unknown>): void {
  const runUltrafixError = validateRunUltrafixValue(body.runUltrafix, 'runUltrafix');
  if (runUltrafixError) throw new ExecutionSettingsValidationError(runUltrafixError);
  const ultrafixGoalError = validateUltrafixValue(body.ultrafixGoal, 'ultrafixGoal', {
    minimum: ULTRAFIX_GOAL_MIN,
    maximum: ULTRAFIX_GOAL_MAX
  });
  if (ultrafixGoalError) throw new ExecutionSettingsValidationError(ultrafixGoalError);
  const ultrafixMaxCyclesError = validateUltrafixValue(body.ultrafixMaxCycles, 'ultrafixMaxCycles', {
    minimum: ULTRAFIX_MAX_CYCLES_MIN
  });
  if (ultrafixMaxCyclesError) throw new ExecutionSettingsValidationError(ultrafixMaxCyclesError);
  const ultrafixPayloadError = validateUltrafixPayload({
    runUltrafix: body.runUltrafix as boolean | number | null | undefined,
    ultrafixGoal: body.ultrafixGoal as number | null | undefined,
    ultrafixMaxCycles: body.ultrafixMaxCycles as number | null | undefined,
    fieldNames: { run: 'runUltrafix', goal: 'ultrafixGoal', maxCycles: 'ultrafixMaxCycles' }
  });
  if (ultrafixPayloadError) throw new ExecutionSettingsValidationError(ultrafixPayloadError);
}

function applyOptionalExecutionBooleans(
  config: DraftExecutionConfig,
  existingConfig: DraftExecutionConfig,
  useEpic: boolean | undefined,
  autoMerge: boolean | undefined
): DraftExecutionConfig {
  if (useEpic !== undefined || existingConfig.useEpic !== undefined) config.useEpic = useEpic ?? existingConfig.useEpic;
  if (autoMerge !== undefined || existingConfig.autoMerge !== undefined) config.autoMerge = autoMerge ?? existingConfig.autoMerge;
  return config;
}

function resolveNextUltrafixConfig(
  existingConfig: DraftExecutionConfig,
  body: Record<string, unknown>
): Pick<DraftExecutionConfig, 'runUltrafix' | 'ultrafixGoal' | 'ultrafixMaxCycles'> {
  const hasUltrafixGoal = Object.prototype.hasOwnProperty.call(body, 'ultrafixGoal');
  const hasUltrafixMaxCycles = Object.prototype.hasOwnProperty.call(body, 'ultrafixMaxCycles');
  const hasRunUltrafix = Object.prototype.hasOwnProperty.call(body, 'runUltrafix');
  const clearAllUltrafixSettings = hasRunUltrafix && body.runUltrafix === null;
  const clearUltrafixGoal = hasUltrafixGoal && body.ultrafixGoal === null;
  const normalizedUltrafixUpdate = buildNormalizedUltrafixUpdate({
    runUltrafix: body.runUltrafix as boolean | number | null | undefined,
    ultrafixGoal: body.ultrafixGoal as number | null | undefined,
    ultrafixMaxCycles: body.ultrafixMaxCycles as number | null | undefined,
    hasRunUltrafix,
    hasUltrafixGoal,
    hasUltrafixMaxCycles,
    promoteRunUltrafixOnOverrides: false
  });
  const runUltrafix = normalizedUltrafixUpdate.runUltrafix !== undefined
    ? normalizedUltrafixUpdate.runUltrafix ?? undefined
    : existingConfig.runUltrafix;
  const ultrafixGoal = clearAllUltrafixSettings
    ? null
    : normalizedUltrafixUpdate.ultrafixGoal !== undefined ? normalizedUltrafixUpdate.ultrafixGoal : existingConfig.ultrafixGoal;
  const ultrafixMaxCycles = clearAllUltrafixSettings || (clearUltrafixGoal && !hasUltrafixMaxCycles)
    ? null
    : normalizedUltrafixUpdate.ultrafixMaxCycles !== undefined ? normalizedUltrafixUpdate.ultrafixMaxCycles : existingConfig.ultrafixMaxCycles;
  return { runUltrafix, ultrafixGoal, ultrafixMaxCycles };
}

export function buildUpdatedExecutionConfig(
  existingConfig: DraftExecutionConfig,
  body: Record<string, unknown>,
): DraftExecutionConfig {
  const useEpic = parseOptionalBoolean(body.useEpic, 'useEpic');
  const autoMerge = parseOptionalBoolean(body.autoMerge, 'autoMerge');
  validateUltrafixSettings(body);

  const nextUltrafixConfig = resolveNextUltrafixConfig(existingConfig, body);
  const hasUltrafixOverrides = nextUltrafixConfig.ultrafixGoal !== null && nextUltrafixConfig.ultrafixGoal !== undefined
    || nextUltrafixConfig.ultrafixMaxCycles !== null && nextUltrafixConfig.ultrafixMaxCycles !== undefined;

  if (nextUltrafixConfig.runUltrafix !== true && hasUltrafixOverrides) {
    throw new ExecutionSettingsValidationError('runUltrafix must be true when ultrafixGoal or ultrafixMaxCycles is set');
  }

  return applyOptionalExecutionBooleans({
    ...existingConfig,
    ...nextUltrafixConfig
  }, existingConfig, useEpic, autoMerge);
}

export function mergeExecutionContextConfig(
  contextConfig: unknown,
  updatedConfig: DraftExecutionConfig
): DraftExecutionConfig {
  return {
    ...parseExecutionConfigRecord(contextConfig),
    ...updatedConfig,
  };
}

export function parseExistingExecutionConfig(contextConfig: unknown): DraftExecutionConfig {
  const parsedConfig = parseExistingContextConfig(contextConfig as TaskDraftConfig | string | null | undefined);
  if (parsedConfig) return parsedConfig as DraftExecutionConfig;
  return parseExecutionConfigRecord(contextConfig) as DraftExecutionConfig;
}
