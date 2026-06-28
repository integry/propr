import express, { Request, Response, RequestHandler } from 'express';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import { createClient, RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import 'dotenv/config';
import { Redis, RedisOptions } from 'ioredis';
import { setupAuth, ensureAuthenticated } from './auth.js';
import { configureDemoMode, createDemoRedisClient, demoModeReadOnlyMiddleware } from './demoMode.js';
import { resolveGithubAuthMode, resolveGithubEventIntakeMode, validateIntakeModePrerequisites } from '@propr/shared';
import { initSocketService, closeSocketService } from './services/socketService.js';
import {
  createStatusRoutes,
  createTaskRoutes,
  createTaskHistoryRoutes,
  createLiveDetailsRoutes,
  createFileChangesRoutes,
  createConfigRoutes,
  createQueueRoutes,
  createExecutionRoutes,
  createDockerRoutes,
  createGitHubRoutes,
  createLLMMetricsRoutes,
  createLlmLogsRoutes,
  createPlannerRoutes,
  createRelevanceRoutes,
  createAgentRoutes,
  createAgentVersionRoutes,
  createStatsRoutes,
  createSummaryBrowserRoutes,
  createRepoChatRoutes,
  createRepoImprovementsRoutes,
  createRepoTodoRoutes,
  createUserRepoPreferencesRoutes,
  attachmentUpload
} from './routes/index.js';
import { checkAndExecuteDelayedReindex } from './routes/indexingQueueHelpers.js';
import {
  generateCorrelationId,
  processWebhookEvent,
  initializeWebhookHandler,
  buildRedisRuntimeConfig,
  db,
  loadSettingsFromConfig,
  processDetectedIssue as processDetectedIssueBase,
  handleCommentDeleted,
  handleCommentEdited,
  processCommentEvent,
  closeUltrafixStateRedis,
  getActiveTasksForPR
} from '@propr/core';
import { initializeUltrafix } from './services/ultrafixInit.js';
import type { WebhookEventType, DetectedIssue, CommentPayload, CommentEventConfig, CommentEventType, DeliveryDisposition } from '@propr/core';
import { handleWebhookRequest } from './webhookHandler.js';
import { stopTaskExecution } from './routes/dockerRoutes.js';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type RouteHandler = RequestHandler;
type RouteEntry = [RouteMethod, string, ...RouteHandler[]];
type ShutdownTask = { name: string; close: () => Promise<unknown> };

const demoMode = configureDemoMode();

function buildRedisUrlFromOptions(options: RedisOptions): string {
  const protocol = options.tls ? 'rediss' : 'redis';
  const host = options.host || 'redis';
  const port = options.port || 6379;
  const credentials = options.username
    ? `${encodeURIComponent(options.username)}:${encodeURIComponent(options.password || '')}@`
    : options.password
      ? `:${encodeURIComponent(options.password)}@`
      : '';
  const database = typeof options.db === 'number' ? `/${options.db}` : '';

  return `${protocol}://${credentials}${host}:${port}${database}`;
}

function getRedisRuntimeConfig(): { url: string; options: RedisOptions } {
  const runtimeConfig = buildRedisRuntimeConfig();
  return {
    url: runtimeConfig.url || buildRedisUrlFromOptions(runtimeConfig.options),
    options: { ...runtimeConfig.options }
  };
}

async function closeResources(tasks: ShutdownTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async ({ close }) => close()));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Failed to close ${tasks[index].name}:`, result.reason);
    }
  });
}

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
const handleCommentDeletedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void | DeliveryDisposition> => handleCommentDeleted(payload, eventType, correlationId, getCommentConfig());
const handleCommentEditedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void | DeliveryDisposition> => handleCommentEdited(payload, eventType, correlationId, getCommentConfig());

const app = express();
const PORT = process.env.DASHBOARD_API_PORT || 4000;

// Trust proxy for secure cookies behind reverse proxy (Cloudflare, nginx, etc.)
app.set('trust proxy', 1);

if (!process.env.FRONTEND_URL) {
  console.error('FRONTEND_URL environment variable is required');
  process.exit(1);
}

// Allow all subdomains of COOKIE_DOMAIN for CORS to support PR preview environments
// that share sessions via cross-subdomain cookies
const cookieDomain = process.env.COOKIE_DOMAIN;
// Remove leading dot if present for hostname matching
const baseDomain = cookieDomain?.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
let frontendOrigin: string;
try {
  frontendOrigin = new URL(process.env.FRONTEND_URL).origin;
} catch {
  console.error(`FRONTEND_URL must be a valid URL, got: ${process.env.FRONTEND_URL}`);
  process.exit(1);
}

// CORS origin validation function - shared between Express and Socket.IO
function validateCorsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void {
  // Allow requests with no origin (e.g., mobile apps, curl, etc.)
  if (!origin) {
    callback(null, true);
    return;
  }
  try {
    const url = new URL(origin);
    // Allow the base domain and any subdomain
    if (baseDomain && (url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain))) {
      callback(null, true);
    } else if (url.origin === frontendOrigin) {
      callback(null, true);
    } else if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      // Allow localhost for development
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  } catch {
    callback(new Error('Invalid origin'));
  }
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

setupAuth(app, demoMode);

let redisClient: RedisClientType;
let taskQueue: Queue;

function createDemoTaskQueue(): Queue {
  return {
    add: async () => { throw new Error('Task queue is disabled in demo mode'); },
    close: async () => undefined,
    getWaitingCount: async () => 0,
    getActiveCount: async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount: async () => 0,
    getDelayedCount: async () => 0,
    getJob: async () => null,
  } as unknown as Queue;
}

async function initRedis(): Promise<void> {
  if (demoMode) {
    redisClient = createDemoRedisClient();
    taskQueue = createDemoTaskQueue();
    console.log('Demo mode: Redis and task queue clients are disabled; using read-only in-memory facades');
    return;
  }

  redisClient = createClient({
    url: redisRuntimeConfig.url
  });
  
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();
  
  const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
  taskQueue = new Queue(queueName, {
    connection: { ...redisRuntimeConfig.options }
  });
  
  console.log('Connected to Redis');
}

function setupRoutes(): void {
  app.use('/api', ensureAuthenticated);
  const statusRoutes = createStatusRoutes({ redisClient });
  const taskRoutes = createTaskRoutes({ db, taskQueue });
  const taskHistoryRoutes = createTaskHistoryRoutes({ redisClient, taskQueue, db });
  const liveDetailsRoutes = createLiveDetailsRoutes({ redisClient, db });
  const fileChangesRoutes = createFileChangesRoutes({ db });
  const configRoutes = createConfigRoutes({ redisClient });
  const queueRoutes = createQueueRoutes({ redisClient, taskQueue });
  const executionRoutes = createExecutionRoutes({ redisClient, db });
  const dockerRoutes = createDockerRoutes({ redisClient });
  const githubRoutes = createGitHubRoutes({ redisClient, taskQueue, db });
  const llmMetricsRoutes = createLLMMetricsRoutes();
  const llmLogsRoutes = createLlmLogsRoutes({ db });
  const plannerRoutes = createPlannerRoutes({ db });
  const relevanceRoutes = createRelevanceRoutes();
  const agentRoutes = createAgentRoutes();
  const statsRoutes = createStatsRoutes({ db });
  const summaryBrowserRoutes = createSummaryBrowserRoutes();
  const repoChatRoutes = createRepoChatRoutes();
  const repoImprovementsRoutes = createRepoImprovementsRoutes();
  const repoTodoRoutes = createRepoTodoRoutes();
  const userRepoPreferencesRoutes = createUserRepoPreferencesRoutes();
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
    ['post', '/api/user/repo-preferences', userRepoPreferencesRoutes.updateRepoPreferences],
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
}

function setupWebhookRoute(): void {
  if (demoMode) {
    app.post('/webhook', (_req: Request, res: Response) => {
      res.status(403).send('Webhook processing is disabled in demo mode.');
    });
    console.log('[webhook] Webhook endpoint disabled in demo mode');
    return;
  }

  const { mode: intakeMode, warnings } = resolveGithubEventIntakeMode({
    eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
    enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS,
  });
  for (const warning of warnings) console.warn(`[webhook] ${warning}`);

  if (intakeMode !== 'direct_webhook') {
    console.log(`[webhook] Webhook endpoint disabled (GITHUB_EVENT_INTAKE_MODE is "${intakeMode}", not "direct_webhook")`);
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
      console.error('[webhook] Error processing webhook:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal webhook processing error.');
      }
    }
  });
  console.log('[webhook] Webhook endpoint enabled at POST /webhook');
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Create HTTP server to wrap Express app (required for Socket.IO)
const httpServer: HttpServer = createServer(app);

async function start(): Promise<void> {
  try {
    console.log('SQLite persistence is enabled');
    try { await db.migrate.latest(); console.log('Database migrations completed successfully'); } catch (error) { console.error('Database migration failed:', error); }
    if (demoMode) console.log('Demo mode enabled: API uses a synthetic user, rejects mutating requests, and skips execution processors');
    await initRedis();
    if (!demoMode) {
      try { await loadSettingsFromConfig(); } catch (error) { console.warn('Failed to load settings from config repo:', (error as Error).message); }
    } else {
      console.log('Demo mode: skipped startup config initialization; API config reads use the curated database directly');
    }
    setupRoutes();
    if (!demoMode) {
      const socketService = initSocketService(httpServer, validateCorsOrigin);
      console.log('[WebSocket] Socket.IO server initialized');
      socketService.initQueueFeatures({ taskQueue, redisClient, db });
      console.log('[WebSocket] Queue features initialized for real-time updates');
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
        console.log('[webhook] Webhook handler initialized');
      }
      setInterval(async () => {
        try {
          await checkAndExecuteDelayedReindex(redisClient as RedisClientType);
        } catch (error) {
          console.error('Error checking for delayed reindex:', error);
        }
      }, 30 * 1000);
    }
    httpServer.listen(PORT, () => { console.log(`Dashboard API server running on port ${PORT}${demoMode ? '' : ' (with WebSocket support)'}`); });

    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      const shutdownTasks: ShutdownTask[] = [
        { name: 'task queue', close: () => taskQueue.close() },
        { name: 'redis client', close: () => redisClient.quit() }
      ];
      if (!demoMode) {
        shutdownTasks.push(
          { name: 'ultrafix state redis', close: () => closeUltrafixStateRedis() },
          { name: 'socket service', close: () => closeSocketService() },
          { name: 'io redis client', close: () => getIoRedisClient().quit() }
        );
      }
      await closeResources(shutdownTasks);
      httpServer.close(() => {
        console.log('Server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
