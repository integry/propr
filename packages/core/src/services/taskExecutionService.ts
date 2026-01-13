import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { getAnthropicClient } from '../utils/tokenCalculation.js';
import { resolveModelAlias } from '../config/modelAliases.js';

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

type CorrelatedLogger = Pick<typeof logger, 'info' | 'warn'>;

/**
 * Generates a short, descriptive title for a task based on the initial prompt.
 * Uses the shared Anthropic client and Haiku model for fast, lightweight generation.
 */
async function generateTaskTitle(initialPrompt: string, correlatedLogger: CorrelatedLogger): Promise<string | null> {
  try {
    const client = getAnthropicClient();
    const model = resolveModelAlias('haiku');

    const message = await client.messages.create({
      model,
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
      correlatedLogger.info({ title, model }, 'Generated task title');
      return title;
    }
    return null;
  } catch (error) {
    correlatedLogger.warn({ error: (error as Error).message }, 'Failed to generate task title, using default');
    return null;
  }
}

/**
 * Validates that a draft can be executed and returns an early result if applicable.
 */
function validateDraftForExecution(
  draft: TaskDraft | undefined,
  userId: string,
  draftId: string,
  correlatedLogger: CorrelatedLogger
): ExecutionResult | null {
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

  return null;
}

/**
 * Parses the repository string and returns owner and repo name.
 */
function parseRepository(repository: string): { owner: string; repoName: string } {
  const [owner, repoName] = repository.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repository format: ${repository}`);
  }
  return { owner, repoName };
}

/**
 * Creates a single GitHub issue and optionally posts an implementation comment.
 */
async function createGitHubIssue(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  owner: string,
  repoName: string,
  task: PlanTask,
  draftId: string,
  taskIndex: number,
  correlatedLogger: CorrelatedLogger
): Promise<IssueLink> {
  const issueBody = (task.body || '') + '\n\n---\n*Created by GitFix AI Planner*';

  correlatedLogger.info({ draftId, taskIndex, taskTitle: task.title }, 'Creating issue');

  const response = await octokit.request('POST /repos/{owner}/{repo}/issues', {
    owner,
    repo: repoName,
    title: task.title,
    body: issueBody,
    labels: ['gitfix-planned']
  });

  correlatedLogger.info({
    draftId,
    issueNumber: response.data.number,
    issueUrl: response.data.html_url
  }, 'Issue created');

  if (task.implementation) {
    await postImplementationComment(octokit, owner, repoName, response.data.number, task.implementation, draftId, correlatedLogger);
  }

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title
  };
}

/**
 * Posts an implementation comment on a GitHub issue.
 */
async function postImplementationComment(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  owner: string,
  repoName: string,
  issueNumber: number,
  implementation: string,
  draftId: string,
  correlatedLogger: CorrelatedLogger
): Promise<void> {
  const commentBody = '**Suggested Implementation:**\n```\n' + implementation + '\n```';

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo: repoName,
    issue_number: issueNumber,
    body: commentBody
  });

  correlatedLogger.info({ draftId, issueNumber }, 'Implementation comment created');
}

/**
 * Checks if the draft name is a default/placeholder name.
 */
function isDefaultDraftName(name: string | undefined, initialPrompt: string | undefined): boolean {
  if (!name || name === 'Untitled Plan') {
    return true;
  }
  if (initialPrompt) {
    const truncatedPrompt = initialPrompt.substring(0, 50) + (initialPrompt.length > 50 ? '...' : '');
    return name === truncatedPrompt;
  }
  return false;
}

export async function executeDraft(draftId: string, userId: string, correlationId?: string): Promise<ExecutionResult> {
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  if (!db) {
    throw new Error('Database not available');
  }

  correlatedLogger.info({ draftId }, 'Starting draft execution');

  const draft = await db<TaskDraft>('task_drafts').where({ draft_id: draftId }).first();

  const earlyResult = validateDraftForExecution(draft, userId, draftId, correlatedLogger);
  if (earlyResult) {
    return earlyResult;
  }

  // TypeScript now knows draft is defined after validation
  const validDraft = draft as TaskDraft;

  const planJson: PlanTask[] = typeof validDraft.plan_json === 'string'
    ? JSON.parse(validDraft.plan_json)
    : validDraft.plan_json;

  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  const { owner, repoName } = parseRepository(validDraft.repository);
  const octokit = await getAuthenticatedOctokit();
  const results: IssueLink[] = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const issueLink = await createGitHubIssue(octokit, owner, repoName, planJson[i], draftId, i + 1, correlatedLogger);
    results.push(issueLink);

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  const existingConfig = typeof validDraft.context_config === 'string'
    ? JSON.parse(validDraft.context_config)
    : (validDraft.context_config || {});

  let generatedTitle: string | null = null;
  if (isDefaultDraftName(validDraft.name, validDraft.initial_prompt) && validDraft.initial_prompt) {
    correlatedLogger.info({ draftId }, 'Generating task title');
    generatedTitle = await generateTaskTitle(validDraft.initial_prompt, correlatedLogger);
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
