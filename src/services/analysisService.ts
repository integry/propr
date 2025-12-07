import { Redis } from 'ioredis';
import { db } from '../db/postgres.ts';
import { generateExecutionAnalysisPrompt } from '../claude/prompts/promptGenerator.ts';
import { runLightweightLLMAnalysis } from '../claude/claudeService.ts';
import logger from '../utils/logger.ts';
import fs from 'fs';
import { execa } from 'execa';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
});

interface PromptData {
  prompt?: string;
  issueRef?: IssueRef;
}

interface IssueRef {
  number: number;
  repoOwner: string;
  repoName: string;
}

interface Execution {
  execution_id: string;
  task_id: string;
}

interface Task {
  task_id: string;
  repository: string;
  issue_number: number;
}

interface TaskHistory {
  metadata: string | TaskHistoryMetadata;
  timestamp: string;
}

interface TaskHistoryMetadata {
  historyMetadata?: {
    commitResult?: {
      commitHash?: string;
    };
  };
  commitResult?: {
    commitHash?: string;
  };
  commitHash?: string;
  prResult?: {
    commitHash?: string;
  };
  githubComment?: {
    body?: string;
  };
}

interface ConversationLogEntry {
  type?: string;
  id?: string;
  name?: string;
  content?: string;
  tool_use_id?: string;
  is_error?: boolean;
  compacted?: boolean;
}

interface AnalysisReport {
  generatedAt: string;
  modelUsed: string;
  report: string;
}

interface GetExecutionAnalysisParams {
  executionId: string;
  sessionId: string;
  correlationId: string;
  model: string;
}

async function getCommitDiff(worktreePath: string, commitHash: string, correlationId: string): Promise<string | null> {
  const correlatedLogger = logger.withCorrelation(correlationId);
  try {
    await execa('git', ['config', '--global', '--add', 'safe.directory', worktreePath], {
      reject: false
    });

    const { stdout, stderr } = await execa('git', ['show', commitHash], {
      cwd: worktreePath,
      reject: false
    });

    if (stderr && !stdout) {
      correlatedLogger.warn({ worktreePath, commitHash, stderr }, `git show ${commitHash} reported errors.`);
    }

    if (!stdout) {
        correlatedLogger.warn({ worktreePath, commitHash }, `git show ${commitHash} produced no output.`);
        return null;
    }
    return stdout;
  } catch (error) {
    correlatedLogger.error({ worktreePath, commitHash, error: (error as Error).message }, `Exception while running git show ${commitHash}`);
    return null;
  }
}

function extractCommitHashFromMetadata(metadata: TaskHistoryMetadata): string | null {
  if (metadata.historyMetadata?.commitResult?.commitHash) return metadata.historyMetadata.commitResult.commitHash;
  if (metadata.commitResult?.commitHash) return metadata.commitResult.commitHash;
  if (metadata.commitHash) return metadata.commitHash;
  if (metadata.prResult?.commitHash) return metadata.prResult.commitHash;
  if (metadata.githubComment?.body) {
    const match = metadata.githubComment.body.match(/\bcommit ([a-f0-9]{7,40})\b/i);
    if (match) return match[1];
  }
  return null;
}

function extractCommitHash(taskHistory: TaskHistory[], taskId: string, correlatedLogger: ReturnType<typeof logger.withCorrelation>): string | null {
  for (const history of taskHistory) {
    try {
      const metadata: TaskHistoryMetadata = typeof history.metadata === 'string' ? JSON.parse(history.metadata) : (history.metadata || {});
      const hash = extractCommitHashFromMetadata(metadata);
      if (hash) {
        if (metadata.githubComment?.body) {
          correlatedLogger.info({ taskId, commitHash: hash }, 'Extracted commit hash from GitHub comment body');
        }
        return hash;
      }
    } catch (parseError) {
      correlatedLogger.warn({ taskId, error: (parseError as Error).message }, 'Failed to parse task history metadata');
    }
  }
  return null;
}

function compactConversationLog(conversationLog: ConversationLogEntry[]): ConversationLogEntry[] {
  if (!Array.isArray(conversationLog)) {
    return [];
  }

  const toolUseMap = new Map<string, string>();
  conversationLog.forEach(entry => {
    if (entry.type === 'tool_use' && entry.id && entry.name) {
      toolUseMap.set(entry.id, entry.name);
    }
  });

  return conversationLog.map(entry => {
    if (entry.type === 'text' || entry.type === 'tool_use') {
      return entry;
    }

    if (entry.type === 'tool_result') {
      if (entry.is_error) {
        return entry;
      }

      const toolName = entry.tool_use_id ? toolUseMap.get(entry.tool_use_id) : undefined;
      const content = entry.content || '';

      if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
        if (content.startsWith('No files found')) {
          return entry;
        }
        const lines = content.split('\n');
        const summary = `[Content from ${toolName}: ${lines.length} lines. Content omitted for analysis.]`;
        return { ...entry, content: summary, compacted: true };
      }

      return entry;
    }

    return entry;
  });
}

