export { GoalRepository, GoalError } from './goalRepository.js';
export {
  GoalLifecycleService,
  buildSummary as buildGoalSummary,
  isGoalTerminal,
  type GoalDetail,
  type GoalMutationOptions,
  type ControllerGoalMutationOptions,
} from './goalLifecycleService.js';
export * from './goalTypes.js';
export {
  CANONICAL_JSON_MAX_BYTES,
  CANONICAL_JSON_MAX_DEPTH,
  CANONICAL_JSON_MAX_NODES,
} from './strictCanonicalJson.js';
