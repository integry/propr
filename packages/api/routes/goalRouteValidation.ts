import type { AgentConfig, CreateGoalInput, RepoToMonitor } from '@propr/core';
import {
  GOAL_DEFAULT_MAX_ACTIVE_TASKS,
  GOAL_ERROR_CODES,
  GOAL_MAX_MAX_ACTIVE_TASKS,
  GOAL_MERGE_POLICIES,
  GOAL_MIN_MAX_ACTIVE_TASKS,
  GOAL_IDENTIFIER_MAX_LENGTH,
  GOAL_OBJECTIVE_MAX_LENGTH,
  GOAL_ULTRAFIX_GOAL_MAX,
  GOAL_ULTRAFIX_GOAL_MIN,
  GOAL_ULTRAFIX_MAX_CYCLES_MAX,
  GOAL_ULTRAFIX_MAX_CYCLES_MIN,
  MODEL_INFO_MAP,
  isGoalCapableEntry,
  type GoalMergePolicy,
} from '@propr/shared';

export interface GoalRouteRejection {
  ok: false;
  status: number;
  code: string;
  error: string;
}

interface ValidatedSelection {
  objective: string;
  repository: string;
  agent: string;
  requestedModel: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
}

function reject(status: number, code: string, error: string): GoalRouteRejection {
  return { ok: false, status, code, error };
}

function validateSelection(body: Record<string, unknown>): ValidatedSelection | GoalRouteRejection {
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  const repository = typeof body.repository === 'string' ? body.repository.trim() : '';
  const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  if (!objective || !repository || !agent || !requestedModel) {
    return reject(400, GOAL_ERROR_CODES.validation, 'objective, repository, agent, and model are required');
  }
  if (Array.from(objective).length > GOAL_OBJECTIVE_MAX_LENGTH) {
    return reject(400, GOAL_ERROR_CODES.validation, `objective must not exceed ${GOAL_OBJECTIVE_MAX_LENGTH} characters`);
  }
  if ([repository, agent, requestedModel].some(value => Array.from(value).length > GOAL_IDENTIFIER_MAX_LENGTH)) {
    return reject(400, GOAL_ERROR_CODES.validation, `repository, agent, and model must not exceed ${GOAL_IDENTIFIER_MAX_LENGTH} characters`);
  }
  const maxActiveTasks = body.maxActiveTasks ?? GOAL_DEFAULT_MAX_ACTIVE_TASKS;
  if (typeof maxActiveTasks !== 'number' || !Number.isInteger(maxActiveTasks)
    || maxActiveTasks < GOAL_MIN_MAX_ACTIVE_TASKS || maxActiveTasks > GOAL_MAX_MAX_ACTIVE_TASKS) {
    return reject(400, GOAL_ERROR_CODES.concurrencyBound, `maxActiveTasks must be between ${GOAL_MIN_MAX_ACTIVE_TASKS} and ${GOAL_MAX_MAX_ACTIVE_TASKS}`);
  }
  const mergePolicy = (body.mergePolicy ?? 'manual') as GoalMergePolicy;
  if (!GOAL_MERGE_POLICIES.includes(mergePolicy)) {
    return reject(400, GOAL_ERROR_CODES.validation, `mergePolicy must be one of: ${GOAL_MERGE_POLICIES.join(', ')}`);
  }
  return { objective, repository, agent, requestedModel, maxActiveTasks, mergePolicy };
}

function validateUltrafix(body: Record<string, unknown>): Pick<CreateGoalInput, 'ultrafixEnabled' | 'ultrafixGoal' | 'ultrafixMaxCycles'> | GoalRouteRejection {
  if (body.ultrafixEnabled !== undefined && typeof body.ultrafixEnabled !== 'boolean') {
    return reject(400, GOAL_ERROR_CODES.validation, 'ultrafixEnabled must be a boolean');
  }
  const ultrafixEnabled = body.ultrafixEnabled === true;
  const ultrafixGoal = body.ultrafixGoal ?? null;
  const ultrafixMaxCycles = body.ultrafixMaxCycles ?? null;
  if (!ultrafixEnabled && (ultrafixGoal !== null || ultrafixMaxCycles !== null)) {
    return reject(400, GOAL_ERROR_CODES.validation, 'Ultrafix goal and cycles require ultrafixEnabled');
  }
  if (ultrafixEnabled && (!Number.isInteger(ultrafixGoal)
    || (ultrafixGoal as number) < GOAL_ULTRAFIX_GOAL_MIN || (ultrafixGoal as number) > GOAL_ULTRAFIX_GOAL_MAX)) {
    return reject(400, GOAL_ERROR_CODES.validation, `ultrafixGoal must be an integer from ${GOAL_ULTRAFIX_GOAL_MIN} to ${GOAL_ULTRAFIX_GOAL_MAX}`);
  }
  if (ultrafixEnabled && (!Number.isInteger(ultrafixMaxCycles)
    || (ultrafixMaxCycles as number) < GOAL_ULTRAFIX_MAX_CYCLES_MIN || (ultrafixMaxCycles as number) > GOAL_ULTRAFIX_MAX_CYCLES_MAX)) {
    return reject(400, GOAL_ERROR_CODES.validation, `ultrafixMaxCycles must be an integer from ${GOAL_ULTRAFIX_MAX_CYCLES_MIN} to ${GOAL_ULTRAFIX_MAX_CYCLES_MAX}`);
  }
  return {
    ultrafixEnabled,
    ultrafixGoal: ultrafixGoal as number | null,
    ultrafixMaxCycles: ultrafixMaxCycles as number | null,
  };
}

export async function validateGoalAgentModel(
  agent: string,
  model: string,
  loadAgents: () => Promise<AgentConfig[]>
): Promise<GoalRouteRejection | null> {
  const agents = await loadAgents();
  const entry = agents.find(candidate => candidate.alias === agent && candidate.enabled);
  if (!entry || !isGoalCapableEntry(entry)) {
    return reject(400, GOAL_ERROR_CODES.invalidCatalogSelection, 'Agent is not a goal-capable catalog entry');
  }
  if (!entry.supportedModels.includes(model)) {
    return reject(400, GOAL_ERROR_CODES.invalidCatalogSelection, 'Model is not supported by the selected agent');
  }
  if (!isGoalCapableEntry(MODEL_INFO_MAP[model])) {
    return reject(400, GOAL_ERROR_CODES.invalidCatalogSelection, 'Model is not a goal-capable catalog entry');
  }
  return null;
}

export async function validateCreateGoalInput(
  body: Record<string, unknown>,
  ownerUserId: string,
  services: {
    loadAgents: () => Promise<AgentConfig[]>;
    loadRepositories: () => Promise<RepoToMonitor[]>;
  }
): Promise<{ ok: true; input: CreateGoalInput } | GoalRouteRejection> {
  const selection = validateSelection(body);
  if ('ok' in selection) return selection;
  const ultrafix = validateUltrafix(body);
  if ('ok' in ultrafix) return ultrafix;
  const repositories = await services.loadRepositories();
  if (!repositories.some(entry => entry.name === selection.repository && entry.enabled)) {
    return reject(403, GOAL_ERROR_CODES.repositoryForbidden, 'Repository is not accessible');
  }
  const catalogError = await validateGoalAgentModel(selection.agent, selection.requestedModel, services.loadAgents);
  if (catalogError) return catalogError;
  return {
    ok: true,
    input: { ownerUserId, ...selection, repository: selection.repository, ...ultrafix },
  };
}
