import express, { Request, Response } from 'express';
import { createServer, Server as HttpServer } from 'http';
import cors from 'cors';
import crypto from 'crypto';
import { createClient, RedisClientType } from 'redis';
import { Queue } from 'bullmq';
import 'dotenv/config';
import { Redis } from 'ioredis';
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
import { checkAndExecuteDelayedReindex } from './routes/configHelpers.js';
import {
  generateCorrelationId,
  processWebhookEvent,
  initializeWebhookHandler,
  db,
  loadSettingsFromConfig,
  processDetectedIssue as processDetectedIssueBase,
  handleCommentDeleted,
  handleCommentEdited,
  processCommentEvent
} from '@propr/core';
import type { WebhookEventType, DetectedIssue, CommentPayload, CommentEventConfig, CommentEventType } from '@propr/core';
import * as configManager from '@propr/core';

const ioRedisClient = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

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
    url: `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}`
  });
  
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();
  
  const queueName = process.env.GITHUB_ISSUE_QUEUE_NAME || 'github-issue-processor';
  taskQueue = new Queue(queueName, {
    connection: {
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT || '6379', 10)
    }
  });
  
  console.log('Connected to Redis');
}

function setupRoutes(): void {
  // Apply authentication middleware globally to all /api routes
  // Note: /api/auth/* routes are set up before setupRoutes via setupAuth and remain accessible
  // The /webhook endpoint is set up separately and uses signature verification instead
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

  app.get('/api/status', statusRoutes.getStatus);
  app.get('/api/tasks', taskRoutes.getTasks);
  app.get('/api/tasks/revert-preview', taskRoutes.getRevertPreview);
  app.post('/api/tasks/revert', taskRoutes.revertChanges);
  app.post('/api/tasks/:taskId/followup', taskRoutes.postFollowup);
  app.delete('/api/tasks/:taskId', taskRoutes.deleteTask);
  app.get('/api/task/:taskId/history', taskHistoryRoutes.getTaskHistory);
  app.get('/api/task/:taskId/live-details', liveDetailsRoutes.getLiveDetails);
  app.get('/api/task/:taskId/file-changes', fileChangesRoutes.getFileChanges);

  app.get('/api/config/followup-keywords', configRoutes.getFollowupKeywords);
  app.post('/api/config/followup-keywords', configRoutes.postFollowupKeywords);
  app.get('/api/config/followup-ignore-keywords', configRoutes.getFollowupIgnoreKeywords);
  app.post('/api/config/followup-ignore-keywords', configRoutes.postFollowupIgnoreKeywords);
  app.get('/api/config/repos', configRoutes.getRepos);
  app.post('/api/config/repos', configRoutes.postRepos);
  app.get('/api/config/settings', configRoutes.getSettings);
  app.post('/api/config/settings', configRoutes.postSettings);
  app.get('/api/config/pr-label', configRoutes.getPrLabel);
  app.post('/api/config/pr-label', configRoutes.postPrLabel);
  app.get('/api/config/ai-primary-tag', configRoutes.getAiPrimaryTag);
  app.post('/api/config/ai-primary-tag', configRoutes.postAiPrimaryTag);
  app.get('/api/config/primary-processing-labels', configRoutes.getPrimaryProcessingLabels);
  app.post('/api/config/primary-processing-labels', configRoutes.postPrimaryProcessingLabels);
  app.get('/api/config/agents', configRoutes.getAgents);
  app.post('/api/config/agents', configRoutes.postAgents);
  app.get('/api/config/summarization', configRoutes.getSummarizationSettings);
  app.post('/api/config/summarization', configRoutes.postSummarizationSettings);
  app.get('/api/config/repos/indexing-status', configRoutes.getRepositoriesIndexingStatus);
  app.post('/api/config/repos/trigger-indexing', configRoutes.triggerIndexing);
  app.post('/api/config/repos/stop-indexing', configRoutes.stopIndexing);
  app.post('/api/config/summarization/reindex-all', configRoutes.triggerReindexAll);

  app.get('/api/config/agent-tank', configRoutes.getAgentTankSettings);
  app.post('/api/config/agent-tank', configRoutes.postAgentTankSettings);
  app.get('/api/config/agent-tank/status', configRoutes.getAgentTankStatus);
  app.get('/api/config/agent-tank/usage', configRoutes.getAgentTankUsage);
  app.post('/api/config/agent-tank/refresh', configRoutes.postAgentTankRefresh);
  app.get('/api/config/agent-tank/detect', configRoutes.getAgentTankDetect);

  app.get('/api/queue/stats', queueRoutes.getQueueStats);
  app.get('/api/activity', queueRoutes.getActivity);
  app.get('/api/metrics', queueRoutes.getMetrics);

  app.get('/api/llm-metrics', llmMetricsRoutes.getSummary);
  app.get('/api/llm-metrics/:correlationId', llmMetricsRoutes.getByCorrelationId);

  app.get('/api/llm-logs', llmLogsRoutes.getLlmLogs);

  app.get('/api/execution/:sessionId/prompt', executionRoutes.getPrompt);
  app.get('/api/execution/:sessionId/logs', executionRoutes.getLogs);
  app.get('/api/execution/:sessionId/logs/:type', executionRoutes.getLogByType);
  app.get('/api/task/:taskId/analysis', executionRoutes.getAnalysis);

  app.get('/api/task/:taskId/docker-info', dockerRoutes.getDockerInfo);
  app.get('/api/task/:taskId/docker-logs', dockerRoutes.getDockerLogs);
  app.post('/api/task/:taskId/stop', dockerRoutes.stopTask);

  app.post('/api/import-tasks', githubRoutes.importTasks);
  app.get('/api/github/repos', githubRoutes.getRepos);
  app.get('/api/github/repos/:owner/:repo/branches', githubRoutes.getBranches);

  app.get('/api/planner/drafts', plannerRoutes.listDrafts);
  app.get('/api/planner/drafts/repositories', plannerRoutes.listRepositories);
  app.post('/api/planner/drafts', plannerRoutes.createDraft);
  app.get('/api/planner/drafts/:id', plannerRoutes.getDraft);
  app.put('/api/planner/drafts/:id', plannerRoutes.updateDraft);
  app.delete('/api/planner/drafts/:id', plannerRoutes.deleteDraft);
  app.post('/api/planner/drafts/:id/attachments', attachmentUpload, plannerRoutes.uploadAttachment);
  app.get('/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.getAttachmentContent);
  app.delete('/api/planner/drafts/:id/attachments/:attachmentId', plannerRoutes.deleteAttachment);
  app.get('/api/planner/drafts/:id/repository-info', plannerRoutes.getRepositoryInfo);
  // Plan issue management endpoints
  app.get('/api/planner/drafts/:id/issues', plannerRoutes.getIssues);
  app.post('/api/planner/drafts/:id/issues/:issueNumber/implement', plannerRoutes.implementIssue);
  app.patch('/api/planner/drafts/:id/issues/:issueNumber', plannerRoutes.updateIssue);
  app.post('/api/planner/drafts/:id/implement-all', plannerRoutes.implementAllIssues);
  app.post('/api/planner/context/stats', plannerRoutes.getContextStats);
  app.post('/api/planner/preview', plannerRoutes.previewContext);
  app.post('/api/planner/preview/context', plannerRoutes.downloadContext);
  app.post('/api/planner/generate', plannerRoutes.generate);
  app.post('/api/planner/abort', plannerRoutes.abortGeneration);
  app.post('/api/planner/refine', plannerRoutes.refine);
  app.post('/api/planner/abort-refinement', plannerRoutes.abortRefinement);
  app.post('/api/planner/finalize', plannerRoutes.finalize);
  app.post('/api/planner/drafts/:id/reset-to-setup', plannerRoutes.resetDraftToSetup);
  app.post('/api/planner/drafts/:id/revise', plannerRoutes.reviseDraft);
  app.post('/api/planner/validate-context-repository', plannerRoutes.validateContextRepository);
  app.post('/api/planner/drafts/:id/pause', plannerRoutes.pauseDraftExecution);
  app.post('/api/planner/drafts/:id/resume', plannerRoutes.resumeDraftExecution);
  app.patch('/api/planner/drafts/:id/execution-settings', plannerRoutes.updateExecutionSettings);

  app.post('/api/planner/relevance', relevanceRoutes.analyzeRelevance);

  // Agent chat API routes
  app.use('/api/agents', agentRoutes.router);

  // Agent version management routes
  const agentVersionRoutes = createAgentVersionRoutes();
  app.get('/api/agents/versions/:agentType', agentVersionRoutes.getVersions);
  app.post('/api/agents/:agentId/build-image', agentVersionRoutes.buildImage);
  app.delete('/api/agents/:agentType/images/cleanup', agentVersionRoutes.cleanupImages);
  app.get('/api/agents/:agentType/images', agentVersionRoutes.listImages);
  app.post('/api/agents/resolve-version', agentVersionRoutes.resolveVersionEndpoint);
  app.get('/api/agents/:agentType/image-tag', agentVersionRoutes.getImageTag);

  // Stats routes
  app.get('/api/stats/tasks', statsRoutes.getTaskStats);
  app.get('/api/stats/repositories', statsRoutes.getRepositoryStats);
  app.get('/api/stats/overview', statsRoutes.getOverview);
  app.get('/api/stats/generating-plans', statsRoutes.getGeneratingPlansCount);
  // Summary browser routes for exploring repository file summaries
  app.get('/api/summaries/:owner/:repo/status', summaryBrowserRoutes.getIndexingStatus);
  app.get('/api/summaries/:owner/:repo/tree', summaryBrowserRoutes.getDirectoryTree);
  app.get('/api/summaries/:owner/:repo/tree/*', summaryBrowserRoutes.getDirectoryTree);
  app.get('/api/summaries/:owner/:repo/summary/*', summaryBrowserRoutes.getPathSummary);

  // Repository chat endpoints for LLM integration and message persistence
  app.post('/api/repos/chat', repoChatRoutes.postChat);
  app.get('/api/repos/chat/messages', repoChatRoutes.getMessages);
  app.post('/api/repos/chat/messages', repoChatRoutes.saveMessages);
  app.delete('/api/repos/chat/messages/:messageId', repoChatRoutes.deleteMessage);
  app.delete('/api/repos/chat/messages', repoChatRoutes.clearMessages);

  // Repository improvements endpoint for generating suggestions
  app.post('/api/repos/improvements', repoImprovementsRoutes.postImprovements);

  // Repository to-do endpoints for managing ideas, notes, and future tasks
  // Category endpoints
  app.get('/api/repos/todos/categories', repoTodoRoutes.getCategories);
  app.post('/api/repos/todos/categories', repoTodoRoutes.createCategory);
  app.put('/api/repos/todos/categories/:categoryId', repoTodoRoutes.updateCategory);
  app.delete('/api/repos/todos/categories/:categoryId', repoTodoRoutes.deleteCategory);
  app.post('/api/repos/todos/categories/reorder', repoTodoRoutes.reorderCategories);
  // Todo endpoints
  app.get('/api/repos/todos', repoTodoRoutes.getTodos);
  app.get('/api/repos/todos/:todoId', repoTodoRoutes.getTodo);
  app.post('/api/repos/todos', repoTodoRoutes.createTodo);
  app.put('/api/repos/todos/:todoId', repoTodoRoutes.updateTodo);
  app.delete('/api/repos/todos/:todoId', repoTodoRoutes.deleteTodo);
  app.post('/api/repos/todos/reorder', repoTodoRoutes.reorderTodos);

  // User-specific repository preferences endpoints
  app.get('/api/user/repo-preferences', userRepoPreferencesRoutes.getRepoPreferences);
  app.post('/api/user/repo-preferences', userRepoPreferencesRoutes.updateRepoPreferences);

  setupWebhookRoute();
}

// TTL for webhook delivery deduplication keys in Redis (seconds)
export const WEBHOOK_DELIVERY_TTL_SECONDS = 300;

/**
 * Core webhook request handler extracted for testability.
 * Validates signature, enforces delivery-ID deduplication via Redis, parses
 * the payload, and delegates to the provided processor function.
 *
 * All failure paths after the Redis reservation clean up the key so that
 * GitHub retries are not permanently blocked.
 */
export async function handleWebhookRequest(
  req: Request,
  res: Response,
  deps: {
    webhookSecret: string | undefined;
    redis: { set: (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => Promise<string | null>; del: (key: string) => Promise<number> };
    processor: (payload: Record<string, unknown>, event: string, correlationId: string) => Promise<void>;
    correlationId: string;
  },
): Promise<void> {
  const { webhookSecret, redis, processor, correlationId } = deps;

  // Signature verification
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (webhookSecret) {
    if (!signature) { console.error('[webhook] No signature provided'); res.status(401).send('No webhook signature provided.'); return; }
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(req.body);
    const computedSignature = `sha256=${hmac.digest('hex')}`;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) { console.error('[webhook] Signature mismatch'); res.status(401).send('Webhook signature mismatch.'); return; }
  } else {
    console.warn('[webhook] Webhook secret not configured. Skipping signature verification.');
  }

  // Replay protection: reject duplicate or missing delivery IDs
  const rawDeliveryId = req.headers['x-github-delivery'];
  if (Array.isArray(rawDeliveryId)) {
    console.warn('[webhook] Rejecting multi-valued x-github-delivery header');
    res.status(400).send('Invalid x-github-delivery header.');
    return;
  }
  if (!rawDeliveryId) {
    console.warn('[webhook] Missing x-github-delivery header');
    res.status(400).send('Missing x-github-delivery header.');
    return;
  }

  const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
  const isNew = await redis.set(deliveryKey, '1', { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
  if (!isNew) {
    console.warn(`[webhook] Duplicate delivery rejected: ${rawDeliveryId}`);
    res.status(409).send('Duplicate webhook delivery.');
    return;
  }

  // Everything after reservation is wrapped so that any failure (parse or
  // processing) cleans up the Redis key and allows GitHub to retry.
  try {
    const payload = JSON.parse(req.body.toString()) as { action?: string; repository?: { full_name?: string }; [key: string]: unknown };
    const event = req.headers['x-github-event'] as string;
    console.log(`[webhook] Event received: ${event}, action: ${payload.action}, repo: ${payload.repository?.full_name}, delivery: ${rawDeliveryId}`);
    await processor(payload, event, correlationId);
  } catch (err) {
    // Clean up Redis key so GitHub can retry this delivery
    await redis.del(deliveryKey).catch(() => {});
    throw err;
  }

  res.status(200).send('Webhook processed.');
}

function setupWebhookRoute(): void {
  if (process.env.ENABLE_GITHUB_WEBHOOKS !== 'true') {
    console.log('[webhook] Webhook endpoint disabled (ENABLE_GITHUB_WEBHOOKS not set to true)');
    return;
  }
  app.post('/webhook', async (req: Request, res: Response) => {
    const correlationId = generateCorrelationId();
    try {
      await handleWebhookRequest(req, res, {
        webhookSecret: process.env.GH_WEBHOOK_SECRET,
        redis: redisClient,
        processor: (payload, event, cid) => processWebhookEvent(payload, event as WebhookEventType, cid),
        correlationId,
      });
    } catch (error) {
      console.error('[webhook] Error processing webhook:', error);
      if (!res.headersSent) {
        res.status(500).send((error as Error).message);
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
    try {
      await db.migrate.latest();
      console.log('Database migrations completed successfully');
    } catch (error) {
      console.error('Database migration failed:', error);
    }
    await initRedis();
    setupRoutes();

    // Initialize Socket.IO with the HTTP server and shared CORS configuration
    const socketService = initSocketService(httpServer, validateCorsOrigin);
    console.log('[WebSocket] Socket.IO server initialized');

    // Initialize queue features for real-time broadcasting
    socketService.initQueueFeatures({
      taskQueue,
      redisClient,
      db
    });
    console.log('[WebSocket] Queue features initialized for real-time updates');

    try { await configManager.ensureConfigRepoExists(); } catch (error) { console.warn('Failed to initialize config:', (error as Error).message); }
    try { await loadSettingsFromConfig(); } catch (error) { console.warn('Failed to load settings from config repo:', (error as Error).message); }
    try { await initializeWebhookHandler({ issueProcessor: processDetectedIssue, commentProcessor: processCommentEventWrapper, commentDeletedHandler: handleCommentDeletedWrapper, commentEditedHandler: handleCommentEditedWrapper }); console.log('[webhook] Webhook handler initialized'); } catch (error) { console.error('[webhook] Failed to initialize webhook handler:', (error as Error).message); }

    // Use httpServer.listen instead of app.listen for Socket.IO support
    httpServer.listen(PORT, () => { console.log(`Dashboard API server running on port ${PORT} (with WebSocket support)`); });

    // Start background job to check for scheduled delayed reindex (every 30 seconds)
    setInterval(async () => {
      try {
        await checkAndExecuteDelayedReindex(redisClient as RedisClientType);
      } catch (error) {
        console.error('Error checking for delayed reindex:', error);
      }
    }, 30 * 1000);

    // Handle graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
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
