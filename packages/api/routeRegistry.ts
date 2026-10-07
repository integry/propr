import type { Express, RequestHandler } from 'express';
import type {
  createAdminRoutes,
  createAdminMcpRoutes,
  createAgentLoginRoutes,
  createAgentRuntimeRoutes,
  createAgentVersionRoutes,
  createConfigRoutes,
  createInstanceCatalogRoutes,
  createVisualPreviewAuthRoutes,
  createActiveWorkRoutes,
  createDashboardRoutes,
  createDockerRoutes,
  createExecutionRoutes,
  createFileChangesRoutes,
  createGitHubRoutes,
  createGoalRoutes,
  createLLMMetricsRoutes,
  createLiveDetailsRoutes,
  createLlmLogsRoutes,
  createNotificationRoutes,
  createPlannerRoutes,
  createQueueRoutes,
  createRelevanceRoutes,
  createRepoChatRoutes,
  createRepoImprovementsRoutes,
  createRepoTodoRoutes,
  createReviewScoreRoutes,
  createStatsRoutes,
  createStatusRoutes,
  createSummaryBrowserRoutes,
  createTaskHistoryRoutes,
  createTaskRoutes,
  createUserRepoPreferencesRoutes,
  createVoiceRoutes,
} from './routes/index.js';
import type { createPreviewMediaRoutes } from './routes/previewMediaRoutes.js';
import type { createRepositoryMediaRoutes } from './routes/repositoryMediaRoutes.js';
import type { createTaskSubmissionRoutes } from './routes/taskSubmissionRoutes.js';
import type { createUsageTipsRoutes } from './routes/usageTipsRoutes.js';
import { SUMMARY_PATH_ROUTE_PATH, SUMMARY_TREE_ROUTE_PATH } from './routes/summaryPathUtils.js';
import { createTaskDeleteRouteEntries } from './taskDeleteRouteRegistry.js';
import {
  requireAgentTankUsageAccess,
  requireManageAgents,
  requireManageMembers,
  requireManageRuntime,
  requireManageSettings,
} from './permissionGuards.js';
import { timeApiRouteHandler } from './apiPerformanceTiming.js';

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
// A route matrix contains handlers with different inferred parameter shapes.
// `never` erases those shapes while retaining their request/response contract.
export type RouteEntry = [RouteMethod, string, ...RequestHandler<never>[]];

interface ManagementRouteDeps {
  adminRoutes: ReturnType<typeof createAdminRoutes>;
  adminMcpRoutes: ReturnType<typeof createAdminMcpRoutes>;
  agentLoginRoutes: ReturnType<typeof createAgentLoginRoutes>;
  agentRuntimeRoutes: ReturnType<typeof createAgentRuntimeRoutes>;
  agentVersionRoutes: ReturnType<typeof createAgentVersionRoutes>;
  configRoutes: ReturnType<typeof createConfigRoutes>;
  visualPreviewAuthRoutes: ReturnType<typeof createVisualPreviewAuthRoutes>;
}

