import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger, { type EnhancedLogger } from '../utils/logger.js';
import { type Logger } from 'pino';
import { generateAndSaveTaskTitle } from './taskExecutionHelpers.js';
import { getEventPublisher } from '../utils/eventPublisher.js';
import {
  processTaskAndCreateIssue,
  type PlanTask,
  type CreatedIssue
} from './githubIssueService.js';
import type { TaskDraftConfig } from './planning/planningTypes.js';

// Re-export Epic PR functions from separate module
export {
  ensureEpicPR,
  generateEpicBranchName,
  isEpicBranch,
  extractFirstIssueIdFromEpicBranch,
  EPIC_BRANCH_PATTERN,
  type EpicPRResult,
  type EnsureEpicPROptions
} from './epicPRService.js';

// Re-export types from githubIssueService for backwards compatibility
export type { CreatedIssue as IssueLink } from './githubIssueService.js';

export interface ExecutionResult {
  success: boolean;
  alreadyExecuted?: boolean;
  results?: CreatedIssue[];
}

interface TaskDraft {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  initial_prompt: string;
  plan_json: string | PlanTask[];
  context_config: string | TaskExecutionContextConfig;
  status: string;
  created_at: Date;
  updated_at: Date;
}

type TaskExecutionContextConfig = Partial<TaskDraftConfig> & {
  useEpic?: boolean;
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number | null;
  ultrafixMaxCycles?: number | null;
  executionResults?: CreatedIssue[];
  executionFailures?: Array<{ taskIndex: number; title: string; error: string }>;
  executedAt?: string;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface ValidatedDraftData {
  draft: TaskDraft;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  isReFinalization: boolean;
  contextConfig: TaskExecutionContextConfig;
}

export function parseContextConfig(
  contextConfig: string | TaskExecutionContextConfig
): TaskExecutionContextConfig {
  if (!contextConfig) {
    return {};
  }
  if (typeof contextConfig !== 'string') {
    return contextConfig ?? {};
  }

  const parsed = JSON.parse(contextConfig) as unknown;
  if (!parsed) return {};
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as TaskExecutionContextConfig;
  }
  throw new Error('Draft context_config must be a JSON object');
}

export function buildExecutionContextConfig(
  existingConfig: TaskExecutionContextConfig,
  results: CreatedIssue[],
  failures: Array<{ taskIndex: number; title: string; error: string }>
): TaskExecutionContextConfig {
  const updatedConfig: TaskExecutionContextConfig = {
    ...existingConfig,
    executionResults: results,
    executedAt: new Date().toISOString()
  };

  if (failures.length > 0) {
    updatedConfig.executionFailures = failures;
  } else {
    delete updatedConfig.executionFailures;
  }

  return updatedConfig;
}

// Statuses that allow RE-finalization (will detach existing issues and recreate)
const RE_FINALIZABLE_STATUSES = ['approved', 'executed', 'pr_created', 'merged', 'failed'];

