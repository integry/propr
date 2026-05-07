import { PlanIssueStatus, logger, updatePlanIssue, type UpdatePlanIssueInput } from '@propr/core';

export interface ImplementationSettings {
  useEpic: boolean;
  autoMerge: boolean;
}

export interface ResolvedUltrafixSettings {
  runUltrafix: boolean;
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

export function resolveImplementationSettings(
  reqBody: { useEpic?: boolean; autoMerge?: boolean },
  contextConfig: Record<string, unknown> | null
): ImplementationSettings {
  return {
    useEpic: reqBody.useEpic ?? (contextConfig?.useEpic === true),
    autoMerge: reqBody.autoMerge ?? (contextConfig?.autoMerge === true)
  };
}

function haveEquivalentUltrafixOverrides(
  planIssue: {
    run_ultrafix?: boolean | number | null;
    ultrafix_goal?: unknown;
    ultrafix_max_cycles?: unknown;
  },
  issueOverrides: UpdatePlanIssueInput
): boolean {
  return normalizeRunUltrafix(planIssue.run_ultrafix) === normalizeRunUltrafix(issueOverrides.run_ultrafix)
    && planIssue.ultrafix_goal === issueOverrides.ultrafix_goal
    && planIssue.ultrafix_max_cycles === issueOverrides.ultrafix_max_cycles;
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

function buildIssueUltrafixSnapshot(
  ultrafixSettings: ResolvedUltrafixSettings
): UpdatePlanIssueInput {
  return {
    run_ultrafix: ultrafixSettings.runUltrafix,
    ultrafix_goal: ultrafixSettings.runUltrafix ? ultrafixSettings.ultrafixGoal : null,
    ultrafix_max_cycles: ultrafixSettings.runUltrafix ? ultrafixSettings.ultrafixMaxCycles : null
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

export async function resolveAndPersistIssueUltrafixSettings<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: unknown;
  ultrafix_max_cycles?: unknown;
}>(draftId: string, planIssue: T, contextConfig: Record<string, unknown> | null): Promise<IssueWithNormalizedUltrafix<T>> {
  const ultrafixSettings = resolveIssueUltrafixSettings(planIssue, contextConfig);
  const issueOverrides = buildIssueUltrafixSnapshot(ultrafixSettings);

  if (haveEquivalentUltrafixOverrides(planIssue, issueOverrides)) {
    return buildIssueForImplementation(planIssue, ultrafixSettings);
  }

  const persistedIssue = await updatePlanIssue(draftId, planIssue.issue_number, issueOverrides);

  return buildIssueForImplementation((persistedIssue as T | null) ?? planIssue, ultrafixSettings);
}

export function normalizeRunUltrafix(value: boolean | number | null | undefined): boolean | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

export function validateRunUltrafixValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value === true || value === false || value === 1 || value === 0) return null;
  return 'run_ultrafix must be a boolean, 1, 0, or null (where null means inherit planner defaults)';
}

export function buildIssueUpdate(body: UpdateIssueRequestBody) {
  const hasUltrafixGoal = body.ultrafix_goal !== undefined;
  const hasUltrafixMaxCycles = body.ultrafix_max_cycles !== undefined;
  const requestedIssueOverrides = hasUltrafixGoal || hasUltrafixMaxCycles;
  const normalizedRunUltrafix = normalizeRunUltrafix(body.run_ultrafix);
  const runUltrafix = normalizedRunUltrafix === undefined && requestedIssueOverrides
    ? true
    : normalizedRunUltrafix;
  const shouldClearUltrafixOverrides = runUltrafix === false || runUltrafix === null;

  return {
    agent_alias: body.agent_alias !== undefined ? body.agent_alias : undefined,
    model_name: body.model_name !== undefined ? body.model_name : undefined,
    status: body.status !== undefined ? body.status : undefined,
    run_ultrafix: runUltrafix,
    ultrafix_goal: shouldClearUltrafixOverrides
      ? null
      : hasUltrafixGoal
        ? sanitizeUltrafixGoal(body.ultrafix_goal)
        : undefined,
    ultrafix_max_cycles: shouldClearUltrafixOverrides
      ? null
      : hasUltrafixMaxCycles
        ? sanitizeUltrafixMaxCycles(body.ultrafix_max_cycles)
        : undefined
  };
}