interface OperationalRouteDeps {
  activeWorkRoutes: ReturnType<typeof createActiveWorkRoutes>;
  dashboardRoutes: ReturnType<typeof createDashboardRoutes>;
  dockerRoutes: ReturnType<typeof createDockerRoutes>;
  executionRoutes: ReturnType<typeof createExecutionRoutes>;
  fileChangesRoutes: ReturnType<typeof createFileChangesRoutes>;
  githubRoutes: ReturnType<typeof createGitHubRoutes>;
  goalRoutes: ReturnType<typeof createGoalRoutes>;
  liveDetailsRoutes: ReturnType<typeof createLiveDetailsRoutes>;
  llmLogsRoutes: ReturnType<typeof createLlmLogsRoutes>;
  llmMetricsRoutes: ReturnType<typeof createLLMMetricsRoutes>;
  notificationRoutes: ReturnType<typeof createNotificationRoutes>;
  plannerRoutes: ReturnType<typeof createPlannerRoutes>;
  previewMediaRoutes: ReturnType<typeof createPreviewMediaRoutes>;
  queueRoutes: ReturnType<typeof createQueueRoutes>;
  relevanceRoutes: ReturnType<typeof createRelevanceRoutes>;
  repoChatRoutes: ReturnType<typeof createRepoChatRoutes>;
  repoImprovementsRoutes: ReturnType<typeof createRepoImprovementsRoutes>;
  repoTodoRoutes: ReturnType<typeof createRepoTodoRoutes>;
  repositoryMediaRoutes: ReturnType<typeof createRepositoryMediaRoutes>;
  reviewScoreRoutes: ReturnType<typeof createReviewScoreRoutes>;
  statsRoutes: ReturnType<typeof createStatsRoutes>;
  statusRoutes: ReturnType<typeof createStatusRoutes>;
  summaryBrowserRoutes: ReturnType<typeof createSummaryBrowserRoutes>;
  taskHistoryRoutes: ReturnType<typeof createTaskHistoryRoutes>;
  taskRoutes: ReturnType<typeof createTaskRoutes>;
  taskSubmissionRoutes: ReturnType<typeof createTaskSubmissionRoutes>;
  usageTipsRoutes: ReturnType<typeof createUsageTipsRoutes>;
  userRepoPreferencesRoutes: ReturnType<typeof createUserRepoPreferencesRoutes>;
  voiceRoutes: ReturnType<typeof createVoiceRoutes>;
  /** Multipart parsers that must run before their route handlers. */
  taskSubmissionUpload: RequestHandler;
  goalAttachmentUpload: RequestHandler;
  attachmentUpload: RequestHandler;
}

interface MemberCatalogRouteDeps {
  instanceCatalogRoutes: ReturnType<typeof createInstanceCatalogRoutes>;
}

