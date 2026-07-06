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

export type {
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
  listPlanIssues,
  generatePlan,
  finalizePlan,
} from "./plans.js";

export type {
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
  PlanIssue,
  GeneratePlanOptions,
  FinalizePlanResponse,
} from "./plans.js";

// Implementation API
export {
  implementIssue,
  getTaskStatus,
} from "./implement.js";

export type {
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
  followupTask,
  importTasks,
  getRevertPreview,
  revertTask,
} from "./tasks.js";

export type {
  TaskSummary,
  ListTasksResponse,
  ListTasksOptions,
  StopTaskResponse,
  FollowupTaskResponse,
  ImportTasksResponse,
  RevertPreviewCommit,
  RevertPreviewResponse,
  RevertTaskResponse,
} from "./tasks.js";

// Repository Configuration API
export {
  getRepos,
  addRepo,
  updateRepo,
  removeRepo,
  triggerIndexing,
  getIndexingStatus,
  reposApi,
} from "./repos.js";

export type {
  MonitoredRepo,
  GetReposResponse,
  AddRepoOptions,
  UpdateRepoOptions,
  RepoConfigResponse,
  RepositoryIndexingProgress,
  RepositoryIndexingStatus,
  TriggerIndexingResponse,
  GetIndexingStatusResponse,
} from "./repos.js";

// Agents Configuration API
export {
  listAgents,
  addAgent,
  deleteAgent,
} from "./agents.js";

export type {
  AgentType,
  AgentConfig,
  GetAgentsResponse,
  AddAgentOptions,
  SaveAgentsResponse,
} from "./agents.js";

// System Settings API
export {
  getSettings,
  updateSettings,
  updateSetting,
  getConfigValue,
  updateConfigValue,
  triggerSummarizationReindexAll,
  isValidSettingKey,
  parseSettingValue,
  settingsApi,
  VALID_SETTING_KEYS,
  NAMED_CONFIG_ENDPOINTS,
} from "./settings.js";

export type {
  SystemSettings,
  GetSettingsResponse,
  UpdateSettingsOptions,
  UpdateSettingsResponse,
  NamedConfigEndpoint,
  NamedConfigValueByEndpoint,
  ReindexAllResponse,
  SettingKey,
} from "./settings.js";

// LLM Logs API
export {
  listLlmLogs,
} from "./logs.js";

export type {
  LlmLogEntry,
  LlmLogsPagination,
  ListLlmLogsResponse,
  ListLlmLogsOptions,
} from "./logs.js";

// Repository To-Dos API
export {
  listTodos,
  getTodo,
  createTodo,
  updateTodo,
  deleteTodo,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderTodos,
  reorderCategories,
} from "./todos.js";

export type {
  RepoTodo,
  RepoTodoCategory,
  ListTodosResponse,
  ListCategoriesResponse,
  BatchReorderItem,
} from "./todos.js";

// System Status API
export {
  getSystemStatus,
  getQueueStats,
} from "./system.js";

export type {
  SystemStatus,
  RoutingState,
  QueueStats,
} from "./system.js";