export async function getExecutionAnalysis({ executionId, sessionId, correlationId, model }: GetExecutionAnalysisParams): Promise<AnalysisReport | { error: string }> {
  const correlatedLogger = logger.withCorrelation(correlationId);

  if (!db) {
    return { error: 'Database not configured.' };
  }

  try {
    const promptKey = `execution:prompt:session:${sessionId}`;
    const promptData: PromptData = JSON.parse(await redis.get(promptKey) || '{}');
    const originalPrompt = promptData.prompt || 'Original prompt not found.';
    const issueRef = promptData.issueRef;

    const conversationLog = await db('llm_execution_details')
      .where({ execution_id: executionId })
      .orderBy('sequence_number', 'asc') as ConversationLogEntry[];

    if (conversationLog.length === 0) {
      correlatedLogger.warn({ executionId }, 'No execution details found for analysis.');
      return { error: 'No execution details found.' };
    }

    const execution = await db('llm_executions')
      .where({ execution_id: executionId })
      .first() as Execution | undefined;

    if (!execution) {
      correlatedLogger.warn({ executionId }, 'No execution record found.');
      return { error: 'No execution record found.' };
    }

    const task = await db('tasks')
      .where({ task_id: execution.task_id })
      .first() as Task | undefined;

    if (!task) {
      correlatedLogger.warn({ executionId, taskId: execution.task_id }, 'No task record found.');
      return { error: 'No task record found.' };
    }

    const worktreePath = `/tmp/git-processor/clones/${task.repository}`;

    correlatedLogger.info({ worktreePath, repository: task.repository }, 'Using cloned repository for commit diff retrieval');

    if (!fs.existsSync(worktreePath)) {
      correlatedLogger.warn({ worktreePath }, 'Repository path does not exist, commit diff will not be available');
    } else {
      await execa('git', ['fetch', 'origin'], {
        cwd: worktreePath,
        reject: false
      });
    }

    const taskHistory = await db('task_history')
      .where({ task_id: execution.task_id })
      .whereNotNull('metadata')
      .orderBy('timestamp', 'desc') as TaskHistory[];

    const commitHash = extractCommitHash(taskHistory, execution.task_id, correlatedLogger);

    let localDiff: string | null = null;
    if (commitHash) {
      correlatedLogger.info({ commitHash, taskId: execution.task_id }, 'Found commit hash in task history');
      localDiff = await getCommitDiff(worktreePath, commitHash, correlationId);
    } else {
      correlatedLogger.warn({ taskId: execution.task_id }, 'No commit hash found in task history, commit diff will not be included');
    }

    correlatedLogger.info({
      worktreePath,
      commitHash,
      hasCommitDiff: !!localDiff,
      diffLength: localDiff?.length
    }, 'Commit diff retrieval result');

    const compactedLog = compactConversationLog(conversationLog);

    const originalLogString = JSON.stringify(conversationLog);
    const compactedLogString = JSON.stringify(compactedLog);
    correlatedLogger.info({
      originalLogLength: originalLogString.length,
      originalLogSizeKB: (originalLogString.length / 1024).toFixed(2),
      compactedLogLength: compactedLogString.length,
      compactedLogSizeKB: (compactedLogString.length / 1024).toFixed(2),
      originalEntries: conversationLog.length,
      compactedEntries: compactedLog.length
    }, 'Conversation log compaction stats');

    correlatedLogger.info({ compactedLog: compactedLogString }, 'Compacted conversation log output');

    const metaPrompt: string = generateExecutionAnalysisPrompt(
      originalPrompt,
      compactedLog,
      model,
      localDiff
    ) as string;

    const githubTokenKey = `github:token:${task.repository}`;
    const tokenData = await redis.get(githubTokenKey);
    const githubToken = tokenData || process.env.GH_TOKEN || '';

    const [repoOwner, repoName] = task.repository.split('/');
    const analysisText: string = await runLightweightLLMAnalysis({
      prompt: metaPrompt,
      model,
      correlationId,
      worktreePath,
      githubToken,
      issueRef: issueRef || {
        number: task.issue_number,
        repoOwner,
        repoName
      }
    }) as string;

    const analysisReport: AnalysisReport = {
      generatedAt: new Date().toISOString(),
      modelUsed: model,
      report: analysisText,
    };

    return analysisReport;
  } catch (error) {
    correlatedLogger.error({
      executionId,
      error: (error as Error).message,
      stack: (error as Error).stack
    }, 'Failed to generate execution analysis');
    throw error;
  }
}