export function createManagementRouteEntries({
  adminRoutes,
  adminMcpRoutes,
  agentLoginRoutes,
  agentRuntimeRoutes,
  agentVersionRoutes,
  configRoutes,
  visualPreviewAuthRoutes,
}: ManagementRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/config/followup-keywords', requireManageSettings, configRoutes.getFollowupKeywords],
    ['post', '/api/config/followup-keywords', requireManageSettings, configRoutes.postFollowupKeywords],
    ['get', '/api/config/followup-ignore-keywords', requireManageSettings, configRoutes.getFollowupIgnoreKeywords],
    ['post', '/api/config/followup-ignore-keywords', requireManageSettings, configRoutes.postFollowupIgnoreKeywords],
    ['get', '/api/config/repos', requireManageSettings, configRoutes.getRepos],
    ['post', '/api/config/repos', requireManageSettings, configRoutes.postRepos],
    ['get', '/api/config/settings', requireManageSettings, configRoutes.getSettings],
    ['post', '/api/config/settings', requireManageSettings, configRoutes.postSettings],
    ['get', '/api/config/pr-label', requireManageSettings, configRoutes.getPrLabel],
    ['post', '/api/config/pr-label', requireManageSettings, configRoutes.postPrLabel],
    ['get', '/api/config/ai-primary-tag', requireManageSettings, configRoutes.getAiPrimaryTag],
    ['post', '/api/config/ai-primary-tag', requireManageSettings, configRoutes.postAiPrimaryTag],
    ['get', '/api/config/primary-processing-labels', requireManageSettings, configRoutes.getPrimaryProcessingLabels],
    ['post', '/api/config/primary-processing-labels', requireManageSettings, configRoutes.postPrimaryProcessingLabels],
    ['get', '/api/config/agents', requireManageAgents, configRoutes.getAgents],
    ['post', '/api/config/agents', requireManageAgents, configRoutes.postAgents],
    ['get', '/api/config/synthetic-agents', requireManageAgents, configRoutes.getSyntheticAgents],
    ['post', '/api/config/synthetic-agents', requireManageAgents, configRoutes.postSyntheticAgents],
    ['get', '/api/config/summarization', requireManageSettings, configRoutes.getSummarizationSettings],
    ['post', '/api/config/summarization', requireManageSettings, configRoutes.postSummarizationSettings],
    ['get', '/api/config/repos/indexing-status', requireManageSettings, configRoutes.getRepositoriesIndexingStatus],
    ['post', '/api/config/repos/trigger-indexing', requireManageSettings, configRoutes.triggerIndexing],
    ['post', '/api/config/repos/stop-indexing', requireManageSettings, configRoutes.stopIndexing],
    ['post', '/api/config/summarization/reindex-all', requireManageSettings, configRoutes.triggerReindexAll],
    ['get', '/api/config/agent-tank', requireManageAgents, configRoutes.getAgentTankSettings],
    ['post', '/api/config/agent-tank', requireManageAgents, configRoutes.postAgentTankSettings],
    ['get', '/api/config/agent-tank/status', requireManageAgents, configRoutes.getAgentTankStatus],
    ['get', '/api/config/agent-tank/usage', requireAgentTankUsageAccess, configRoutes.getAgentTankUsage],
    ['post', '/api/config/agent-tank/refresh', requireManageAgents, configRoutes.postAgentTankRefresh],
    ['get', '/api/config/agent-tank/detect', requireManageAgents, configRoutes.getAgentTankDetect],
    ['get', '/api/config/preview-storage', requireManageSettings, visualPreviewAuthRoutes.getManagedStorageStatus],
    ['get', '/api/config/visual-preview-auth', requireManageSettings, visualPreviewAuthRoutes.getStatus],
    ['post', '/api/config/visual-preview-auth', requireManageSettings, visualPreviewAuthRoutes.useCurrentLogin],
    ['put', '/api/config/visual-preview-auth/token', requireManageSettings, visualPreviewAuthRoutes.usePersonalAccessToken],
    ['delete', '/api/config/visual-preview-auth', requireManageSettings, visualPreviewAuthRoutes.disconnect],

    ['get', '/api/admin/members', requireManageMembers, adminRoutes.listMembers],
    ['get', '/api/admin/role-audit', requireManageMembers, adminRoutes.listRoleAudit],
    ['post', '/api/admin/members/claim', requireManageMembers, adminRoutes.claimBootstrapAdmin],
    ['post', '/api/admin/members', requireManageMembers, adminRoutes.addMember],
    ['patch', '/api/admin/members/:githubUserId', requireManageMembers, adminRoutes.updateMemberRole],
    ['delete', '/api/admin/members/:githubUserId', requireManageMembers, adminRoutes.removeMember],

    ['get', '/api/admin/mcp', requireManageSettings, adminMcpRoutes.getSettings],
    ['put', '/api/admin/mcp', requireManageSettings, adminMcpRoutes.putSettings],
    ['post', '/api/admin/mcp/revoke-all', requireManageSettings, adminMcpRoutes.revokeAll],
    ['get', '/api/admin/mcp/logs', requireManageSettings, adminMcpRoutes.getLogs],
    ['get', '/api/admin/mcp/logs/stats', requireManageSettings, adminMcpRoutes.getLogStats],

    ['get', '/api/agent-runtime/packages', requireManageRuntime, agentRuntimeRoutes.getRuntimePackages],
    ['get', '/api/agent-runtime/packages/search', requireManageRuntime, agentRuntimeRoutes.searchRuntimePackages],
    ['post', '/api/agent-runtime/packages/validate', requireManageRuntime, agentRuntimeRoutes.validateRuntimePackages],
    ['put', '/api/agent-runtime/packages', requireManageRuntime, agentRuntimeRoutes.putRuntimePackages],
    ['post', '/api/agent-runtime/packages/apply', requireManageRuntime, agentRuntimeRoutes.applyRuntimePackages],
    ['post', '/api/agent-runtime/packages/verify', requireManageRuntime, agentRuntimeRoutes.verifyRuntimePackages],

    ['post', '/api/agents/:agentId/login-sessions', requireManageAgents, agentLoginRoutes.startLogin],
    ['get', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.getLogin],
    ['post', '/api/agents/:agentId/login-sessions/:sessionId/input', requireManageAgents, agentLoginRoutes.sendInput],
    ['delete', '/api/agents/:agentId/login-sessions/:sessionId', requireManageAgents, agentLoginRoutes.cancelLogin],

    ['get', '/api/agents/versions/:agentType', requireManageAgents, agentVersionRoutes.getVersions],
    ['post', '/api/agents/:agentId/build-image', requireManageAgents, agentVersionRoutes.buildImage],
    ['delete', '/api/agents/:agentType/images/cleanup', requireManageAgents, agentVersionRoutes.cleanupImages],
    ['get', '/api/agents/:agentType/images', requireManageAgents, agentVersionRoutes.listImages],
    ['post', '/api/agents/resolve-version', requireManageAgents, agentVersionRoutes.resolveVersionEndpoint],
    ['get', '/api/agents/:agentType/image-tag', requireManageAgents, agentVersionRoutes.getImageTag],
  ];
}