async function validateAndPrepareDraft(
  draftId: string,
  userId: string,
  correlatedLogger: Logger | EnhancedLogger
): Promise<ValidatedDraftData> {
  if (!db) {
    throw new Error('Database not available');
  }

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();

  if (!draft) {
    throw new Error('Draft not found');
  }

  if (draft.user_id !== userId) {
    throw new Error('Unauthorized');
  }

  const isReFinalization = RE_FINALIZABLE_STATUSES.includes(draft.status);
  // 'executing' status means the handler already validated and set the status atomically
  // This is the normal execution flow, not a re-finalization
  const isNormalExecution = draft.status === 'review' || draft.status === 'executing';

  if (!isNormalExecution && !isReFinalization) {
    throw new Error(`Draft must be in 'review' status to execute. Current status: ${draft.status}`);
  }

  // For re-finalization, detach existing issues first
  if (isReFinalization) {
    correlatedLogger.info({ draftId, previousStatus: draft.status }, 'Re-finalizing draft, detaching existing issues');
    const deletedCount = await db('plan_issues').where({ draft_id: draftId }).delete();
    correlatedLogger.info({ draftId, deletedCount }, 'Detached existing plan issues');
  }

  const planJson: PlanTask[] = typeof draft.plan_json === 'string'
    ? JSON.parse(draft.plan_json)
    : draft.plan_json;

  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  // For re-finalization, clear old issue references from plan tasks
  if (isReFinalization) {
    for (const task of planJson) {
      delete task.issue_number;
      delete task.issue_url;
    }
  }

  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${draft.repository}`);
  }

  const contextConfig = parseContextConfig(draft.context_config);

  return {
    draft,
    planJson,
    owner,
    repoName,
    isReFinalization,
    contextConfig
  };
}

export async function executeDraft(draftId: string, userId: string, correlationId?: string): Promise<ExecutionResult> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;
  const eventPublisher = getEventPublisher();

  correlatedLogger.info({ draftId }, 'Starting draft execution');

  let validatedData;
  try {
    validatedData = await validateAndPrepareDraft(draftId, userId, correlatedLogger);
  } catch (error) {
    // Emit failure event if validation fails
    await eventPublisher.publishDraftUpdate({
      draftId,
      step: 'execution',
      status: 'failed',
      data: {
        error: error instanceof Error ? error.message : 'Validation failed'
      }
    });
    throw error;
  }

  const { draft, planJson, owner, repoName, contextConfig } = validatedData;
  const totalCount = planJson.length;

  // Emit initial progress event
  await eventPublisher.publishDraftUpdate({
    draftId,
    step: 'execution',
    status: 'in_progress',
    data: {
      createdCount: 0,
      totalCount,
      failedCount: 0
    }
  });

  try {
    await generateAndSaveTaskTitle({
      draftId,
      planJson,
      owner,
      repoName,
      oldName: draft.name,
      correlationId,
      db
    });
  } catch (err) {
    correlatedLogger.warn({ err: (err as Error).message }, 'Failed to generate task title, keeping original name');
  }

  const octokit = await getAuthenticatedOctokit();
  const results: CreatedIssue[] = [];
  const failures: Array<{ taskIndex: number; title: string; error: string }> = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    const result = await processTaskAndCreateIssue({
      octokit,
      owner,
      repoName,
      task,
      taskIndex: i,
      draftId,
      repository: draft.repository,
      runUltrafix: contextConfig.runUltrafix === true ? true : undefined,
      ultrafixGoal: contextConfig.runUltrafix === true ? contextConfig.ultrafixGoal ?? null : undefined,
      ultrafixMaxCycles: contextConfig.runUltrafix === true ? contextConfig.ultrafixMaxCycles ?? null : undefined,
      correlatedLogger,
      correlationId
    });

    if (result.success && result.issue) {
      results.push(result.issue);
      // Update the task with issue information
      planJson[i].issue_number = result.issue.number;
      planJson[i].issue_url = result.issue.url;

      // Emit progress event after each successful issue creation
      await eventPublisher.publishDraftUpdate({
        draftId,
        step: 'execution',
        status: 'in_progress',
        data: {
          createdCount: results.length,
          totalCount,
          failedCount: failures.length,
          lastCreatedIssue: {
            number: result.issue.number,
            url: result.issue.url,
            title: result.issue.title
          }
        }
      });
    } else {
      failures.push({
        taskIndex: i,
        title: task.title,
        error: result.error || 'Unknown error'
      });
      correlatedLogger.warn({
        draftId,
        taskIndex: i + 1,
        taskTitle: task.title,
        error: result.error
      }, 'Task failed, continuing with remaining tasks');

      // Emit progress event on failure as well
      await eventPublisher.publishDraftUpdate({
        draftId,
        step: 'execution',
        status: 'in_progress',
        data: {
          createdCount: results.length,
          totalCount,
          failedCount: failures.length,
          lastFailedTask: {
            index: i,
            title: task.title,
            error: result.error || 'Unknown error'
          }
        }
      });
    }

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const updatedConfig = buildExecutionContextConfig(contextConfig, results, failures);

  await db!('task_drafts')
    .where({ draft_id: draftId })
    .update({
      status: 'executed',
      plan_json: JSON.stringify(planJson),
      context_config: JSON.stringify(updatedConfig),
      updated_at: db!.fn.now()
    });

  // Emit completion event
  await eventPublisher.publishDraftUpdate({
    draftId,
    step: 'execution',
    status: failures.length === totalCount ? 'failed' : 'completed',
    data: {
      createdCount: results.length,
      totalCount,
      failedCount: failures.length,
      results: results.map(r => ({
        number: r.number,
        url: r.url,
        title: r.title
      }))
    }
  });

  correlatedLogger.info({
    draftId,
    issuesCreated: results.length,
    issuesFailed: failures.length
  }, 'Draft execution completed');

  return { success: results.length > 0, results };
}
