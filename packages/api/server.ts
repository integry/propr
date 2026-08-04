import express, { Request, Response, RequestHandler } from 'express';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import { RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import 'dotenv/config';
import { Redis } from 'ioredis';
import { setupAuth } from './auth.js';
import { configureDemoMode, demoModeReadOnlyMiddleware } from './demoMode.js';
import { resolveGithubAuthMode, resolveGithubEventIntakeMode, validateIntakeModePrerequisites } from '@propr/shared';
import { initSocketService, closeSocketService } from './services/socketService.js';
import { createCorsOriginValidator } from './corsValidation.js';
import {
  createStatusRoutes, createTaskRoutes,
  createTaskHistoryRoutes, createLiveDetailsRoutes,
  createFileChangesRoutes, createConfigRoutes,
  createQueueRoutes, createExecutionRoutes,
  createDockerRoutes, createGitHubRoutes,
  createLLMMetricsRoutes, createLlmLogsRoutes,
  createPlannerRoutes, createRelevanceRoutes,
  createAgentRoutes, createAgentLoginRoutes,
  createAgentVersionRoutes,
  createStatsRoutes,
  createSummaryBrowserRoutes,
  createRepoChatRoutes,
  createRepoImprovementsRoutes,
  createRepoTodoRoutes,
  createUserRepoPreferencesRoutes,
  createAgentRuntimeRoutes, createNotificationRoutes, attachmentUpload
} from './routes/index.js';
import { agentLoginSessionManager } from './services/agentLoginSessionManager.js';
import { checkAndExecuteDelayedReindex } from './routes/indexingQueueHelpers.js';
import { createNotificationEntitlementRefreshMiddleware } from './routes/githubRoutes.js';
import {
  generateCorrelationId,
  processWebhookEvent,
  initializeWebhookHandler,
  db,
  loadSettingsFromConfig,
  processDetectedIssue as processDetectedIssueBase,
  handleCommentDeleted,
  handleCommentEdited,
  processCommentEvent,
  closeUltrafixStateRedis,
  getActiveTasksForPR,
  NotificationStalledDetector,
  NotificationSystemSampler,
  getNotificationStalledCheckIntervalMs,
  getNotificationSystemCheckIntervalMs,
  getNotificationProjectionLeaseTtlMs,
  closeEventPublisher, logger
} from '@propr/core';
import { initializeUltrafix } from './services/ultrafixInit.js';
import type { WebhookEventType, DetectedIssue, CommentPayload, CommentEventConfig, CommentEventType, DeliveryDisposition } from '@propr/core';
import { handleWebhookRequest } from './webhookHandler.js';
import { stopTaskExecution } from './routes/dockerRoutes.js';
import { initializePushSubscriptionMaintenance } from './services/pushSubscriptionMaintenance.js';
import { closeResources, createNotificationProjectionLease, getRedisRuntimeConfig,
  initializeServerRedis, type ShutdownTask } from './serverRuntime.js';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type RouteHandler = RequestHandler;
type RouteEntry = [RouteMethod, string, ...RouteHandler[]];
const demoMode = configureDemoMode();
const notificationEntitlementRefreshMiddleware =
  createNotificationEntitlementRefreshMiddleware(db);

function assertNoDuplicateRoutes(routes: RouteEntry[]): void {
  const seen = new Set<string>();
  routes.forEach(([method, path]) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) throw new Error(`Duplicate route registration detected for ${key}`);
    seen.add(key);
  });
}

const redisRuntimeConfig = getRedisRuntimeConfig();
const ioRedisClient = demoMode ? null : new Redis(redisRuntimeConfig.url, redisRuntimeConfig.options);

const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$';
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

function getCommentConfig(): CommentEventConfig {
    return {
        redisClient: getIoRedisClient(),
        PR_FOLLOWUP_TRIGGER_KEYWORDS,
        MODEL_LABEL_PATTERN,
        processCommentEvent: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) =>
            processCommentEvent(payload, eventType, correlationId, getCommentConfig())
    };
}

