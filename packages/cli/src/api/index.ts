/**
 * CLI API Module
 *
 * Exports the API client and related types for communicating
 * with the ProPR backend REST API.
 */

export {
  ApiClient,
  createApiClient,
  createApiClientWithConfig,
} from "./client.js";

export {
  ApiError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  InternalServerError,
  NetworkError,
  TimeoutError,
  createApiError,
} from "./errors.js";

export {
  HttpMethod,
  RequestOptions,
  ApiClientOptions,
  ApiErrorCode,
  ApiErrorResponse,
  ApiResponse,
} from "./types.js";

// Plan Management API
export {
  listPlans,
  createPlan,
  getPlan,
  // Types
  PlanStatus,
  PlanIssueSummary,
  PlanSummary,
  PlanContextConfig,
  PlanAttachment,
  PlanChatMessage,
  Plan,
  ListPlansResponse,
  ListPlansOptions,
  CreatePlanOptions,
} from "./plans.js";
