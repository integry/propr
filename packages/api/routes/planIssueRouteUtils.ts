import { PlanIssueStatus, updatePlanIssue } from '@propr/core';

export interface ImplementationSettings {
  useEpic: boolean;
  autoMerge: boolean;
}

export interface ResolvedUltrafixSettings {
  runUltrafix: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
}

interface IssueUltrafixOverrides {
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

export function resolveIssueUltrafixSettings(
  planIssue: {
    run_ultrafix?: boolean | number | null;
    ultrafix_goal?: number | null;
    ultrafix_max_cycles?: number | null;
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
      ? (sanitizeUltrafixGoal(planIssue.ultrafix_goal) ?? sanitizeUltrafixGoal(contextConfig?.ultrafixGoal))
      : sanitizeUltrafixGoal(contextConfig?.ultrafixGoal)
    : null;
  const ultrafixMaxCycles = runUltrafix
    ? issueRunUltrafix === true
      ? (sanitizeUltrafixMaxCycles(planIssue.ultrafix_max_cycles) ?? sanitizeUltrafixMaxCycles(contextConfig?.ultrafixMaxCycles))
      : sanitizeUltrafixMaxCycles(contextConfig?.ultrafixMaxCycles)
    : null;

  return {
    runUltrafix,
    ultrafixGoal,
    ultrafixMaxCycles
  };
}

function getIssueUltrafixOverrides(planIssue: {
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}): IssueUltrafixOverrides {
  const runUltrafix = normalizeRunUltrafix(planIssue.run_ultrafix);
  const hasExplicitUltrafixOverride = runUltrafix === true;

  return {
    // `null` means "inherit planner defaults", so preserve it instead of
    // materializing the resolved planner value into the issue record.
    runUltrafix: runUltrafix ?? null,
    ultrafixGoal: hasExplicitUltrafixOverride ? sanitizeUltrafixGoal(planIssue.ultrafix_goal) : null,
    ultrafixMaxCycles: hasExplicitUltrafixOverride ? sanitizeUltrafixMaxCycles(planIssue.ultrafix_max_cycles) : null
  };
}

export function buildIssueForImplementation<T extends {
  issue_number: number;
  run_ultrafix?: boolean | number | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}>(planIssue: T, ultrafixSettings: ResolvedUltrafixSettings): T {
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
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}>(draftId: string, planIssue: T, contextConfig: Record<string, unknown> | null): Promise<T> {
  const ultrafixSettings = resolveIssueUltrafixSettings(planIssue, contextConfig);
  const issueForImplementation = buildIssueForImplementation(planIssue, ultrafixSettings);
  const issueOverrides = getIssueUltrafixOverrides(planIssue);
  const persistedIssue = await updatePlanIssue(draftId, planIssue.issue_number, {
    run_ultrafix: issueOverrides.runUltrafix,
    ultrafix_goal: issueOverrides.ultrafixGoal,
    ultrafix_max_cycles: issueOverrides.ultrafixMaxCycles
  });

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
  const runUltrafix = normalizeRunUltrafix(body.run_ultrafix);
  const shouldClearUltrafixOverrides = runUltrafix === false || runUltrafix === null;

  return {
    agent_alias: body.agent_alias !== undefined ? body.agent_alias : undefined,
    model_name: body.model_name !== undefined ? body.model_name : undefined,
    status: body.status !== undefined ? body.status : undefined,
    run_ultrafix: runUltrafix,
    ultrafix_goal: shouldClearUltrafixOverrides
      ? null
      : body.ultrafix_goal !== undefined
        ? sanitizeUltrafixGoal(body.ultrafix_goal)
        : undefined,
    ultrafix_max_cycles: shouldClearUltrafixOverrides
      ? null
      : body.ultrafix_max_cycles !== undefined
        ? sanitizeUltrafixMaxCycles(body.ultrafix_max_cycles)
        : undefined
  };
}
