import { PlanIssueStatus, logger } from '@propr/core';

export interface ImplementationSettings {
  useEpic: boolean;
  autoMerge: boolean;
}

export interface ImplementationSettingsOverrides {
  useEpic?: boolean;
  autoMerge?: boolean;
}

export interface ResolvedUltrafixSettings {
  runUltrafix: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

export interface PersistedIssueUltrafixSettings {
  runUltrafix: boolean | null;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

export interface UpdateIssueRequestBody {
  agent_alias?: string;
  model_name?: string | null;
  status?: PlanIssueStatus;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}

export const ULTRAFIX_GOAL_MIN = 1;
export const ULTRAFIX_GOAL_MAX = 10;
export const ULTRAFIX_MAX_CYCLES_MIN = 1;

export class ContextConfigParseError extends Error {}

export function parseContextConfig(contextConfig: unknown): Record<string, unknown> | null {
  if (!contextConfig) return null;
  if (typeof contextConfig !== 'string') {
    return contextConfig as Record<string, unknown>;
  }
  try {
    return JSON.parse(contextConfig) as Record<string, unknown>;
  } catch (error) {
    throw new ContextConfigParseError(`Failed to parse draft context_config: ${(error as Error).message}`);
  }
}

export function sanitizeUltrafixGoal(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= ULTRAFIX_GOAL_MIN && (value as number) <= ULTRAFIX_GOAL_MAX
    ? value as number
    : null;
}

export function sanitizeUltrafixMaxCycles(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= ULTRAFIX_MAX_CYCLES_MIN
    ? value as number
    : null;
}

type UltrafixFieldNames = {
  run: string;
  goal: string;
  maxCycles: string;
};

type NormalizedUltrafixUpdate = {
  runUltrafix: boolean | null | undefined;
  ultrafixGoal: number | null | undefined;
  ultrafixMaxCycles: number | null | undefined;
};

function logInvalidPersistedUltrafixValue(params: {
  source: 'plan_issue' | 'planner_context';
  issueNumber?: number;
  fieldName: 'ultrafix_goal' | 'ultrafix_max_cycles';
  value: unknown;
}): void {
  logger.warn(params, 'Invalid persisted ultrafix value found; normalizing to null');
}

function sanitizePersistedUltrafixGoal(
  value: unknown,
  params: { source: 'plan_issue' | 'planner_context'; issueNumber?: number }
): number | null {
  const sanitized = sanitizeUltrafixGoal(value);
  if (value !== null && value !== undefined && sanitized === null) {
    logInvalidPersistedUltrafixValue({ ...params, fieldName: 'ultrafix_goal', value });
  }
  return sanitized;
}

function sanitizePersistedUltrafixMaxCycles(
  value: unknown,
  params: { source: 'plan_issue' | 'planner_context'; issueNumber?: number }
): number | null {
  const sanitized = sanitizeUltrafixMaxCycles(value);
  if (value !== null && value !== undefined && sanitized === null) {
    logInvalidPersistedUltrafixValue({ ...params, fieldName: 'ultrafix_max_cycles', value });
  }
  return sanitized;
}

export function validateUltrafixValue(
  value: unknown,
  fieldName: string,
  options: { minimum: number; maximum?: number }
): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) return `${fieldName} must be an integer`;
  if ((value as number) < options.minimum) return `${fieldName} must be at least ${options.minimum}`;
  if (options.maximum !== undefined && (value as number) > options.maximum) {
    return `${fieldName} must be at most ${options.maximum}`;
  }
  return null;
}

function validateOptionalBoolean(value: unknown, fieldName: string): string | null {
  if (value === undefined) return null;
  return typeof value === 'boolean' ? null : `${fieldName} must be a boolean`;
}

export function parseImplementationSettingsOverrides(
  reqBody: { useEpic?: unknown; autoMerge?: unknown }
): { settings: ImplementationSettingsOverrides; error: string | null } {
  const useEpicError = validateOptionalBoolean(reqBody.useEpic, 'useEpic');
  if (useEpicError) {
    return { settings: {}, error: useEpicError };
  }

  const autoMergeError = validateOptionalBoolean(reqBody.autoMerge, 'autoMerge');
  if (autoMergeError) {
    return { settings: {}, error: autoMergeError };
  }

  return {
    settings: {
      ...(reqBody.useEpic !== undefined ? { useEpic: reqBody.useEpic as boolean } : {}),
      ...(reqBody.autoMerge !== undefined ? { autoMerge: reqBody.autoMerge as boolean } : {})
    },
    error: null
  };
}