function getIoRedisClient(): Redis {
  if (!ioRedisClient) throw new Error('Redis is disabled in demo mode');
  return ioRedisClient;
}

const processDetectedIssue = (issue: DetectedIssue, correlationId: string): Promise<void | DeliveryDisposition> =>
  processDetectedIssueBase(issue, correlationId, getIoRedisClient() as unknown as Parameters<typeof processDetectedIssueBase>[2]);
const processCommentEventWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void | DeliveryDisposition> => processCommentEvent(payload, eventType, correlationId, getCommentConfig());
const handleCommentDeletedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> => handleCommentDeleted(payload, eventType, correlationId, getCommentConfig());
const handleCommentEditedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> => handleCommentEdited(payload, eventType, correlationId, getCommentConfig());

const app = express();
const PORT = process.env.DASHBOARD_API_PORT || 4000;

// Trust proxy for secure cookies behind reverse proxy (Cloudflare, nginx, etc.)
app.set('trust proxy', 1);

if (!process.env.FRONTEND_URL) {
  logger.error('FRONTEND_URL environment variable is required');
  process.exit(1);
}

// Allow all subdomains of COOKIE_DOMAIN for CORS to support PR preview environments
// that share sessions via cross-subdomain cookies
const cookieDomain = process.env.COOKIE_DOMAIN;
// CORS origin validation function - shared between Express and Socket.IO
let validateCorsOrigin: ReturnType<typeof createCorsOriginValidator>;
try {
  validateCorsOrigin = createCorsOriginValidator(process.env.FRONTEND_URL, cookieDomain);
} catch {
  logger.error({ frontendUrl: process.env.FRONTEND_URL }, 'FRONTEND_URL must be a valid URL');
  process.exit(1);
}

app.use(cors({
  origin: validateCorsOrigin,
  credentials: true
}));

// Prevent caching of API responses to avoid stale CORS issues
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Register demo read-only protection before routes so future mutating /api routes,
// including auth-adjacent endpoints, cannot bypass it by ordering.
app.use('/api', demoModeReadOnlyMiddleware);

const appEnsureAuthenticated = setupAuth(app, demoMode, {
  invalidateNotificationEntitlements: (userId, authGeneration) =>
    notificationEntitlementRefreshMiddleware.invalidate(userId, authGeneration),
  activateNotificationEntitlements: (userId, authGeneration) =>
    notificationEntitlementRefreshMiddleware.activate(userId, authGeneration),
  updateNotificationCredential: (userId, accessToken) => notificationEntitlementRefreshMiddleware.updateCredential(userId, accessToken)
});

let redisClient: RedisClientType;
let taskQueue: Queue;
let runtimeBuildQueue: Queue;
let notificationStalledDetector: NotificationStalledDetector | null = null;
let notificationSystemSampler: NotificationSystemSampler | null = null;

async function initRedis(): Promise<void> {
  ({ redisClient, taskQueue, runtimeBuildQueue } =
    await initializeServerRedis(demoMode, redisRuntimeConfig));
  logger.info({ demoMode }, 'API Redis runtime initialized');
}

