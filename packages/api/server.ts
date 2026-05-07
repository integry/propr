import express, { Request, Response, RequestHandler } from 'express';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import { createClient, RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import 'dotenv/config';
import { Redis, RedisOptions } from 'ioredis';
import { setupAuth, ensureAuthenticated } from './auth.js';
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
  closeUltrafixStateRedis
} from '@propr/core';
import { initializeUltrafix } from './services/ultrafixInit.js';
import type { WebhookEventType, DetectedIssue, CommentPayload, CommentEventConfig, CommentEventType } from '@propr/core';
import * as configManager from '@propr/core';
import { handleWebhookRequest } from './webhookHandler.js';

type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type RouteHandler = RequestHandler;
type RouteEntry = [RouteMethod, string, ...RouteHandler[]];

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

const redisRuntimeConfig = getRedisRuntimeConfig();
const ioRedisClient = new Redis(redisRuntimeConfig.url, redisRuntimeConfig.options);

const MODEL_LABEL_PATTERN = process.env.MODEL_LABEL_PATTERN || '^llm-(.+)$';
const PR_FOLLOWUP_TRIGGER_KEYWORDS = (process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS !== undefined ? process.env.PR_FOLLOWUP_TRIGGER_KEYWORDS : '').split(',').filter(k => k.trim()).map(k => k.trim());

function getCommentConfig(): CommentEventConfig {
    return {
        redisClient: ioRedisClient,
        PR_FOLLOWUP_TRIGGER_KEYWORDS,
        MODEL_LABEL_PATTERN,
        processCommentEvent: (payload: CommentPayload, eventType: CommentEventType, correlationId: string) =>
            processCommentEvent(payload, eventType, correlationId, getCommentConfig())
    };
}

const processDetectedIssue = (issue: DetectedIssue, correlationId: string): Promise<void> =>
  processDetectedIssueBase(issue, correlationId, ioRedisClient as unknown as Parameters<typeof processDetectedIssueBase>[2]);

const processCommentEventWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    processCommentEvent(payload, eventType, correlationId, getCommentConfig());
const handleCommentDeletedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    handleCommentDeleted(payload, eventType, correlationId, getCommentConfig());
const handleCommentEditedWrapper = (payload: CommentPayload, eventType: CommentEventType, correlationId: string): Promise<void> =>
    handleCommentEdited(payload, eventType, correlationId, getCommentConfig());

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
const cookieDomain = process.env.COOKIE_DOMAIN || '.gitfix.dev';
// Remove leading dot if present for hostname matching
const baseDomain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;

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
    if (url.hostname === baseDomain || url.hostname.endsWith('.' + baseDomain)) {
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

setupAuth(app);

let redisClient: RedisClientType;
let taskQueue: Queue;

async function initRedis(): Promise<void> {
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
  const register = (
    method: RouteMethod,
    path: string,
    ...handlers: RouteHandler[]
  ): void => {
    app[method](path, ...handlers);
  };

  const routes: RouteEntry[] = [
    ['get', '/api/status', statusRoutes.getStatus],
    ['get', '/api/tasks', taskRoutes.getTasks],
    ['get', '/api/tasks/revert-preview', taskRoutes.getRevertPreview],
    ['post', '/api/tasks/revert', taskRoutes.revertChanges],
    ['post', '/api/tasks/:taskId/followup', taskRoutes.postFollowup],
    ['delete', '/api/tasks/:taskId', taskRoutes.deleteTask],
    ['get', '/api/task/:taskId/history', taskHistoryRoutes.getTaskHistory],
    ['get', '/api/task/:taskId/live-details', liveDetailsRoutes.getLiveDetails],
    ['get', '/api/task/:taskId/file-changes', fileChangesRoutes.getFileChanges],
    ['get', '/api/config/followup-keywords', configRoutes.getFollowupKeywords],
    ['post', '/api/config/followup-keywords', configRoutes.postFollowupKeywords],
    ['get', '/api/config/followup-ignore-keywords', configRoutes.getFollowupIgnoreKeywords],
    ['post', '/api/config/followup-ignore-keywords', configRoutes.postFollowupIgnoreKeywords],
    ['get', '/api/config/repos', configRoutes.getRepos],
    ['post', '/api/config/repos', configRoutes.postRepos],
    ['get', '/api/config/settings', configRoutes.getSettings],
    ['post', '/api/config/settings', configRoutes.postSettings],
    ['get', '/api/config/pr-label', configRoutes.getPrLabel],
    ['post', '/api/config/pr-label', configRoutes.postPrLabel],
    ['get', '/api/config/ai-primary-tag', configRoutes.getAiPrimaryTag],
    ['post', '/api/config/ai-primary-tag', configRoutes.postAiPrimaryTag],
    ['get', '/api/config/primary-processing-labels', configRoutes.getPrimaryProcessingLabels],
    ['post', '/api/config/primary-processing-labels', configRoutes.postPrimaryProcessingLabels],
    ['get', '/api/config/agents', configRoutes.getAgents],
    ['post', '/api/config/agents', configRoutes.postAgents],
    ['get', '/api/config/summarization', configRoutes.getSummarizationSettings],
    ['post', '/api/config/summarization', configRoutes.postSummarizationSettings],
    ['get', '/api/config/repos/indexing-status', configRoutes.getRepositoriesIndexingStatus],
    ['post', '/api/config/repos/trigger-indexing', configRoutes.triggerIndexing],
    ['post', '/api/config/repos/stop-indexing', configRoutes.stopIndexing],
    ['post', '/api/config/summarization/reindex-all', configRoutes.triggerReindexAll],
    ['get', '/api/config/agent-tank', configRoutes.getAgentTankSettings],
    ['post', '/api/config/agent-tank', configRoutes.postAgentTankSettings],
    ['get', '/api/config/agent-tank/status', configRoutes.getAgentTankStatus],
    ['get', '/api/config/agent-tank/usage', configRoutes.getAgentTankUsage],
    ['post', '/api/config/agent-tank/refresh', configRoutes.postAgentTankRefresh],
    ['get', '/api/config/agent-tank/detect', configRoutes.getAgentTankDetect],
    ['get', '/api/queue/stats', queueRoutes.getQueueStats],
    ['get', '/api/activity', queueRoutes.getActivity],
    ['get', '/api/metrics', queueRoutes.getMetrics],
    ['get', '/api/llm-metrics', llmMetricsRoutes.getSummary],
    ['get', '/api/llm-metrics/:correlationId', llmMetricsRoutes.getByCorrelationId],
    ['get', '/api/llm-logs', llmLogsRoutes.getLlmLogs],
    ['get', '/api/execution/:sessionId/prompt', executionRoutes.getPrompt],
    ['get', '/api/execution/:sessionId/logs', executionRoutes.getLogs],
    ['get', '/api/execution/:sessionId/logs/:type', executionRoutes.getLogByType],
    ['get', '/api/task/:taskId/analysis', executionRoutes.getAnalysis],
    ['get', '/api/task/:taskId/docker-info', dockerRoutes.getDockerInfo],
    ['get', '/api/task/:taskId/docker-logs', dockerRoutes.getDockerLogs],
    ['post', '/api/task/:taskId/stop', dockerRoutes.stopTask],
    ['post', '/api/import-tasks', githubRoutes.importTasks],
    ['get', '/api/github/repos', githubRoutes.getRepos],
    ['get', '/api/github/repos/:owner/:repo/branches', githubRoutes.getBranches],
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
    ['post', '/api/planner/drafts/:id/implement-all', plannerRoutes.implementAllIssues],
    ['post', '/api/planner/context/stats', plannerRoutes.getContextStats],
    ['post', '/api/planner/preview', plannerRoutes.previewContext],
    ['post', '/api/planner/preview/context', plannerRoutes.downloadContext],
    ['post', '/api/planner/generate', plannerRoutes.generate],
    ['post', '/api/planner/abort', plannerRoutes.abortGeneration],
    ['post', '/api/planner/refine', plannerRoutes.refine],
    ['post', '/api/planner/abort-refinement', plannerRoutes.abortRefinement],
    ['post', '/api/planner/finalize', plannerRoutes.finalize],
    ['post', '/api/planner/drafts/:id/reset-to-setup', plannerRoutes.resetDraftToSetup],
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
    ['get', '/api/summaries/:owner/:repo/status', summaryBrowserRoutes.getIndexingStatus],
    ['get', '/api/summaries/:owner/:repo/tree', summaryBrowserRoutes.getDirectoryTree],
    ['get', '/api/summaries/:owner/:repo/tree/*', summaryBrowserRoutes.getDirectoryTree],
    ['get', '/api/summaries/:owner/:repo/summary/*', summaryBrowserRoutes.getPathSummary],
    ['post', '/api/repos/chat', repoChatRoutes.postChat],
    ['get', '/api/repos/chat/messages', repoChatRoutes.getMessages],
    ['post', '/api/repos/chat/messages', repoChatRoutes.saveMessages],
    ['delete', '/api/repos/chat/messages/:messageId', repoChatRoutes.deleteMessage],
    ['delete', '/api/repos/chat/messages', repoChatRoutes.clearMessages],
    ['post', '/api/repos/improvements', repoImprovementsRoutes.postImprovements],
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
  ];
  routes.forEach(([method, path, ...handlers]) => register(method, path, ...handlers));

  app.use('/api/agents', agentRoutes.router);
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

  setupWebhookRoute();
}

function setupWebhookRoute(): void {
  if (process.env.ENABLE_GITHUB_WEBHOOKS !== 'true') {
    console.log('[webhook] Webhook endpoint disabled (ENABLE_GITHUB_WEBHOOKS not set to true)');
    return;
  }
  if (!process.env.GH_WEBHOOK_SECRET) {
    throw new Error('[webhook] ENABLE_GITHUB_WEBHOOKS is true but GH_WEBHOOK_SECRET is not set. Refusing to start — all webhook traffic would be rejected. Set GH_WEBHOOK_SECRET in the environment.');
  }
  app.post('/webhook', async (req: Request, res: Response) => {
    const correlationId = generateCorrelationId();
    try {
      await handleWebhookRequest(req, res, {
        webhookSecret: process.env.GH_WEBHOOK_SECRET,
        redis: { set: (key, value, opts) => opts
          ? redisClient.set(key, value, { ...(opts.NX ? { NX: true as const } : {}), ...(opts.EX != null ? { EX: opts.EX } : {}) }) as Promise<string | null>
          : redisClient.set(key, value) as Promise<string | null> },
        processor: (payload, event, cid, deliveryId) => processWebhookEvent(payload, event as WebhookEventType, cid, deliveryId),
        correlationId,
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
    await initRedis();
    setupRoutes();
    const socketService = initSocketService(httpServer, validateCorsOrigin);
    console.log('[WebSocket] Socket.IO server initialized');
    socketService.initQueueFeatures({ taskQueue, redisClient, db });
    console.log('[WebSocket] Queue features initialized for real-time updates');
    try { await configManager.ensureConfigRepoExists(); } catch (error) { console.warn('Failed to initialize config:', (error as Error).message); }
    try { await loadSettingsFromConfig(); } catch (error) { console.warn('Failed to load settings from config repo:', (error as Error).message); }
    await initializeUltrafix(ioRedisClient);
    try { await initializeWebhookHandler({ issueProcessor: processDetectedIssue, commentProcessor: processCommentEventWrapper, commentDeletedHandler: handleCommentDeletedWrapper, commentEditedHandler: handleCommentEditedWrapper }); console.log('[webhook] Webhook handler initialized'); } catch (error) { console.error('[webhook] Failed to initialize webhook handler:', (error as Error).message); }
    httpServer.listen(PORT, () => { console.log(`Dashboard API server running on port ${PORT} (with WebSocket support)`); });
    setInterval(async () => {
      try {
        await checkAndExecuteDelayedReindex(redisClient as RedisClientType);
      } catch (error) {
        console.error('Error checking for delayed reindex:', error);
      }
    }, 30 * 1000);

    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      await closeUltrafixStateRedis();
      await closeSocketService();
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
