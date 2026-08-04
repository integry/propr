/**
 * Planner helpers module.
 * Re-exports all planner-related utilities and handlers.
 */

// Types
export * from './types.js';

// Auth utilities
export { checkDbAndAuth, withAuthCheck, checkAuth, sendCheckError, verifyDraftOwnership, getRepoAuthToken } from './auth.js';

// Validation utilities
export { VALID_GRANULARITIES, validateContextRepositories, validatePreviewInput, validateRefineInput } from './validation.js';

// Repository setup utilities
export { setupRepoContext, getRefineRepoContext } from './repoSetup.js';

// Background refinement
export { runBackgroundRefinement } from './refineBackground.js';

// Long-running operation guards
export {
  ACTIVE_DRAFT_OPERATION_STATUSES,
  claimDraftPreparation,
  claimDraftOperation,
  hasRunningPlannerContainer,
  isDraftOperationActive,
  releaseDraftPreparation,
  recoverStaleRefinement,
  REFINEMENT_STALE_AFTER_MS
} from './operationGuard.js';

// Utility functions
export { updateDraftContextConfig, runBackgroundGeneration, selectRefinementModel, scoreDraftsBySearch, buildIssueSummaries, parseDraftJsonFields } from './utils.js';

// Handlers
export * from './handlers/index.js';

// Re-export plan issue handlers from separate module
export {
  createGetIssuesHandler,
  createImplementIssueHandler,
  createUpdateIssueHandler
} from '../planIssueHandlers.js';