export function resolveImplementationSettings(
  reqBody: ImplementationSettingsOverrides,
  contextConfig: Record<string, unknown> | null
): ImplementationSettings {
  return {
    useEpic: reqBody.useEpic ?? (contextConfig?.useEpic === true),
    autoMerge: reqBody.autoMerge ?? (contextConfig?.autoMerge === true)
  };
}

export function resolveIssueUltrafixSettings(
  planIssue: {
    issue_number?: number;
    run_ultrafix?: boolean | number | null;
    ultrafix_goal?: unknown;
    ultrafix_max_cycles?: unknown;
  },
  contextConfig: Record<string, unknown> | null
): ResolvedUltrafixSettings {
  const issueRunUltrafix = planIssue.run_ultrafix === true || planIssue.run_ultrafix === 1
    ? true
    : planIssue.run_ultrafix === false || planIssue.run_ultrafix === 0
      ? false
      : null;
  const plannerRunUltrafix = contextConfig?.runUltrafix === true;
  const runUltrafix = issueRunUltrafix ?? plannerRunUltrafix;
  const ultrafixGoal = runUltrafix
    ? issueRunUltrafix === true
      ? (
        sanitizePersistedUltrafixGoal(planIssue.ultrafix_goal, { source: 'plan_issue', issueNumber: planIssue.issue_number })
        ?? sanitizePersistedUltrafixGoal(contextConfig?.ultrafixGoal, { source: 'planner_context', issueNumber: planIssue.issue_number })
      )
      : sanitizePersistedUltrafixGoal(contextConfig?.ultrafixGoal, { source: 'planner_context', issueNumber: planIssue.issue_number })
    : null;
  const ultrafixMaxCycles = runUltrafix
    ? issueRunUltrafix === true
      ? (
        sanitizePersistedUltrafixMaxCycles(planIssue.ultrafix_max_cycles, { source: 'plan_issue', issueNumber: planIssue.issue_number })
        ?? sanitizePersistedUltrafixMaxCycles(contextConfig?.ultrafixMaxCycles, { source: 'planner_context', issueNumber: planIssue.issue_number })
      )
      : sanitizePersistedUltrafixMaxCycles(contextConfig?.ultrafixMaxCycles, { source: 'planner_context', issueNumber: planIssue.issue_number })
    : null;

  return {
    runUltrafix,
    ultrafixGoal,
    ultrafixMaxCycles
  };
}

export function resolvePersistedIssueUltrafixSettings(
  planIssue: {
    issue_number?: number;
    run_ultrafix?: boolean | number | null;
    ultrafix_goal?: unknown;
    ultrafix_max_cycles?: unknown;
  }
): PersistedIssueUltrafixSettings {
  const runUltrafix = planIssue.run_ultrafix === true || planIssue.run_ultrafix === 1
    ? true
    : planIssue.run_ultrafix === false || planIssue.run_ultrafix === 0
      ? false
      : null;

  return {
    runUltrafix,
    ultrafixGoal: sanitizePersistedUltrafixGoal(planIssue.ultrafix_goal, {
      source: 'plan_issue',
      issueNumber: planIssue.issue_number
    }),
    ultrafixMaxCycles: sanitizePersistedUltrafixMaxCycles(planIssue.ultrafix_max_cycles, {
      source: 'plan_issue',
      issueNumber: planIssue.issue_number
    })
  };
}

type IssueWithNormalizedUltrafix<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}> = Omit<T, 'run_ultrafix' | 'ultrafix_goal' | 'ultrafix_max_cycles'> & {
  run_ultrafix: boolean;
  ultrafix_goal: number | null;
  ultrafix_max_cycles: number | null;
};