function setupRoutes(): ReturnType<typeof createStatusRoutes> {
  const statusRoutes = createStatusRoutes({ redisClient });
  // INTENTIONALLY UNAUTHENTICATED: /api/compatibility is registered BEFORE the
  // `ensureAuthenticated` guard below so the hosted UI can run its pre-auth
  // version-gate before the user logs in. This is the one deliberate exception to
  // "everything under /api/* requires auth" — do not move it after the guard, and
  // keep its handler returning only non-sensitive build metadata (version +
  // compatibility dates). All other /api routes registered after this line are
  // authenticated.
  app.get('/api/compatibility', statusRoutes.getCompatibility);
  app.use('/api', appEnsureAuthenticated);
  app.use('/api', notificationEntitlementRefreshMiddleware);
  const taskRoutes = createTaskRoutes({ db, taskQueue });
  const taskHistoryRoutes = createTaskHistoryRoutes({ redisClient, taskQueue, db });
  const liveDetailsRoutes = createLiveDetailsRoutes({ redisClient, db });
  const fileChangesRoutes = createFileChangesRoutes({ db });
  const configRoutes = createConfigRoutes({ redisClient });
  const queueRoutes = createQueueRoutes({ redisClient, taskQueue });
  const executionRoutes = createExecutionRoutes({ redisClient, db });
  const dockerRoutes = createDockerRoutes({ redisClient });
  const githubRoutes = createGitHubRoutes({
    redisClient,
    taskQueue,
    db,
    invalidateNotificationEntitlements: (userId, authGeneration) => notificationEntitlementRefreshMiddleware.invalidate(userId, authGeneration)
  });
  const llmMetricsRoutes = createLLMMetricsRoutes();
  const llmLogsRoutes = createLlmLogsRoutes({ db });
  const plannerRoutes = createPlannerRoutes({ db });
  const relevanceRoutes = createRelevanceRoutes();
  const agentRoutes = createAgentRoutes();
  const agentLoginRoutes = createAgentLoginRoutes();
  const statsRoutes = createStatsRoutes({ db });
  const summaryBrowserRoutes = createSummaryBrowserRoutes();
  const repoChatRoutes = createRepoChatRoutes();
  const repoImprovementsRoutes = createRepoImprovementsRoutes();
  const repoTodoRoutes = createRepoTodoRoutes();
  const userRepoPreferencesRoutes = createUserRepoPreferencesRoutes();
  const agentRuntimeRoutes = createAgentRuntimeRoutes({ getRuntimeBuildQueue: () => runtimeBuildQueue }), notificationRoutes = createNotificationRoutes();
  const register = (method: RouteMethod, path: string, ...handlers: RouteHandler[]): void => {
    app[method](path, ...handlers);
  };

  const routes: RouteEntry[] = [
    ['get', '/api/status', statusRoutes.getStatus], ['get', '/api/tasks', taskRoutes.getTasks], ['get', '/api/tasks/revert-preview', taskRoutes.getRevertPreview], ['post', '/api/tasks/revert', taskRoutes.revertChanges],
    ['post', '/api/tasks/:taskId/followup', taskRoutes.postFollowup], ['delete', '/api/tasks/:taskId', taskRoutes.deleteTask], ['get', '/api/task/:taskId/history', taskHistoryRoutes.getTaskHistory], ['get', '/api/task/:taskId/live-details', liveDetailsRoutes.getLiveDetails],
    ['get', '/api/task/:taskId/file-changes', fileChangesRoutes.getFileChanges], ['get', '/api/config/followup-keywords', configRoutes.getFollowupKeywords], ['post', '/api/config/followup-keywords', configRoutes.postFollowupKeywords], ['get', '/api/config/followup-ignore-keywords', configRoutes.getFollowupIgnoreKeywords],
    ['post', '/api/config/followup-ignore-keywords', configRoutes.postFollowupIgnoreKeywords], ['get', '/api/config/repos', configRoutes.getRepos], ['post', '/api/config/repos', configRoutes.postRepos], ['get', '/api/config/settings', configRoutes.getSettings],
    ['post', '/api/config/settings', configRoutes.postSettings], ['get', '/api/config/pr-label', configRoutes.getPrLabel], ['post', '/api/config/pr-label', configRoutes.postPrLabel], ['get', '/api/config/ai-primary-tag', configRoutes.getAiPrimaryTag],
    ['post', '/api/config/ai-primary-tag', configRoutes.postAiPrimaryTag], ['get', '/api/config/primary-processing-labels', configRoutes.getPrimaryProcessingLabels], ['post', '/api/config/primary-processing-labels', configRoutes.postPrimaryProcessingLabels], ['get', '/api/config/agents', configRoutes.getAgents],
    ['post', '/api/config/agents', configRoutes.postAgents], ['get', '/api/config/summarization', configRoutes.getSummarizationSettings], ['post', '/api/config/summarization', configRoutes.postSummarizationSettings], ['get', '/api/config/repos/indexing-status', configRoutes.getRepositoriesIndexingStatus],
    ['post', '/api/config/repos/trigger-indexing', configRoutes.triggerIndexing], ['post', '/api/config/repos/stop-indexing', configRoutes.stopIndexing], ['post', '/api/config/summarization/reindex-all', configRoutes.triggerReindexAll], ['get', '/api/config/agent-tank', configRoutes.getAgentTankSettings],
    ['post', '/api/config/agent-tank', configRoutes.postAgentTankSettings], ['get', '/api/config/agent-tank/status', configRoutes.getAgentTankStatus], ['get', '/api/config/agent-tank/usage', configRoutes.getAgentTankUsage], ['post', '/api/config/agent-tank/refresh', configRoutes.postAgentTankRefresh],
    ['get', '/api/config/agent-tank/detect', configRoutes.getAgentTankDetect], ['get', '/api/queue/stats', queueRoutes.getQueueStats], ['get', '/api/activity', queueRoutes.getActivity], ['get', '/api/metrics', queueRoutes.getMetrics],
    ['get', '/api/llm-metrics', llmMetricsRoutes.getSummary], ['get', '/api/llm-metrics/:correlationId', llmMetricsRoutes.getByCorrelationId], ['get', '/api/llm-logs', llmLogsRoutes.getLlmLogs], ['get', '/api/execution/:sessionId/prompt', executionRoutes.getPrompt],
    ['get', '/api/execution/:sessionId/logs', executionRoutes.getLogs], ['get', '/api/execution/:sessionId/logs/:type', executionRoutes.getLogByType], ['get', '/api/task/:taskId/analysis', executionRoutes.getAnalysis], ['get', '/api/task/:taskId/docker-info', dockerRoutes.getDockerInfo],
    ['get', '/api/task/:taskId/docker-logs', dockerRoutes.getDockerLogs], ['post', '/api/task/:taskId/stop', dockerRoutes.stopTask], ['post', '/api/import-tasks', githubRoutes.importTasks], ['get', '/api/github/repos', githubRoutes.getRepos],
    ['get', '/api/github/repos/:owner/:repo/branches', githubRoutes.getBranches], ['get', '/api/planner/drafts', plannerRoutes.listDrafts], ['get', '/api/planner/drafts/repositories', plannerRoutes.listRepositories], ['post', '/api/planner/drafts', plannerRoutes.createDraft],
    ['get', '/api/planner/drafts/:id', plannerRoutes.getDraft], ['put', '/api/planner/drafts/:id', plannerRoutes.updateDraft], ['delete', '/api/planner/drafts/:id', plannerRoutes.deleteDraft], ['post', '/api/planner/drafts/:id/attachments', attachmentUpload, plannerRoutes.uploadAttachment],
    ['get', '/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.getAttachmentContent], ['delete', '/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.deleteAttachment], ['get', '/api/planner/drafts/:id/repository-info', plannerRoutes.getRepositoryInfo], ['get', '/api/planner/drafts/:id/issues', plannerRoutes.getIssues],
    ['post', '/api/planner/drafts/:id/issues/:issueNumber/implement', plannerRoutes.implementIssue], ['patch', '/api/planner/drafts/:id/issues/:issueNumber', plannerRoutes.updateIssue], ['post', '/api/planner/context/stats', plannerRoutes.getContextStats],
    ['post', '/api/planner/preview', plannerRoutes.previewContext], ['post', '/api/planner/preview/context', plannerRoutes.downloadContext], ['post', '/api/planner/generate', plannerRoutes.generate], ['post', '/api/planner/abort', plannerRoutes.abortGeneration],
    ['post', '/api/planner/refine', plannerRoutes.refine], ['post', '/api/planner/abort-refinement', plannerRoutes.abortRefinement], ['post', '/api/planner/finalize', plannerRoutes.finalize], ['post', '/api/planner/drafts/:id/reset-to-setup', plannerRoutes.resetDraftToSetup],
    ['post', '/api/planner/drafts/:id/revise', plannerRoutes.reviseDraft], ['post', '/api/planner/validate-context-repository', plannerRoutes.validateContextRepository], ['post', '/api/planner/drafts/:id/pause', plannerRoutes.pauseDraftExecution], ['post', '/api/planner/drafts/:id/resume', plannerRoutes.resumeDraftExecution],
    ['patch', '/api/planner/drafts/:id/execution-settings', plannerRoutes.updateExecutionSettings], ['post', '/api/planner/relevance', relevanceRoutes.analyzeRelevance], ['get', '/api/stats/tasks', statsRoutes.getTaskStats], ['get', '/api/stats/repositories', statsRoutes.getRepositoryStats],
    ['get', '/api/stats/overview', statsRoutes.getOverview], ['get', '/api/stats/generating-plans', statsRoutes.getGeneratingPlansCount], ['get', '/api/summaries/:owner/:repo/status', summaryBrowserRoutes.getIndexingStatus], ['get', '/api/summaries/:owner/:repo/tree', summaryBrowserRoutes.getDirectoryTree],
    ['get', '/api/summaries/:owner/:repo/tree/*', summaryBrowserRoutes.getDirectoryTree], ['get', '/api/summaries/:owner/:repo/summary/*', summaryBrowserRoutes.getPathSummary], ['post', '/api/repos/chat', repoChatRoutes.postChat], ['get', '/api/repos/chat/messages', repoChatRoutes.getMessages],
    ['post', '/api/repos/chat/messages', repoChatRoutes.saveMessages], ['delete', '/api/repos/chat/messages/:messageId', repoChatRoutes.deleteMessage], ['delete', '/api/repos/chat/messages', repoChatRoutes.clearMessages], ['post', '/api/repos/improvements', repoImprovementsRoutes.postImprovements],
    ['get', '/api/repos/todos/categories', repoTodoRoutes.getCategories], ['post', '/api/repos/todos/categories', repoTodoRoutes.createCategory], ['put', '/api/repos/todos/categories/:categoryId', repoTodoRoutes.updateCategory], ['delete', '/api/repos/todos/categories/:categoryId', repoTodoRoutes.deleteCategory],
    ['post', '/api/repos/todos/categories/reorder', repoTodoRoutes.reorderCategories], ['get', '/api/repos/todos', repoTodoRoutes.getTodos], ['get', '/api/repos/todos/:todoId', repoTodoRoutes.getTodo], ['post', '/api/repos/todos', repoTodoRoutes.createTodo],
    ['put', '/api/repos/todos/:todoId', repoTodoRoutes.updateTodo], ['delete', '/api/repos/todos/:todoId', repoTodoRoutes.deleteTodo], ['post', '/api/repos/todos/reorder', repoTodoRoutes.reorderTodos], ['get', '/api/user/repo-preferences', userRepoPreferencesRoutes.getRepoPreferences],
    ['post', '/api/user/repo-preferences', userRepoPreferencesRoutes.updateRepoPreferences], ['get', '/api/notifications', notificationRoutes.getNotifications], ['get', '/api/notifications/unread-count', notificationRoutes.getUnreadCount], ['get', '/api/notifications/config', notificationRoutes.getConfiguration], ['get', '/api/notifications/capabilities', notificationRoutes.getCapabilities],
    ['get', '/api/notifications/preferences', notificationRoutes.getPreferences], ['patch', '/api/notifications/preferences', notificationRoutes.updatePreferences], ['get', '/api/notifications/push-subscriptions', notificationRoutes.listPushSubscriptions], ['post', '/api/notifications/push-subscriptions', notificationRoutes.createPushSubscription], ['delete', '/api/notifications/push-subscriptions', notificationRoutes.revokePushSubscription], ['delete', '/api/notifications/push-subscriptions/:subscriptionId', notificationRoutes.revokePushSubscriptionById], ['post', '/api/notifications/:id/read', notificationRoutes.markRead], ['post', '/api/notifications/:id/dismiss', notificationRoutes.dismiss],
    ['get', '/api/agent-runtime/packages', agentRuntimeRoutes.getRuntimePackages],
    ['get', '/api/agent-runtime/packages/search', agentRuntimeRoutes.searchRuntimePackages],
    ['post', '/api/agent-runtime/packages/validate', agentRuntimeRoutes.validateRuntimePackages],
    ['put', '/api/agent-runtime/packages', agentRuntimeRoutes.putRuntimePackages],
    ['post', '/api/agent-runtime/packages/apply', agentRuntimeRoutes.applyRuntimePackages],
    ['post', '/api/agents/:agentId/login-sessions', agentLoginRoutes.startLogin],
    ['get', '/api/agents/:agentId/login-sessions/:sessionId', agentLoginRoutes.getLogin],
    ['post', '/api/agents/:agentId/login-sessions/:sessionId/input', agentLoginRoutes.sendInput],
    ['delete', '/api/agents/:agentId/login-sessions/:sessionId', agentLoginRoutes.cancelLogin],
  ];
  assertNoDuplicateRoutes(routes);
  routes.forEach(([method, path, ...handlers]) => register(method, path, ...handlers));

  const agentVersionRoutes = createAgentVersionRoutes();
  const agentVersionRouteEntries: RouteEntry[] = [
    ['get', '/api/agents/versions/:agentType', agentVersionRoutes.getVersions],
    ['post', '/api/agents/:agentId/build-image', agentVersionRoutes.buildImage],
    ['delete', '/api/agents/:agentType/images/cleanup', agentVersionRoutes.cleanupImages],
    ['get', '/api/agents/:agentType/images', agentVersionRoutes.listImages],
    ['post', '/api/agents/resolve-version', agentVersionRoutes.resolveVersionEndpoint],
    ['get', '/api/agents/:agentType/image-tag', agentVersionRoutes.getImageTag],
  ];
  agentVersionRouteEntries.forEach(([method, path, handler]) => register(method, path, handler));
  app.use('/api/agents', agentRoutes.router);

  setupWebhookRoute();
  return statusRoutes;
}

