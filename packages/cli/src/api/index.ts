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
  deletePlan,
  abortPlan,
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
  AbortPlanResponse,
} from "./plans.js";

// Implementation API
export {
  implementIssue,
  getTaskStatus,
  // Types
  AgentModelPair,
  ImplementIssueOptions,
  ImplementIssueResponse,
  TaskState,
  TokenUsage,
  TaskHistoryMetadata,
  TaskHistoryEntry,
  TaskInfo,
  TaskStatusResponse,
  TaskStatus,
} from "./implement.js";

// Tasks API
export {
  listTasks,
  stopTask,
  deleteTask,
  // Types
  TaskSummary,
  ListTasksResponse,
  ListTasksOptions,
  StopTaskResponse,
} from "./tasks.js";
