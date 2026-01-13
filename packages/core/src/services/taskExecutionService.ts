import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import Anthropic from '@anthropic-ai/sdk';

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

/**
 * Generates a short, descriptive title for a task based on the initial prompt.
 * Uses Claude Haiku for fast, lightweight generation.
 */
async function generateTaskTitle(initialPrompt: string, correlatedLogger: Pick<typeof logger, 'info' | 'warn'>): Promise<string | null> {
  try {
    const client = new Anthropic();

    const message = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Generate a short, descriptive title (5-8 words) for this task. Output ONLY the title, nothing else.

Task description:
${initialPrompt}`
        }
      ]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      const title = content.text.trim();
      correlatedLogger.info({ title }, 'Generated task title');
      return title;
    }
    return null;
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to generate task title, using default');
    return null;
  }
}

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

    // Post implementation as a separate comment if it exists
    if (task.implementation) {
      const commentBody = '**Suggested Implementation:**\n```\n' + task.implementation + '\n```';

      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: response.data.number,
        body: commentBody
      });

      correlatedLogger.info({
        draftId,
        issueNumber: response.data.number
      }, 'Implementation comment created');
    }

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const existingConfig = typeof draft.context_config === 'string'
    ? JSON.parse(draft.context_config)
    : (draft.context_config || {});

  // Generate a descriptive title if the name is still the default
  let generatedTitle: string | null = null;
  const isDefaultName = !draft.name || draft.name === 'Untitled Plan' || (draft.initial_prompt && draft.name === draft.initial_prompt.substring(0, 50) + (draft.initial_prompt.length > 50 ? '...' : ''));

  if (isDefaultName && draft.initial_prompt) {
    correlatedLogger.info({ draftId }, 'Generating task title');
    generatedTitle = await generateTaskTitle(draft.initial_prompt, correlatedLogger);
  }

  const updateData: Record<string, unknown> = {
    status: 'executed',
    context_config: JSON.stringify({
      ...existingConfig,
      executionResults: results,
      executedAt: new Date().toISOString()
    }),
    updated_at: db.fn.now()
  };

  if (generatedTitle) {
    updateData.name = generatedTitle;
  }

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update(updateData);

  correlatedLogger.info({
    draftId,
    issuesCreated: results.length,
    generatedTitle
  }, 'Draft execution completed');

  return { success: true, results };
}
