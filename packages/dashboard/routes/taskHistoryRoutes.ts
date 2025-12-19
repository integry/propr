import { Request, Response } from 'express';
import { RedisClientType } from 'redis';
import { Queue, Job } from 'bullmq';
import { Knex } from 'knex';

interface JobData {
    repoOwner?: string;
    repoName?: string;
    number?: number;
    pullRequestNumber?: number;
    title?: string;
    subtitle?: string;
    comments?: unknown[];
    modelName?: string;
}

interface JobReturnValue {
    issueTitle?: string;
    modelName?: string;
    claudeResult?: {
        sessionId: string;
        conversationId?: string;
        executionTime?: number;
        success?: boolean;
        conversationLog?: unknown[];
        model?: string;
    };
    postProcessing?: {
        success?: boolean;
        pr?: {
            number: number;
            url: string;
        };
    };
}

interface TaskHistoryRoutesDeps {
  redisClient: RedisClientType;
  taskQueue: Queue;
  db: Knex;
}

export function createTaskHistoryRoutes(deps: TaskHistoryRoutesDeps) {
  const { redisClient, taskQueue, db } = deps;

  async function getTaskHistory(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;

      let history: Array<Record<string, unknown>> = [];
      let taskInfo: Record<string, unknown> | null = null;

      const dbResult = await getHistoryFromDb(db, taskId);
      if (dbResult) {
        res.json({ taskId, history: dbResult.history, taskInfo: dbResult.taskInfo });
        return;
      }
      console.log(`Task ${taskId} not found in SQLite, falling back to Redis`);

      const redisResult = await getHistoryFromRedis(redisClient, taskId);
      if (redisResult) {
        history = redisResult.history;
        taskInfo = redisResult.taskInfo;
      }

      if (history.length === 0 && taskQueue) {
        const queueResult = await getHistoryFromQueue(taskQueue, taskId);
        if (queueResult) {
          if (!taskInfo) taskInfo = queueResult.taskInfo;
          history = queueResult.history;
        }
      }

      res.json({ taskId, history, taskInfo });
    } catch (error) {
      console.error('Error in /api/task/:taskId/history:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  return { getTaskHistory };
}

async function getHistoryFromDb(
  db: Knex,
  taskId: string
): Promise<{ history: Array<Record<string, unknown>>; taskInfo: Record<string, unknown> } | null> {
  try {
    console.log(`Fetching task history from SQLite for taskId: ${taskId}`);
    const task = await db('tasks').where({ task_id: taskId }).first();
    const historyRecords = await db('task_history')
      .where({ task_id: taskId })
      .orderBy('timestamp', 'asc');
    
    if (!task || historyRecords.length === 0) {
      return null;
    }

    const [repoOwner, repoName] = (task.repository as string).split('/');
    const { title, subtitle, pullRequestNumber, issueNumber } = parseJobData(task.initial_job_data);

    // Determine task type: check task_type from DB, but also verify using taskId prefix
    // and pullRequestNumber from job data to correctly identify PR tasks
    const isPr = task.task_type === 'pr-comment' ||
                 taskId.startsWith('pr-comments-batch-') ||
                 !!pullRequestNumber;

    const taskInfo: Record<string, unknown> = {
      repoOwner,
      repoName,
      number: task.issue_number,
      type: isPr ? 'pr-comment' : (task.task_type || 'issue'),
      correlationId: task.correlation_id,
      title,
      subtitle,
      modelName: task.model_name
    };

    // Include issueNumber for PR tasks if available (the original issue that the PR addresses)
    if (isPr && issueNumber) {
      taskInfo.issueNumber = issueNumber;
    }
    
    const llmExecutions = await db('llm_executions')
      .where({ task_id: taskId })
      .orderBy('start_time', 'asc');
    
    const executionsByHistoryId = new Map<number, Record<string, unknown>>();
    llmExecutions.forEach((exec: Record<string, unknown>) => {
      if (exec.history_id) {
        executionsByHistoryId.set(exec.history_id as number, exec);
      }
    });
    
    const history = historyRecords.map((record: Record<string, unknown>) => 
      mapDbHistoryRecord(record, executionsByHistoryId)
    );
    
    console.log(`Fetched ${history.length} history records from SQLite for task ${taskId}`);
    return { history, taskInfo };
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

function parseJobData(initialJobData: unknown): { title: string | null; subtitle: string | null; pullRequestNumber: number | null; issueNumber: number | null } {
  let title = null;
  let subtitle = null;
  let pullRequestNumber = null;
  let issueNumber = null;
  if (initialJobData) {
    try {
      const jobData = typeof initialJobData === 'string' ? JSON.parse(initialJobData) : initialJobData;
      title = jobData.title || (jobData.issueRef ? jobData.issueRef.title : null) || null;
      subtitle = jobData.subtitle || null;
      pullRequestNumber = jobData.pullRequestNumber || (jobData.issueRef ? jobData.issueRef.pullRequestNumber : null) || null;
      issueNumber = jobData.issueNumber || (jobData.issueRef ? jobData.issueRef.issueNumber : null) || null;
      if (!title && jobData.issueRef) title = jobData.issueRef.title;

      // Try to extract issue number from title if it contains "Closes #XXX" pattern
      if (!issueNumber && title) {
        issueNumber = extractIssueNumberFromTitle(title);
      }
    } catch (e) {
      console.error('Failed to parse initial_job_data', e);
    }
  }
  return { title, subtitle, pullRequestNumber, issueNumber };
}

function mapDbHistoryRecord(
  record: Record<string, unknown>,
  executionsByHistoryId: Map<number, Record<string, unknown>>
): Record<string, unknown> {
  const historyItem: Record<string, unknown> = {
    state: record.state,
    timestamp: record.timestamp,
    reason: record.reason
  };
  
  let metadata: Record<string, unknown> | null = null;
  if (record.metadata) {
    metadata = typeof record.metadata === 'string' 
      ? JSON.parse(record.metadata) 
      : record.metadata as Record<string, unknown>;
  }
  
  const execution = executionsByHistoryId.get(record.history_id as number);
  if (execution) {
    metadata = enrichMetadataWithExecution(metadata || {}, execution);
    if (execution.session_id) {
      historyItem.promptPath = `/api/execution/${execution.session_id}/prompt`;
      historyItem.logsPath = `/api/execution/${execution.session_id}/logs`;
    }
  } else if (metadata && metadata.sessionId) {
    historyItem.promptPath = `/api/execution/${metadata.sessionId}/prompt`;
    historyItem.logsPath = `/api/execution/${metadata.sessionId}/logs`;
  }
  
  if (metadata) {
    historyItem.metadata = metadata;
  }
  
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
    conversationTurns: execution.num_turns
  };
}

async function getHistoryFromRedis(
  redisClient: RedisClientType,
  taskId: string
): Promise<{ history: Array<Record<string, unknown>>; taskInfo: Record<string, unknown> | null } | null> {
  const stateKey = `worker:state:${taskId}`;
  const stateData = await redisClient.get(stateKey);
  
  if (!stateData) return null;

  try {
    const state = JSON.parse(stateData) as { history?: Array<Record<string, unknown>>; issueRef?: Record<string, unknown> };
    const history = (state.history || []).map(item => {
      const enrichedItem = { ...item };
      if ((item.metadata as Record<string, unknown>)?.sessionId) {
        enrichedItem.promptPath = `/api/execution/${(item.metadata as Record<string, unknown>).sessionId}/prompt`;
        enrichedItem.logsPath = `/api/execution/${(item.metadata as Record<string, unknown>).sessionId}/logs`;
      }
      return enrichedItem;
    });
    
    let taskInfo: Record<string, unknown> | null = null;
    if (state.issueRef) {
      // Check for pullRequestNumber in state.issueRef to correctly detect PR tasks
      const isPr = taskId.startsWith('pr-comments-batch-') ||
                   !!(state.issueRef as Record<string, unknown>).pullRequestNumber;
      taskInfo = {
        repoOwner: state.issueRef.repoOwner,
        repoName: state.issueRef.repoName,
        number: state.issueRef.number,
        type: isPr ? 'pr-comment' : 'issue',
        comments: state.issueRef.comments,
        title: state.issueRef.title || null,
        subtitle: state.issueRef.subtitle || null,
        modelName: state.issueRef.modelName
      };

      // Include issueNumber for PR tasks if available (the original issue that the PR addresses)
      if (isPr) {
        const issueNumber = (state.issueRef as Record<string, unknown>).issueNumber as number | null | undefined
          || extractIssueNumberFromTitle(state.issueRef.title as string | null | undefined);
        if (issueNumber) {
          taskInfo.issueNumber = issueNumber;
        }
      }
    }
    
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
  // Check for pullRequestNumber in job.data to correctly detect PR tasks
  const isPr = taskId.startsWith('pr-comments-batch-') || !!job.data.pullRequestNumber;
  const taskInfo: Record<string, unknown> = {
    repoOwner: job.data.repoOwner,
    repoName: job.data.repoName,
    number: job.data.pullRequestNumber || job.data.number,
    type: isPr ? 'pr-comment' : 'issue',
    comments: job.data.comments,
    title: job.data.title || null,
    subtitle: job.data.subtitle || null,
    modelName: job.data?.modelName
  };

  // Include issueNumber for PR tasks if available (the original issue that the PR addresses)
  if (isPr) {
    const issueNumber = (job.data as Record<string, unknown>).issueNumber as number | null | undefined
      || extractIssueNumberFromTitle(job.data.title);
    if (issueNumber) {
      taskInfo.issueNumber = issueNumber;
    }
  }

  return taskInfo;
}

function buildHistoryFromJob(job: Job<JobData, JobReturnValue>): Array<Record<string, unknown>> {
  const history: Array<Record<string, unknown>> = [];
  
  history.push({
    state: 'PENDING',
    timestamp: new Date(job.timestamp).toISOString(),
    message: 'Task created and queued'
  });
  
  if (job.processedOn) {
    history.push({
      state: 'PROCESSING',
      timestamp: new Date(job.processedOn).toISOString(),
      message: 'Task processing started'
    });
  }
  
  if (job.returnvalue?.claudeResult) {
    addClaudeHistoryEntries(history, job);
  }
  
  if (job.returnvalue?.postProcessing) {
    addPostProcessingEntry(history, job);
  }
  
  if (job.finishedOn) {
    addCompletionEntry(history, job);
  }
  
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
