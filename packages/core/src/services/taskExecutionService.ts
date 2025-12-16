import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';

export interface IssueLink {
  number: number;
  url: string;
  title: string;
}

export interface ExecutionResult {
  success: boolean;
  alreadyExecuted?: boolean;
  results?: IssueLink[];
}

interface TaskDraft {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  initial_prompt: string;
  plan_json: string | PlanTask[];
  context_config: string | Record<string, unknown>;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface PlanTask {
  title: string;
  body: string;
  implementation: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function executeDraft(draftId: string, userId: string, correlationId?: string): Promise<ExecutionResult> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) {
    throw new Error('Database not available');
  }

  correlatedLogger.info({ draftId }, 'Starting draft execution');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();
  
  if (!draft) {
    throw new Error('Draft not found');
  }

  if (draft.user_id !== userId) {
    throw new Error('Unauthorized');
  }

  if (draft.status === 'executed') {
    correlatedLogger.info({ draftId }, 'Draft already executed');
    return { success: true, alreadyExecuted: true };
  }

  if (draft.status !== 'review') {
    throw new Error(`Draft must be in 'review' status to execute. Current status: ${draft.status}`);
  }

  const planJson: PlanTask[] = typeof draft.plan_json === 'string' 
    ? JSON.parse(draft.plan_json) 
    : draft.plan_json;

  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  const [owner, repoName] = draft.repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${draft.repository}`);
  }

  const octokit = await getAuthenticatedOctokit();
  const results: IssueLink[] = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    let issueBody = task.body || '';
    
    if (task.implementation) {
      issueBody += '\n\n---\n\n**Implementation:**\n```\n' + task.implementation + '\n```';
    }

    issueBody += '\n\n---\n*Created by GitFix AI Planner*';

    correlatedLogger.info({ 
      draftId, 
      taskIndex: i + 1, 
      taskTitle: task.title 
    }, 'Creating issue');

    const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner,
      repo: repoName,
      title: task.title,
      body: issueBody,
      labels: ['gitfix-planned']
    });

    results.push({
      number: response.data.number,
      url: response.data.html_url,
      title: response.data.title
    });

    correlatedLogger.info({ 
      draftId, 
      issueNumber: response.data.number,
      issueUrl: response.data.html_url 
    }, 'Issue created');

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const existingConfig = typeof draft.context_config === 'string' 
    ? JSON.parse(draft.context_config) 
    : (draft.context_config || {});

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({
      status: 'executed',
      context_config: JSON.stringify({
        ...existingConfig,
        executionResults: results,
        executedAt: new Date().toISOString()
      }),
      updated_at: db.fn.now()
    });

  correlatedLogger.info({ 
    draftId, 
    issuesCreated: results.length 
  }, 'Draft execution completed');

  return { success: true, results };
}