function setupWebhookRoute(): void {
  if (demoMode) {
    app.post('/webhook', (_req: Request, res: Response) => {
      res.status(403).send('Webhook processing is disabled in demo mode.');
    });
    logger.info('Webhook endpoint disabled in demo mode');
    return;
  }

  const { mode: intakeMode, warnings } = resolveGithubEventIntakeMode({
    eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
    enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS,
  });
  for (const warning of warnings) logger.warn({ warning }, 'GitHub event intake warning');

  if (intakeMode !== 'direct_webhook') {
    logger.info({ intakeMode }, 'Webhook endpoint disabled for configured event intake mode');
    return;
  }

  // Validate the FULL direct_webhook prerequisites before exposing POST /webhook,
  // not just GH_WEBHOOK_SECRET. Direct webhook requires an own GitHub App (app auth
  // mode) to process deliveries — the API must not start with a registered webhook
  // endpoint in a partially-valid setup (e.g. relay auth + a secret), which would
  // accept signed deliveries it cannot service. We reuse the same shared validator
  // the daemon boot path and `propr check` use, so all three agree on what
  // direct_webhook needs.
  const { mode: authMode } = resolveGithubAuthMode({
    demoMode: false, // demo mode short-circuits above; here we are always non-demo.
    ghAuthMode: process.env.GH_AUTH_MODE,
    relayUrl: process.env.PROPR_GH_RELAY_URL,
    relayToken: process.env.PROPR_GH_RELAY_TOKEN,
    appId: process.env.GH_APP_ID,
    privateKeyPath: process.env.GH_PRIVATE_KEY_PATH,
    installationId: process.env.GH_INSTALLATION_ID,
  });
  const { errors } = validateIntakeModePrerequisites({
    intakeMode,
    authMode,
    routingUrl: process.env.PROPR_ROUTING_URL,
    relayUrl: process.env.PROPR_GH_RELAY_URL,
    relayToken: process.env.PROPR_GH_RELAY_TOKEN,
    webhookSecret: process.env.GH_WEBHOOK_SECRET,
  });
  if (errors.length > 0) {
    throw new Error(`[webhook] GITHUB_EVENT_INTAKE_MODE is "direct_webhook" but its prerequisites are not met. Refusing to start:\n  - ${errors.join('\n  - ')}`);
  }
  // The processor below (processWebhookEvent) is backed by the handler registered
  // via initializeWebhookHandler in start(), in this same API process — so a
  // direct_webhook delivery accepted here is processed in-process, not forwarded
  // to the daemon. The daemon's own handler registration is for the routing path.
  app.post('/webhook', async (req: Request, res: Response) => {
    const correlationId = generateCorrelationId();
    try {
      await handleWebhookRequest(req, res, {
        webhookSecret: process.env.GH_WEBHOOK_SECRET,
        redis: { set: (key, value, opts) => opts
          ? redisClient.set(key, value, { ...(opts.NX ? { NX: true as const } : {}), ...(opts.EX != null ? { EX: opts.EX } : {}) }) as Promise<string | null>
          : redisClient.set(key, value) as Promise<string | null> },
        processor: async (payload, event, cid) => {
          await processWebhookEvent(payload, event as WebhookEventType, cid);
        },
        correlationId,
        mergedPRTaskCanceller: {
          getActiveTasksForPR,
          stopTask: (taskIdOrJobId, context) => stopTaskExecution(taskIdOrJobId, { redisClient, ...context }),
        },
      });
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Webhook processing failed');
      if (!res.headersSent) {
        res.status(500).send('Internal webhook processing error.');
      }
    }
  });
  logger.info('Webhook endpoint enabled at POST /webhook');
}

