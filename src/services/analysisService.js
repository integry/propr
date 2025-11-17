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
    const { stdout, stderr } = await execa('git', ['show', commitHash], { 
      cwd: worktreePath, 
      reject: false 
    });
    
    if (stderr) {
      correlatedLogger.warn({ worktreePath, commitHash, stderr }, `git show ${commitHash} reported non-fatal errors.`);
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

    const mainRepoPath = '/home/node/workspace';
    const worktreePath = mainRepoPath;
    
    correlatedLogger.info({ worktreePath }, 'Using main repository for commit diff retrieval');
    
    await execa('git', ['fetch', 'origin'], { 
      cwd: worktreePath, 
      reject: false 
    });

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

    const metaPrompt = generateExecutionAnalysisPrompt(
      originalPrompt, 
      conversationLog, 
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