type IssueWithPersistedUltrafix<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}> = Omit<T, 'run_ultrafix' | 'ultrafix_goal' | 'ultrafix_max_cycles'> & {
  run_ultrafix: boolean | null;
  ultrafix_goal: number | null;
  ultrafix_max_cycles: number | null;
};

export function buildIssueForImplementation<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(planIssue: T, ultrafixSettings: ResolvedUltrafixSettings): IssueWithNormalizedUltrafix<T> {
  return {
    ...planIssue,
    run_ultrafix: ultrafixSettings.runUltrafix,
    ultrafix_goal: ultrafixSettings.ultrafixGoal,
    ultrafix_max_cycles: ultrafixSettings.ultrafixMaxCycles
  };
}

export function buildIssueForResponse<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(planIssue: T, ultrafixSettings: PersistedIssueUltrafixSettings): IssueWithPersistedUltrafix<T> {
  return {
    ...planIssue,
    run_ultrafix: ultrafixSettings.runUltrafix,
    ultrafix_goal: ultrafixSettings.ultrafixGoal,
    ultrafix_max_cycles: ultrafixSettings.ultrafixMaxCycles
  };
}

export function resolveIssueForImplementation<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(planIssue: T, contextConfig: Record<string, unknown> | null): IssueWithNormalizedUltrafix<T> {
  const ultrafixSettings = resolveIssueUltrafixSettings(planIssue, contextConfig);
  return buildIssueForImplementation(planIssue, ultrafixSettings);
}

export function resolveIssueForResponse<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(planIssue: T): IssueWithPersistedUltrafix<T> {
  const ultrafixSettings = resolvePersistedIssueUltrafixSettings(planIssue);
  return buildIssueForResponse(planIssue, ultrafixSettings);
}

export function buildEffectiveIssueUltrafixUpdate<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(
  planIssue: T,
  contextConfig: Record<string, unknown> | null
): { run_ultrafix: boolean; ultrafix_goal: number | null; ultrafix_max_cycles: number | null } | null {
  const resolvedIssue = resolveIssueForImplementation(planIssue, contextConfig);
  const persistedSettings = resolvePersistedIssueUltrafixSettings(planIssue);

  if (
    persistedSettings.runUltrafix === resolvedIssue.run_ultrafix
    && persistedSettings.ultrafixGoal === resolvedIssue.ultrafix_goal
    && persistedSettings.ultrafixMaxCycles === resolvedIssue.ultrafix_max_cycles
  ) {
    return null;
  }

  return {
    run_ultrafix: resolvedIssue.run_ultrafix,
    ultrafix_goal: resolvedIssue.ultrafix_goal,
    ultrafix_max_cycles: resolvedIssue.ultrafix_max_cycles
  };
}

