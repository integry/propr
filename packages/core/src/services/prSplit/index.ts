export { parseSplitCommand, normalizeSplitInstruction } from './command.js';
export type { ParsedSplitCommand } from './command.js';

export {
  SPLIT_AUTHORIZED_PERMISSIONS,
  isSplitPermissionAuthorized,
  authorizeSplitRequester,
} from './authorization.js';
export type {
  SplitAuthorizedPermission,
  SplitAuthorizationRequest,
  SplitAuthorizationResult,
} from './authorization.js';

export {
  ACTIVE_SPLIT_OPERATION_STATUSES,
  TERMINAL_SPLIT_OPERATION_STATUSES,
  SPLIT_OPERATION_STATUSES,
  buildSplitOperationDedupeKey,
  isActiveSplitOperationStatus,
  isTerminalSplitOperationStatus,
  createOrGetPrSplitOperation,
  getActivePrSplitOperation,
  getPrSplitOperation,
  updatePrSplitOperationStatus,
} from './operationStore.js';
export type {
  SplitOperationStatus,
  PrSplitOperation,
  CreatePrSplitOperationInput,
  CreatePrSplitOperationResult,
  SplitDedupeKeyInput,
  UpdatePrSplitOperationStatusOptions,
} from './operationStore.js';

export { handlePrSplitComment } from './intake.js';
export type {
  PrSplitIntakeDependencies,
  PrSplitIntakeResult,
} from './intake.js';