app.get('/health', (_req: Request, res: Response) => { res.json({ status: 'ok' }); });

// Create HTTP server to wrap Express app (required for Socket.IO)
const httpServer: HttpServer = createServer(app);

async function start(): Promise<void> {
  try {
    logger.info('SQLite persistence is enabled');
    await db.migrate.latest();
    logger.info('Database migrations completed successfully');
    if (demoMode) logger.info('Demo mode enabled with read-only synthetic user');
    await initRedis();
    if (!demoMode) {
      void notificationEntitlementRefreshMiddleware.recover().catch(error => logger.warn({ error: (error as Error).message }, 'Entitlement schedule recovery failed'));
      await initializePushSubscriptionMaintenance();
      const stalledIntervalMs = getNotificationStalledCheckIntervalMs();
      notificationStalledDetector = new NotificationStalledDetector({
        intervalMs: stalledIntervalMs,
        acquireLease: createNotificationProjectionLease(
          redisClient,
          'stalled-activity',
          getNotificationProjectionLeaseTtlMs(stalledIntervalMs)
        )
      });
      notificationStalledDetector.start();
      try { await loadSettingsFromConfig(); } catch (error) { logger.warn({ error: (error as Error).message }, 'Failed to load settings from config repository'); }
      try {
        const removed = await agentLoginSessionManager.cleanupOrphanedContainers();
        if (removed > 0) logger.info({ removed }, 'Removed orphaned agent login containers');
      } catch (error) {
        // Docker-backed features surface their own errors when invoked; a
        // best-effort orphan sweep must not make the rest of the API unavailable.
        logger.warn({ error: (error as Error).message }, 'Could not sweep orphaned agent login containers');
      }
    } else {
      logger.info('Demo mode skipped startup configuration initialization');
    }
    const statusRoutes = setupRoutes();
    if (!demoMode) {
      const systemCheckIntervalMs = getNotificationSystemCheckIntervalMs();
      notificationSystemSampler = new NotificationSystemSampler({
        getSnapshot: statusRoutes.getNotificationHealthSnapshot,
        intervalMs: systemCheckIntervalMs,
        acquireLease: createNotificationProjectionLease(
          redisClient,
          'system-health',
          getNotificationProjectionLeaseTtlMs(systemCheckIntervalMs)
        )
      });
      notificationSystemSampler.start();
      const socketService = initSocketService(httpServer, validateCorsOrigin);
      logger.info('Socket.IO server initialized');
      socketService.initQueueFeatures({ taskQueue, redisClient, db });
      logger.info('WebSocket queue features initialized');
      await initializeUltrafix(getIoRedisClient());
      // Register the webhook processors in THIS (API) process ONLY when the API
      // actually serves webhooks — i.e. direct_webhook mode, where this process
      // owns POST /webhook and dispatches deliveries via processWebhookEvent. In
      // routing/polling modes the daemon owns event intake and the API never
      // processes deliveries, so initializing the handler here is unnecessary work
      // with possible side effects. A mode change already requires a process
      // restart, so there is nothing to gain from initializing it unconditionally.
      //
      // In direct_webhook mode the initialization is REQUIRED, not best-effort: a
      // registered /webhook endpoint with no backing handler would accept signed
      // deliveries and fail every one at runtime. Let a failure here propagate to
      // start()'s catch (which exits non-zero) so the operator sees the problem at
      // startup instead of as silent per-delivery failures.
      const { mode: apiIntakeMode } = resolveGithubEventIntakeMode({
        eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
        enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS,
      });
      if (apiIntakeMode === 'direct_webhook') {
        await initializeWebhookHandler({ issueProcessor: processDetectedIssue, commentProcessor: processCommentEventWrapper, commentDeletedHandler: handleCommentDeletedWrapper, commentEditedHandler: handleCommentEditedWrapper });
        logger.info('Webhook handler initialized');
      }
      setInterval(async () => {
        try {
          await checkAndExecuteDelayedReindex(redisClient as RedisClientType);
        } catch (error) {
          logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Delayed reindex check failed');
        }
      }, 30 * 1000);
    }
    httpServer.listen(PORT, () => logger.info({ port: PORT, demoMode }, 'Dashboard API server started'));

    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received; shutting down gracefully');
      if (!demoMode) {
        await closeResources([
          { name: 'notification stalled detector', close: () => notificationStalledDetector?.stop() ?? Promise.resolve() },
          { name: 'notification system sampler', close: () => notificationSystemSampler?.stop() ?? Promise.resolve() }
        ]);
      }
      const shutdownTasks: ShutdownTask[] = [
        {
          name: 'notification entitlement refresh middleware',
          close: async () => notificationEntitlementRefreshMiddleware.close()
        },
        { name: 'task queue', close: () => taskQueue.close() },
        { name: 'agent runtime build queue', close: () => runtimeBuildQueue.close() },
        { name: 'agent login sessions', close: () => agentLoginSessionManager.close() },
        { name: 'redis client', close: () => redisClient.quit() }
      ];
      if (!demoMode) {
        shutdownTasks.push(
          { name: 'event publisher', close: () => closeEventPublisher() },
          { name: 'ultrafix state redis', close: () => closeUltrafixStateRedis() },
          { name: 'socket service', close: () => closeSocketService() },
          { name: 'io redis client', close: () => getIoRedisClient().quit() }
        );
      }
      await closeResources(shutdownTasks);
      httpServer.close(() => {
        logger.info('API server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) },
      'API server failed to start');
    process.exit(1);
  }
}

start();