export function normalizeRunUltrafix(value: boolean | number | null | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

export function validateRunUltrafixValue(
  value: unknown,
  fieldName = 'run_ultrafix',
  options: { allowNull?: boolean } = {}
): string | null {
  const allowNull = options.allowNull ?? true;
  if (value === undefined) return null;
  if (value === null) {
    return allowNull ? null : `${fieldName} must be a boolean, 1, or 0`;
  }
  if (value === true || value === false || value === 1 || value === 0) return null;
  return allowNull
    ? `${fieldName} must be a boolean, 1, 0, or null`
    : `${fieldName} must be a boolean, 1, or 0`;
}

export function validateUltrafixPayload(params: {
  runUltrafix: boolean | number | null | undefined;
  ultrafixGoal: number | null | undefined;
  ultrafixMaxCycles: number | null | undefined;
  fieldNames?: UltrafixFieldNames;
  allowInheritedRun?: boolean;
}): string | null {
  const fieldNames = params.fieldNames ?? {
    run: 'run_ultrafix',
    goal: 'ultrafix_goal',
    maxCycles: 'ultrafix_max_cycles'
  };
  const runUltrafixError = validateRunUltrafixValue(params.runUltrafix, fieldNames.run);
  if (runUltrafixError) {
    return params.allowInheritedRun
      ? `${runUltrafixError} (where null means inherit planner defaults)`
      : runUltrafixError;
  }

  const normalizedRunUltrafix = normalizeRunUltrafix(params.runUltrafix);
  const hasExplicitOverrides = params.ultrafixGoal !== undefined && params.ultrafixGoal !== null
    || params.ultrafixMaxCycles !== undefined && params.ultrafixMaxCycles !== null;

  if (normalizedRunUltrafix === false && hasExplicitOverrides) {
    return `${fieldNames.run} cannot be false when ${fieldNames.goal} or ${fieldNames.maxCycles} is set`;
  }

  if (params.allowInheritedRun && normalizedRunUltrafix === null && hasExplicitOverrides) {
    return `${fieldNames.run} cannot inherit planner defaults when ${fieldNames.goal} or ${fieldNames.maxCycles} is set`;
  }

  return null;
}

export function validateIssueUltrafixPayload(body: UpdateIssueRequestBody): string | null {
  return validateUltrafixPayload({
    runUltrafix: body.run_ultrafix,
    ultrafixGoal: body.ultrafix_goal,
    ultrafixMaxCycles: body.ultrafix_max_cycles,
    allowInheritedRun: true
  });
}

export function buildNormalizedUltrafixUpdate(params: {
  runUltrafix: boolean | number | null | undefined;
  ultrafixGoal: number | null | undefined;
  ultrafixMaxCycles: number | null | undefined;
  hasRunUltrafix: boolean;
  hasUltrafixGoal: boolean;
  hasUltrafixMaxCycles: boolean;
  promoteRunUltrafixOnOverrides?: boolean;
}): NormalizedUltrafixUpdate {
  const hasAnyUltrafixUpdate = params.hasRunUltrafix || params.hasUltrafixGoal || params.hasUltrafixMaxCycles;
  if (!hasAnyUltrafixUpdate) {
    return {
      runUltrafix: undefined,
      ultrafixGoal: undefined,
      ultrafixMaxCycles: undefined
    };
  }

  const promoteRunUltrafixOnOverrides = params.promoteRunUltrafixOnOverrides ?? true;
  const requestedIssueOverrides = (params.hasUltrafixGoal && params.ultrafixGoal !== null)
    || (params.hasUltrafixMaxCycles && params.ultrafixMaxCycles !== null);
  const normalizedRunUltrafix = normalizeRunUltrafix(params.runUltrafix);
  const runUltrafix = normalizedRunUltrafix === undefined
    ? (requestedIssueOverrides && promoteRunUltrafixOnOverrides ? true : undefined)
    : normalizedRunUltrafix;
  const shouldClearUltrafixOverrides = runUltrafix === false || runUltrafix === null;

  return {
    runUltrafix,
    ultrafixGoal: shouldClearUltrafixOverrides
      ? null
      : params.hasUltrafixGoal
        ? sanitizeUltrafixGoal(params.ultrafixGoal)
        : undefined,
    ultrafixMaxCycles: shouldClearUltrafixOverrides
      ? null
      : params.hasUltrafixMaxCycles
        ? sanitizeUltrafixMaxCycles(params.ultrafixMaxCycles)
        : undefined
  };
}

export function buildIssueUpdate(
  body: UpdateIssueRequestBody
) {
  const hasRunUltrafix = body.run_ultrafix !== undefined;
  const hasUltrafixGoal = body.ultrafix_goal !== undefined;
  const hasUltrafixMaxCycles = body.ultrafix_max_cycles !== undefined;
  const normalizedUltrafixUpdate = buildNormalizedUltrafixUpdate({
    runUltrafix: body.run_ultrafix,
    ultrafixGoal: body.ultrafix_goal,
    ultrafixMaxCycles: body.ultrafix_max_cycles,
    hasRunUltrafix,
    hasUltrafixGoal,
    hasUltrafixMaxCycles
  });

  return {
    agent_alias: body.agent_alias !== undefined ? body.agent_alias : undefined,
    model_name: body.model_name !== undefined ? body.model_name : undefined,
    status: body.status !== undefined ? body.status : undefined,
    run_ultrafix: normalizedUltrafixUpdate.runUltrafix,
    ultrafix_goal: normalizedUltrafixUpdate.ultrafixGoal,
    ultrafix_max_cycles: normalizedUltrafixUpdate.ultrafixMaxCycles
  };
}
