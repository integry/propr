import type { GoalMergePolicy, CreateGoalParams } from '../api/goalsApi';
import { canonicalGoalText, GOAL_TEXT_MAX_CODE_POINTS } from '../utils/canonicalGoalText';

export const MAX_CONCURRENT_TASKS_MIN = 1;
export const MAX_CONCURRENT_TASKS_MAX = 20;
export const OBJECTIVE_MIN_LENGTH = 10;
export const OBJECTIVE_MAX_LENGTH = GOAL_TEXT_MAX_CODE_POINTS;
export const ULTRAFIX_GOAL_MIN = 1;
export const ULTRAFIX_GOAL_MAX = 10;
export const ULTRAFIX_CYCLES_MIN = 1;
export const ULTRAFIX_CYCLES_MAX = 20;

export const AUTO_MERGE_OPTIONS: Array<{
  value: GoalMergePolicy;
  label: string;
  description: string;
}> = [
  { value: 'manual', label: 'Manual', description: 'Require a human to merge pull requests.' },
  { value: 'auto', label: 'Automatic', description: 'Merge automatically after required checks and approval.' },
  { value: 'auto_squash', label: 'Automatic squash', description: 'Squash and merge automatically after required checks.' },
];

export interface GoalFormValues {
  objective: string;
  repository: string;
  agent: string;
  model: string;
  maxActiveTasks: number;
  mergePolicy: GoalMergePolicy;
  ultrafixEnabled: boolean;
  ultrafixGoal: string;
  ultrafixMaxCycles: string;
}

export interface GoalFormErrors {
  objective?: string;
  repository?: string;
  agent?: string;
  model?: string;
  maxActiveTasks?: string;
  ultrafixGoal?: string;
  ultrafixMaxCycles?: string;
  submit?: string;
}

const optionalInteger = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value);

export function validateGoalForm(values: GoalFormValues): GoalFormErrors {
  const errors: GoalFormErrors = {};
  const { codePointLength: objectiveLength } = canonicalGoalText(values.objective);
  if (objectiveLength === 0) errors.objective = 'Objective is required.';
  else if (objectiveLength < OBJECTIVE_MIN_LENGTH) errors.objective = `Objective must be at least ${OBJECTIVE_MIN_LENGTH} characters after trimming.`;
  else if (objectiveLength > OBJECTIVE_MAX_LENGTH) {
    const excess = objectiveLength - OBJECTIVE_MAX_LENGTH;
    errors.objective = `Objective must be at most ${OBJECTIVE_MAX_LENGTH} characters after trimming. Remove at least ${excess} ${excess === 1 ? 'character' : 'characters'}.`;
  }
  if (!values.repository) errors.repository = 'Repository is required.';
  if (!values.agent) errors.agent = 'Agent is required.';
  if (!values.model) errors.model = 'Model is required.';
  if (!Number.isInteger(values.maxActiveTasks) || values.maxActiveTasks < MAX_CONCURRENT_TASKS_MIN || values.maxActiveTasks > MAX_CONCURRENT_TASKS_MAX) {
    errors.maxActiveTasks = `Must be between ${MAX_CONCURRENT_TASKS_MIN} and ${MAX_CONCURRENT_TASKS_MAX}.`;
  }
  if (!values.ultrafixEnabled) return errors;

  const goal = optionalInteger(values.ultrafixGoal);
  if (goal === undefined) errors.ultrafixGoal = 'Review goal is required when Ultrafix is enabled.';
  else if (!Number.isInteger(goal) || goal < ULTRAFIX_GOAL_MIN || goal > ULTRAFIX_GOAL_MAX) {
    errors.ultrafixGoal = `Review goal must be between ${ULTRAFIX_GOAL_MIN} and ${ULTRAFIX_GOAL_MAX}.`;
  }
  const maxCycles = optionalInteger(values.ultrafixMaxCycles);
  if (maxCycles === undefined) errors.ultrafixMaxCycles = 'Max cycles is required when Ultrafix is enabled.';
  else if (!Number.isInteger(maxCycles) || maxCycles < ULTRAFIX_CYCLES_MIN || maxCycles > ULTRAFIX_CYCLES_MAX) {
    errors.ultrafixMaxCycles = `Max cycles must be between ${ULTRAFIX_CYCLES_MIN} and ${ULTRAFIX_CYCLES_MAX}.`;
  }
  return errors;
}

export function buildCreateGoalParams(values: GoalFormValues): CreateGoalParams {
  return {
    objective: canonicalGoalText(values.objective).value,
    repository: values.repository,
    agent: values.agent,
    model: values.model,
    maxActiveTasks: values.maxActiveTasks,
    mergePolicy: values.mergePolicy,
    ultrafixEnabled: values.ultrafixEnabled,
    ultrafixGoal: values.ultrafixEnabled ? Number(values.ultrafixGoal) : null,
    ultrafixMaxCycles: values.ultrafixEnabled ? Number(values.ultrafixMaxCycles) : null,
  };
}
