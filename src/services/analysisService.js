import Redis from 'ioredis';
import { db } from '../db/postgres.js';
import { generateExecutionAnalysisPrompt } from '../claude/prompts/promptGenerator.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import { execa } from 'execa';
import path from 'path';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
});

async function getCommitDiff(worktreePath, commitHash, correlationId) {
  const correlatedLogger = logger.withCorrelation(correlationId);
  try {
    // Add the directory to git's safe.directory list to avoid dubious ownership errors
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
    correlatedLogger.error({ worktreePath, commitHash, error: error.message }, `Exception while running git show ${commitHash}`);
    return null;
  }
}

function compactConversationLog(conversationLog) {
  if (!Array.isArray(conversationLog)) {
    return [];
  }

  const toolUseMap = new Map();
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

      const toolName = toolUseMap.get(entry.tool_use_id);
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

export async function getExecutionAnalysis({ executionId, sessionId, correlationId, model }) {
  const correlatedLogger = logger.withCorrelation(correlationId);

  try {
    const promptKey = `execution:prompt:session:${sessionId}`;
    const promptData = JSON.parse(await redis.get(promptKey) || '{}');
    const originalPrompt = promptData.prompt || 'Original prompt not found.';
    const issueRef = promptData.issueRef;

    const conversationLog = await db('llm_execution_details')
      .where({ execution_id: executionId })
      .orderBy('sequence_number', 'asc');
    
    if (conversationLog.length === 0) {
      correlatedLogger.warn({ executionId }, 'No execution details found for analysis.');
      return { error: 'No execution details found.' };
    }

    const execution = await db('llm_executions')
      .where({ execution_id: executionId })
      .first();
    
    if (!execution) {
      correlatedLogger.warn({ executionId }, 'No execution record found.');
      return { error: 'No execution record found.' };
    }

    const task = await db('tasks')
      .where({ task_id: execution.task_id })
      .first();

    if (!task) {
      correlatedLogger.warn({ executionId, taskId: execution.task_id }, 'No task record found.');
      return { error: 'No task record found.' };
    }

    // Construct the path to the cloned repository
    // task.repository is in format "owner/repo", e.g., "integry/gitfix"
    const worktreePath = `/tmp/git-processor/clones/${task.repository}`;

    correlatedLogger.info({ worktreePath, repository: task.repository }, 'Using cloned repository for commit diff retrieval');

    // Check if the repository path exists
    if (!fs.existsSync(worktreePath)) {
      correlatedLogger.warn({ worktreePath }, 'Repository path does not exist, commit diff will not be available');
    } else {
      // Fetch latest changes to ensure commit is available
      await execa('git', ['fetch', 'origin'], {
        cwd: worktreePath,
        reject: false
      });
    }

    const taskHistory = await db('task_history')
      .where({ task_id: execution.task_id })
      .whereNotNull('metadata')
      .orderBy('timestamp', 'desc');
    
    let commitHash = null;
    for (const history of taskHistory) {
      try {
        // metadata is already an object when using JSONB column type
        const metadata = typeof history.metadata === 'string'
          ? JSON.parse(history.metadata)
          : (history.metadata || {});
        if (metadata.commitResult?.commitHash) {
          commitHash = metadata.commitResult.commitHash;
          break;
        }
        if (metadata.commitHash) {
          commitHash = metadata.commitHash;
          break;
        }
        if (metadata.prResult?.commitHash) {
          commitHash = metadata.prResult.commitHash;
          break;
        }
        // Fallback: try to extract commit hash from GitHub comment body
        if (metadata.githubComment?.body) {
          const match = metadata.githubComment.body.match(/\bcommit ([a-f0-9]{7,40})\b/i);
          if (match) {
            commitHash = match[1];
            correlatedLogger.info({ taskId: execution.task_id, commitHash }, 'Extracted commit hash from GitHub comment body');
            break;
          }
        }
      } catch (parseError) {
        correlatedLogger.warn({ taskId: execution.task_id, error: parseError.message }, 'Failed to parse task history metadata');
      }
    }

    let localDiff = null;
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

    const metaPrompt = generateExecutionAnalysisPrompt(
      originalPrompt, 
      compactedLog, 
      model,
      localDiff
    );

    const githubTokenKey = `github:token:${task.repository}`;
    const tokenData = await redis.get(githubTokenKey);
    const githubToken = tokenData || process.env.GH_TOKEN;

    const analysisText = await runLightweightLLMAnalysis(
      metaPrompt, 
      model, 
      correlationId, 
      worktreePath, 
      githubToken,
      issueRef || { 
        number: task.issue_number, 
        repoOwner: task.repository.split('/')[0], 
        repoName: task.repository.split('/')[1] 
      }
    );
    
    const analysisReport = {
      generatedAt: new Date().toISOString(),
      modelUsed: model,
      report: analysisText,
    };

    return analysisReport;
  } catch (error) {
    correlatedLogger.error({ 
      executionId, 
      error: error.message,
      stack: error.stack 
    }, 'Failed to generate execution analysis');
    throw error;
  }
}