/**
 * Member-facing operational routes. They are registered after the shared API
 * authentication guard, so every entry requires a session or bearer identity.
 * The OpenAPI generator enumerates this table, so a route added here appears in
 * `docs/static/openapi/propr-api.yaml` (documented or `x-undocumented`).
 */
export function createOperationalRouteEntries(deps: OperationalRouteDeps): RouteEntry[] {
  const {
    activeWorkRoutes,
    dashboardRoutes,
    dockerRoutes,
    executionRoutes,
    fileChangesRoutes,
    githubRoutes,
    goalRoutes,
    liveDetailsRoutes,
    llmLogsRoutes,
    llmMetricsRoutes,
    notificationRoutes,
    plannerRoutes,
    previewMediaRoutes,
    queueRoutes,
    relevanceRoutes,
    repoChatRoutes,
    repoImprovementsRoutes,
    repoTodoRoutes,
    repositoryMediaRoutes,
    reviewScoreRoutes,
    statsRoutes,
    statusRoutes,
    summaryBrowserRoutes,
    taskHistoryRoutes,
    taskRoutes,
    taskSubmissionRoutes,
    usageTipsRoutes,
    userRepoPreferencesRoutes,
    voiceRoutes,
    taskSubmissionUpload,
    goalAttachmentUpload,
    attachmentUpload,
  } = deps;
  return [
    ['get', '/api/desktop/active-work', activeWorkRoutes.getActiveWork],
    ['post', '/api/task-submissions', taskSubmissionUpload, taskSubmissionRoutes.submit],
    ['get', '/api/task-submissions/:key', taskSubmissionRoutes.get],
    ['post', '/api/task-submissions/:key/retry', taskSubmissionRoutes.retry],
    ['get', '/api/goals/capabilities', goalRoutes.capabilities],
    ['get', '/api/goals', goalRoutes.list],
    ['get', '/api/goals/attention', goalRoutes.attention],
    ['post', '/api/goals', goalAttachmentUpload, goalRoutes.create],
    ['get', '/api/goals/:goalId', goalRoutes.get],
    ['get', '/api/goals/:goalId/detail', goalRoutes.detail],
    ['get', '/api/goals/:goalId/inputs', goalRoutes.inputs],
    ['get', '/api/goals/:goalId/wait', goalRoutes.wait],
    ['get', '/api/goals/:goalId/previews', goalRoutes.previews],
    ['delete', '/api/goals/:goalId', goalRoutes.remove],
    ['post', '/api/goals/:goalId/pause', goalRoutes.pause],
    ['post', '/api/goals/:goalId/resume', goalRoutes.resume],
    ['post', '/api/goals/:goalId/cancel', goalRoutes.cancel],
    ['patch', '/api/goals/:goalId/model', goalRoutes.requestModel],
    ['post', '/api/goals/:goalId/input', goalAttachmentUpload, goalRoutes.input],
    ['get', '/api/goals/:goalId/attachments/:attachmentId', goalRoutes.attachment],
    ['get', '/api/status', statusRoutes.getStatus],
    ['get', '/api/tasks', taskRoutes.getTasks],
    ['get', '/api/tasks/revert-preview', taskRoutes.getRevertPreview],
    ['post', '/api/tasks/revert', taskRoutes.revertChanges],
    ['post', '/api/tasks/:taskId/followup', taskRoutes.postFollowup],
    ...createTaskDeleteRouteEntries({ taskRoutes }),
    ['get', '/api/task/:taskId/history', taskHistoryRoutes.getTaskHistory],
    ['get', '/api/task/:taskId/live-details', liveDetailsRoutes.getLiveDetails],
    ['get', '/api/task/:taskId/file-changes', fileChangesRoutes.getFileChanges],
    ['get', '/api/queue/stats', queueRoutes.getQueueStats],
    ['get', '/api/activity', queueRoutes.getActivity],
    ['get', '/api/metrics', queueRoutes.getMetrics],
    ['get', '/api/llm-metrics', llmMetricsRoutes.getSummary],
    ['get', '/api/llm-metrics/:correlationId', llmMetricsRoutes.getByCorrelationId],
    ['get', '/api/llm-logs', llmLogsRoutes.getLlmLogs],
    ['get', '/api/execution/:sessionId/prompt', executionRoutes.getPrompt],
    ['get', '/api/execution/:sessionId/logs', executionRoutes.getLogs],
    ['get', '/api/execution/:sessionId/logs/:type', executionRoutes.getLogByType],
    ['get', '/api/task/:taskId/docker-info', dockerRoutes.getDockerInfo],
    ['get', '/api/task/:taskId/docker-logs', dockerRoutes.getDockerLogs],
    ['post', '/api/task/:taskId/stop', dockerRoutes.stopTask],
    ['post', '/api/task/:taskId/cancel', dockerRoutes.stopTask],
    ['post', '/api/import-tasks', githubRoutes.importTasks],
    ['get', '/api/github/repos', githubRoutes.getRepos],
    ['get', '/api/github/repos/:owner/:repo/branches', githubRoutes.getBranches],
    ['get', '/api/github/repos/:owner/:repo/workflows', githubRoutes.getWorkflows],
    ['get', '/api/planner/drafts', plannerRoutes.listDrafts],
    ['get', '/api/planner/drafts/repositories', plannerRoutes.listRepositories],
    ['post', '/api/planner/drafts', plannerRoutes.createDraft],
    ['get', '/api/planner/drafts/:id', plannerRoutes.getDraft],
    ['put', '/api/planner/drafts/:id', plannerRoutes.updateDraft],
    ['delete', '/api/planner/drafts/:id', plannerRoutes.deleteDraft],
    ['post', '/api/planner/drafts/:id/attachments', attachmentUpload, plannerRoutes.uploadAttachment],
    ['get', '/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.getAttachmentContent],
    ['delete', '/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.deleteAttachment],
    ['get', '/api/planner/drafts/:id/repository-info', plannerRoutes.getRepositoryInfo],
    ['get', '/api/planner/drafts/:id/issues', plannerRoutes.getIssues],
    ['post', '/api/planner/drafts/:id/issues/:issueNumber/implement', plannerRoutes.implementIssue],
    ['patch', '/api/planner/drafts/:id/issues/:issueNumber', plannerRoutes.updateIssue],
    ['post', '/api/planner/context/stats', plannerRoutes.getContextStats],
    ['post', '/api/planner/preview', plannerRoutes.previewContext],
    ['post', '/api/planner/preview/context', plannerRoutes.downloadContext],
    ['post', '/api/planner/generate', plannerRoutes.generate],
    ['post', '/api/planner/abort', plannerRoutes.abortGeneration],
    ['post', '/api/planner/refine', plannerRoutes.refine],
    ['post', '/api/planner/abort-refinement', plannerRoutes.abortRefinement],
    ['post', '/api/planner/finalize', plannerRoutes.finalize],
    ['post', '/api/planner/drafts/:id/reset-to-setup', plannerRoutes.resetDraftToSetup],
    ['get', '/api/planner/drafts/:id/revisions', plannerRoutes.listPlanRevisions],
    ['get', '/api/planner/drafts/:id/revisions/:revisionId', plannerRoutes.getPlanRevision],
    ['post', '/api/planner/drafts/:id/revisions/:revisionId/restore', plannerRoutes.restorePlanRevision],
    ['post', '/api/planner/drafts/:id/revise', plannerRoutes.reviseDraft],
    ['post', '/api/planner/validate-context-repository', plannerRoutes.validateContextRepository],
    ['post', '/api/planner/drafts/:id/pause', plannerRoutes.pauseDraftExecution],
    ['post', '/api/planner/drafts/:id/resume', plannerRoutes.resumeDraftExecution],
    ['patch', '/api/planner/drafts/:id/execution-settings', plannerRoutes.updateExecutionSettings],
    ['post', '/api/planner/relevance', relevanceRoutes.analyzeRelevance],
    ['get', '/api/stats/tasks', statsRoutes.getTaskStats],
    ['get', '/api/stats/repositories', statsRoutes.getRepositoryStats],
    ['get', '/api/stats/overview', statsRoutes.getOverview],
    ['get', '/api/stats/generating-plans', statsRoutes.getGeneratingPlansCount],
    ['get', '/api/stats/dashboard', statsRoutes.getDashboardStats],
    ['get', '/api/stats/review-scores', reviewScoreRoutes.getSummary],
    ['get', '/api/stats/review-scores.csv', reviewScoreRoutes.getCsv],
    ['get', '/api/pull-requests/:number/scores', reviewScoreRoutes.getPullRequestScores],
    ['get', '/api/usage-tips', usageTipsRoutes.get],
    ['post', '/api/usage-tips/dismiss', usageTipsRoutes.dismiss],
    ['get', '/api/dashboard/narrative', dashboardRoutes.getNarrative],
    ['get', '/api/dashboard/summary', dashboardRoutes.getSummary],
    ['get', '/api/dashboard/attention', dashboardRoutes.getAttention],
    ['get', '/api/dashboard/active', dashboardRoutes.getActive],
    ['get', '/api/dashboard/outcomes', dashboardRoutes.getOutcomes],
    ['get', '/api/summaries/:owner/:repo/status', summaryBrowserRoutes.getIndexingStatus],
    ['get', '/api/summaries/:owner/:repo/tree', summaryBrowserRoutes.getDirectoryTree],
    ['get', SUMMARY_TREE_ROUTE_PATH, summaryBrowserRoutes.getDirectoryTree],
    ['get', SUMMARY_PATH_ROUTE_PATH, summaryBrowserRoutes.getPathSummary],
    ['post', '/api/repos/chat', repoChatRoutes.postChat],
    ['get', '/api/repos/chat/messages', repoChatRoutes.getMessages],
    ['post', '/api/repos/chat/messages', repoChatRoutes.saveMessages],
    ['delete', '/api/repos/chat/messages/:messageId', repoChatRoutes.deleteMessage],
    ['delete', '/api/repos/chat/messages', repoChatRoutes.clearMessages],
    ['post', '/api/repos/improvements', repoImprovementsRoutes.postImprovements],
    ['get', '/api/voice/capabilities', voiceRoutes.getCapabilities],
    ['get', '/api/voice/briefing', voiceRoutes.getBriefing],
    ['get', '/api/repos/media', repositoryMediaRoutes.getMedia],
    ['get', '/api/preview-media/pulls/:owner/:repo/:number/:assetId', previewMediaRoutes.getPullMedia],
    ['get', '/api/preview-media/comments/:owner/:repo/:number/:assetId', previewMediaRoutes.getCommentMedia],
    ['get', '/api/repos/todos/categories', repoTodoRoutes.getCategories],
    ['post', '/api/repos/todos/categories', repoTodoRoutes.createCategory],
    ['put', '/api/repos/todos/categories/:categoryId', repoTodoRoutes.updateCategory],
    ['delete', '/api/repos/todos/categories/:categoryId', repoTodoRoutes.deleteCategory],
    ['post', '/api/repos/todos/categories/reorder', repoTodoRoutes.reorderCategories],
    ['get', '/api/repos/todos', repoTodoRoutes.getTodos],
    ['get', '/api/repos/todos/:todoId', repoTodoRoutes.getTodo],
    ['post', '/api/repos/todos', repoTodoRoutes.createTodo],
    ['put', '/api/repos/todos/:todoId', repoTodoRoutes.updateTodo],
    ['delete', '/api/repos/todos/:todoId', repoTodoRoutes.deleteTodo],
    ['post', '/api/repos/todos/reorder', repoTodoRoutes.reorderTodos],
    ['get', '/api/user/repo-preferences', userRepoPreferencesRoutes.getRepoPreferences],
    ['post', '/api/user/repo-preferences', userRepoPreferencesRoutes.updateRepoPreferences],
    ['get', '/api/notifications', notificationRoutes.getNotifications],
    ['get', '/api/notifications/unread-count', notificationRoutes.getUnreadCount],
    ['get', '/api/notifications/config', notificationRoutes.getConfiguration],
    ['get', '/api/notifications/capabilities', notificationRoutes.getCapabilities],
    ['get', '/api/notifications/preferences', notificationRoutes.getPreferences],
    ['patch', '/api/notifications/preferences', notificationRoutes.updatePreferences],
    ['get', '/api/notifications/push-subscriptions', notificationRoutes.listPushSubscriptions],
    ['post', '/api/notifications/push-subscriptions', notificationRoutes.createPushSubscription],
    ['delete', '/api/notifications/push-subscriptions', notificationRoutes.revokePushSubscription],
    ['delete', '/api/notifications/push-subscriptions/:subscriptionId', notificationRoutes.revokePushSubscriptionById],
    ['post', '/api/notifications/dismiss-all', notificationRoutes.dismissAll],
    ['post', '/api/notifications/:id/read', notificationRoutes.markRead],
    ['post', '/api/notifications/:id/dismiss', notificationRoutes.dismiss],
  ];
}

export function createMemberCatalogRouteEntries({
  instanceCatalogRoutes,
}: MemberCatalogRouteDeps): RouteEntry[] {
  return [
    ['get', '/api/catalog', instanceCatalogRoutes.getLegacyCatalog],
    ['get', '/api/instance/catalog', instanceCatalogRoutes.getCatalog],
    ['get', '/api/repositories/indexing-status', instanceCatalogRoutes.getRepositoryIndexingStatus],
  ];
}

export function assertNoDuplicateRoutes(routes: RouteEntry[]): void {
  const seen = new Set<string>();
  routes.forEach(([method, path]) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) throw new Error(`Duplicate route registration detected for ${key}`);
    seen.add(key);
  });
}

export function registerRouteEntries(app: Express, routes: RouteEntry[]): void {
  routes.forEach(([method, path, ...handlers]) => {
    const finalHandler = handlers.at(-1);
    if (!finalHandler) return;
    app[method](
      path,
      ...handlers.slice(0, -1),
      timeApiRouteHandler(method, path, finalHandler as RequestHandler) as RequestHandler<never>,
    );
  });
}
