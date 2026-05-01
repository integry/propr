import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue, Job } from 'bullmq';
import { Knex } from 'knex';

interface JobData {
    repoOwner?: string; repoName?: string; number?: number;
    pullRequestNumber?: number; title?: string; subtitle?: string;
    comments?: unknown[]; modelName?: string;
}

interface JobReturnValue {
    issueTitle?: string; modelName?: string;
    claudeResult?: {
        sessionId: string; conversationId?: string; executionTime?: number;
        success?: boolean; conversationLog?: unknown[]; model?: string;
    };
    postProcessing?: {
        success?: boolean;
        pr?: { number: number; url: string };
    };
}

interface TaskHistoryRoutesDeps { redisClient: RedisClientType; taskQueue: Queue; db: Knex }

export function createTaskHistoryRoutes(deps: TaskHistoryRoutesDeps) {
  const { redisClient, taskQueue, db } = deps;

  async function getTaskHistory(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;

      const dbResult = await getHistoryFromDb(db, taskId);
      if (dbResult) {
        res.json({
          taskId,
          history: dbResult.history,
          taskInfo: dbResult.taskInfo,
          usageMetrics: dbResult.usageMetrics,
          usageMetricRecords: dbResult.usageMetricRecords
        });
        return;
      }
      console.log(`Task ${taskId} not found in SQLite, falling back to Redis`);
      let history: Array<Record<string, unknown>> = [];
      let taskInfo: Record<string, unknown> | null = null;
      const redisResult = await getHistoryFromRedis(redisClient, taskId);
      if (redisResult) { history = redisResult.history; taskInfo = redisResult.taskInfo; }
      if (history.length === 0 && taskQueue) {
        const queueResult = await getHistoryFromQueue(taskQueue, taskId);
        if (queueResult) { if (!taskInfo) taskInfo = queueResult.taskInfo; history = queueResult.history; }
      }
      res.json({ taskId, history, taskInfo });
    } catch (error) {
      console.error('Error in /api/task/:taskId/history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getTaskHistory };
}

function buildTaskInfoFromDb(
  taskId: string,
  task: Record<string, unknown>,
  jobData: ReturnType<typeof parseJobData>
): Record<string, unknown> {
  const [repoOwner, repoName] = (task.repository as string).split('/');
  const { title, subtitle, pullRequestNumber, issueNumber, commandMode, hasUltrafixMeta } = jobData;
  const isPr = task.task_type === 'pr-comment' || taskId.startsWith('pr-comments-batch-') || !!pullRequestNumber;

  const taskInfo: Record<string, unknown> = {
    repoOwner,
    repoName,
    number: (isPr && pullRequestNumber) || task.issue_number,
    type: isPr ? 'pr-comment' : (task.task_type || 'issue'),
    correlationId: task.correlation_id,
    title,
    subtitle,
    modelName: task.model_name
  };

  if (isPr && issueNumber) taskInfo.issueNumber = issueNumber;
  if (commandMode) taskInfo.commandMode = commandMode;
  if (hasUltrafixMeta) taskInfo.ultrafixCycle = true;
  return taskInfo;
}

async function fetchUsageMetrics(
  db: Knex,
  taskId: string
): Promise<{ usageMetrics: Record<string, unknown> | null; usageMetricRecords: Array<{ agent: string; metricKey: string; metricValue: number }> }> {
  const llmLog = await db('llm_logs')
    .where({ draft_id: taskId, execution_type: 'implementation' }).orderBy('start_time', 'desc').first();
  console.log(`[taskHistory] Fetching usage metrics for taskId: ${taskId}, llmLog found: ${!!llmLog}, has usage_metrics: ${!!llmLog?.usage_metrics}`);

  if (!llmLog) return { usageMetrics: null, usageMetricRecords: [] };

  let usageMetrics: Record<string, unknown> | null = null;
  if (llmLog.usage_metrics) {
    try {
      usageMetrics = typeof llmLog.usage_metrics === 'string' ? JSON.parse(llmLog.usage_metrics) : llmLog.usage_metrics;
    } catch (e) { console.error('Failed to parse usage_metrics:', e); }
  }
  const records = await db('usage_metric_records').where({ llm_log_id: llmLog.log_id });
  const usageMetricRecords = records.map((r: Record<string, unknown>) => ({
    agent: r.agent_name as string, metricKey: r.metric_key as string, metricValue: r.metric_value as number
  }));
  return { usageMetrics, usageMetricRecords };
}

async function getHistoryFromDb(
  db: Knex,
  taskId: string
): Promise<{
  history: Array<Record<string, unknown>>;
  taskInfo: Record<string, unknown>;
  usageMetrics: Record<string, unknown> | null;
  usageMetricRecords: Array<{ agent: string; metricKey: string; metricValue: number }>;
} | null> {
  try {
    console.log(`Fetching task history from SQLite for taskId: ${taskId}`);
    const task = await db('tasks').where({ task_id: taskId }).first();
    const historyRecords = await db('task_history').where({ task_id: taskId }).orderBy('timestamp', 'asc');
    if (!task || historyRecords.length === 0) return null;

    const taskInfo = buildTaskInfoFromDb(taskId, task, parseJobData(task.initial_job_data));

    const [llmExecutions, usage] = await Promise.all([
      db('llm_executions').where({ task_id: taskId }).orderBy('start_time', 'asc'),
      fetchUsageMetrics(db, taskId),
    ]);

    const executionsByHistoryId = new Map<number, Record<string, unknown>>();
    const executionsBySessionId = new Map<string, Record<string, unknown>>();
    llmExecutions.forEach((exec: Record<string, unknown>) => {
      if (exec.history_id) executionsByHistoryId.set(exec.history_id as number, exec);
      if (exec.session_id) executionsBySessionId.set(exec.session_id as string, exec);
    });
    const history = historyRecords.map((record: Record<string, unknown>) =>
      mapDbHistoryRecord(record, executionsByHistoryId, executionsBySessionId)
    );

    applyMetadataFlags(taskInfo, history);

    console.log(`Fetched ${history.length} history records from SQLite for task ${taskId}`);
    return { history, taskInfo, ...usage };
  } catch (error) {
    console.error('Error fetching task history from SQLite:', error);
    console.log('Falling back to Redis for task history...');
    return null;
  }
}

function extractIssueNumberFromTitle(title: string | null | undefined): number | null {
  if (!title) return null;
  const issueMatch = title.match(/(?:closes|fixes|resolves|addresses)\s+#(\d+)/i);
  return issueMatch ? parseInt(issueMatch[1], 10) : null;
}

function parseJobData(initialJobData: unknown): { title: string | null; subtitle: string | null; pullRequestNumber: number | null; issueNumber: number | null; commandMode: string | null; hasUltrafixMeta: boolean } {
  let title = null, subtitle = null, pullRequestNumber = null, issueNumber = null, commandMode = null;
  let hasUltrafixMeta = false;
  if (initialJobData) {
    try {
      const jobData = typeof initialJobData === 'string' ? JSON.parse(initialJobData) : initialJobData;
      const ref = jobData.issueRef;
      title = jobData.title || ref?.title || null;
      subtitle = jobData.subtitle || null;
      pullRequestNumber = jobData.pullRequestNumber || ref?.pullRequestNumber || null;
      issueNumber = jobData.issueNumber || ref?.issueNumber || null;
      commandMode = jobData.commandMode || null;
      hasUltrafixMeta = !!jobData.ultrafixMeta;
      if (!title && ref) title = ref.title;
      if (!issueNumber && title) issueNumber = extractIssueNumberFromTitle(title);
    } catch (e) { console.error('Failed to parse initial_job_data', e); }
  }
  return { title, subtitle, pullRequestNumber, issueNumber, commandMode, hasUltrafixMeta };
}

function mapDbHistoryRecord(
  record: Record<string, unknown>,
  executionsByHistoryId: Map<number, Record<string, unknown>>,
  executionsBySessionId: Map<string, Record<string, unknown>>
): Record<string, unknown> {
  const historyItem: Record<string, unknown> = {
    state: record.state,
    timestamp: record.timestamp,
    reason: record.reason
  };

  let metadata: Record<string, unknown> | null = record.metadata
    ? (typeof record.metadata === 'string' ? JSON.parse(record.metadata) : record.metadata as Record<string, unknown>)
    : null;

  let execution = executionsByHistoryId.get(record.history_id as number);
  if (!execution && metadata?.sessionId) execution = executionsBySessionId.get(metadata.sessionId as string);

  if (execution) {
    metadata = enrichMetadataWithExecution(metadata || {}, execution);
    if (execution.session_id) {
      historyItem.promptPath = `/api/execution/${execution.session_id}/prompt`;
      historyItem.logsPath = `/api/execution/${execution.session_id}/logs`;
    }
  } else if (metadata?.sessionId) {
    historyItem.promptPath = `/api/execution/${metadata.sessionId}/prompt`;
    historyItem.logsPath = `/api/execution/${metadata.sessionId}/logs`;
  }
  if (metadata) historyItem.metadata = metadata;
  return historyItem;
}

function enrichMetadataWithExecution(
  metadata: Record<string, unknown>,
  execution: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...metadata,
    sessionId: execution.session_id,
    conversationId: execution.conversation_id,
    model: execution.model_name,
    duration: execution.duration_ms,
    success: execution.success,
    conversationTurns: execution.num_turns,
    tokenUsage: {
      input_tokens: execution.input_tokens ?? null,
      output_tokens: execution.output_tokens ?? null,
      cache_creation_input_tokens: execution.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: execution.cache_read_input_tokens ?? null
    }
  };
}

// Search from the end to find the latest/current metadata value rather than the earliest.
// This matters for ultrafix flows that alternate review/fix states.
function findLatestMetadata(
  historyEntries: Array<Record<string, unknown>>
): { commandModeMeta?: Record<string, unknown>; ultrafixCycleMeta?: Record<string, unknown> } {
  let commandModeMeta: Record<string, unknown> | undefined;
  let ultrafixCycleMeta: Record<string, unknown> | undefined;
  for (let i = historyEntries.length - 1; i >= 0; i--) {
    const h = historyEntries[i];
    if (!h.metadata || typeof h.metadata !== 'object') continue;
    const meta = h.metadata as Record<string, unknown>;
    if (!commandModeMeta && 'commandMode' in meta) commandModeMeta = meta;
    if (!ultrafixCycleMeta && 'ultrafixCycle' in meta) ultrafixCycleMeta = meta;
    if (commandModeMeta && ultrafixCycleMeta) break;
  }
  return { commandModeMeta, ultrafixCycleMeta };
}

function resolveIssueNumber(ref: Record<string, unknown>): number | null {
  const direct = ref.issueNumber as number | null | undefined;
  if (direct) return direct;
  return extractIssueNumberFromTitle(ref.title as string | null | undefined);
}

function resolveTaskTypeAndIssue(
  taskId: string,
  ref: Record<string, unknown>
): { type: string; issueNumber?: number } {
  const isPr = taskId.startsWith('pr-comments-batch-') || !!ref.pullRequestNumber;
  if (!isPr) return { type: 'issue' };
  const issueNumber = resolveIssueNumber(ref) ?? undefined;
  return { type: 'pr-comment', issueNumber };
}

function applyMetadataFlags(
  taskInfo: Record<string, unknown>,
  historyEntries: Array<Record<string, unknown>>
): void {
  const { commandModeMeta, ultrafixCycleMeta } = findLatestMetadata(historyEntries);
  if (commandModeMeta?.commandMode) taskInfo.commandMode = commandModeMeta.commandMode;
  if (commandModeMeta?.ultrafixCycle === true || ultrafixCycleMeta?.ultrafixCycle === true) {
    taskInfo.ultrafixCycle = true;
  }
}

function buildTaskInfoFromState(
  taskId: string,
  ref: Record<string, unknown>,
  historyEntries: Array<Record<string, unknown>>
): Record<string, unknown> {
  const { type, issueNumber } = resolveTaskTypeAndIssue(taskId, ref);
  const taskInfo: Record<string, unknown> = {
    repoOwner: ref.repoOwner, repoName: ref.repoName, number: ref.number,
    type, comments: ref.comments,
    title: ref.title || null, subtitle: ref.subtitle || null, modelName: ref.modelName
  };
  if (issueNumber) taskInfo.issueNumber = issueNumber;
  applyMetadataFlags(taskInfo, historyEntries);
  return taskInfo;
}

function enrichRedisHistoryItem(item: Record<string, unknown>): Record<string, unknown> {
  const enrichedItem = { ...item };
  const metadata = item.metadata as Record<string, unknown> | undefined;
  if (metadata?.sessionId) {
    enrichedItem.promptPath = `/api/execution/${metadata.sessionId}/prompt`;
    enrichedItem.logsPath = `/api/execution/${metadata.sessionId}/logs`;
  }
  return enrichedItem;
}

async function getHistoryFromRedis(
  redisClient: RedisClientType,
  taskId: string
): Promise<{ history: Array<Record<string, unknown>>; taskInfo: Record<string, unknown> | null } | null> {
  const stateData = await redisClient.get(`worker:state:${taskId}`);
  if (!stateData) return null;
  try {
    const state = JSON.parse(stateData) as { history?: Array<Record<string, unknown>>; issueRef?: Record<string, unknown> };
    const history = (state.history || []).map(enrichRedisHistoryItem);
    const taskInfo = state.issueRef
      ? buildTaskInfoFromState(taskId, state.issueRef as Record<string, unknown>, state.history || [])
      : null;
    return { history, taskInfo };
  } catch (e) {
    console.error('Error parsing state data:', e);
    return null;
  }
}

async function getHistoryFromQueue(
  taskQueue: Queue,
  taskId: string
): Promise<{ history: Array<Record<string, unknown>>; taskInfo: Record<string, unknown> | null } | null> {
  try {
    const job = await taskQueue.getJob(taskId) as Job<JobData, JobReturnValue> | undefined;
    if (!job) return null;

    const taskInfo = buildTaskInfoFromJob(job, taskId);
    const history = buildHistoryFromJob(job);

    return { history, taskInfo };
  } catch (e) {
    console.error('Error getting job data:', e);
    return null;
  }
}

function buildTaskInfoFromJob(job: Job<JobData, JobReturnValue>, taskId: string): Record<string, unknown> | null {
  if (!job.data?.repoOwner || !job.data?.repoName) return null;
  const isPr = taskId.startsWith('pr-comments-batch-') || !!job.data.pullRequestNumber;
  const taskInfo: Record<string, unknown> = {
    repoOwner: job.data.repoOwner, repoName: job.data.repoName,
    number: job.data.pullRequestNumber || job.data.number,
    type: isPr ? 'pr-comment' : 'issue', comments: job.data.comments,
    title: job.data.title || null, subtitle: job.data.subtitle || null, modelName: job.data?.modelName
  };
  if (isPr) {
    const issueNumber = (job.data as Record<string, unknown>).issueNumber as number | null | undefined
      || extractIssueNumberFromTitle(job.data.title);
    if (issueNumber) taskInfo.issueNumber = issueNumber;
  }
  const jobDataRecord = job.data as Record<string, unknown>;
  if (jobDataRecord.commandMode) {
    taskInfo.commandMode = jobDataRecord.commandMode;
  }
  if (jobDataRecord.ultrafixMeta) {
    taskInfo.ultrafixCycle = true;
  }
  return taskInfo;
}

function buildHistoryFromJob(job: Job<JobData, JobReturnValue>): Array<Record<string, unknown>> {
  const history: Array<Record<string, unknown>> = [];
  history.push({ state: 'PENDING', timestamp: new Date(job.timestamp).toISOString(), message: 'Task created and queued' });
  if (job.processedOn) {
    history.push({ state: 'PROCESSING', timestamp: new Date(job.processedOn).toISOString(), message: 'Task processing started' });
  }
  if (job.returnvalue?.claudeResult) addClaudeHistoryEntries(history, job);
  if (job.returnvalue?.postProcessing) addPostProcessingEntry(history, job);
  if (job.finishedOn) addCompletionEntry(history, job);
  return history;
}

function addClaudeHistoryEntries(history: Array<Record<string, unknown>>, job: Job<JobData, JobReturnValue>): void {
  const claudeResult = job.returnvalue!.claudeResult!;
  const claudeStartTime = job.processedOn ? new Date(job.processedOn).getTime() : job.timestamp;

  history.push({
    state: 'CLAUDE_EXECUTION',
    timestamp: new Date(claudeStartTime + 1000).toISOString(),
    message: `Claude AI processing started with model: ${job.returnvalue!.modelName || 'claude'}`,
    promptPath: `/api/execution/${claudeResult.sessionId}/prompt`,
    logsPath: `/api/execution/${claudeResult.sessionId}/logs`,
    metadata: {
      model: job.returnvalue!.modelName,
      sessionId: claudeResult.sessionId,
      conversationId: claudeResult.conversationId
    }
  });

  if (claudeResult.executionTime) {
    const claudeEndTime = claudeStartTime + claudeResult.executionTime;
    history.push({
      state: 'CLAUDE_COMPLETED',
      timestamp: new Date(claudeEndTime).toISOString(),
      message: claudeResult.success ? 'Claude execution completed successfully' : 'Claude execution failed',
      promptPath: `/api/execution/${claudeResult.sessionId}/prompt`,
      logsPath: `/api/execution/${claudeResult.sessionId}/logs`,
      metadata: {
        duration: claudeResult.executionTime,
        success: claudeResult.success,
        conversationTurns: claudeResult.conversationLog?.length || 0,
        sessionId: claudeResult.sessionId,
        conversationId: claudeResult.conversationId,
        model: claudeResult.model
      }
    });
  }
}

function addPostProcessingEntry(history: Array<Record<string, unknown>>, job: Job<JobData, JobReturnValue>): void {
  const pp = job.returnvalue!.postProcessing!;
  history.push({
    state: 'POST_PROCESSING',
    timestamp: new Date((job.finishedOn || Date.now()) - 5000).toISOString(),
    message: pp.success ? 'Creating pull request' : 'Post-processing failed',
    metadata: pp.pr ? {
      pullRequest: {
        number: pp.pr.number,
        url: pp.pr.url
      }
    } : undefined
  });
}

function addCompletionEntry(history: Array<Record<string, unknown>>, job: Job<JobData, JobReturnValue>): void {
  history.push({
    state: job.failedReason ? 'FAILED' : 'COMPLETED',
    timestamp: new Date(job.finishedOn!).toISOString(),
    message: job.failedReason || 
            (job.returnvalue?.postProcessing?.pr ? 
              `Task completed successfully. PR #${job.returnvalue.postProcessing.pr.number} created` : 
              'Task completed successfully'),
    metadata: job.failedReason ? { error: job.failedReason } : undefined
  });
}
