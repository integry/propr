import { db } from '../db/connection.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';

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
 * Options for creating a GitHub issue.
 */
interface CreateGitHubIssueOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  task: PlanTask;
  draftId: string;
  taskIndex: number;
  correlatedLogger: CorrelatedLogger;
}

/**
 * Options for posting an implementation comment.
 */
interface PostImplementationCommentOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  issueNumber: number;
  implementation: string;
  draftId: string;
  correlatedLogger: CorrelatedLogger;
}

/**
 * Options for generating a task title.
 */
interface GenerateTaskTitleOptions {
  initialPrompt: string;
  repository: string;
  correlatedLogger: CorrelatedLogger;
  correlationId: string;
}

const CLONES_BASE_PATH = process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';

/**
 * Generates a short, descriptive title for a task based on the initial prompt.
 * Uses the lightweight LLM analysis via Docker execution.
 */
async function generateTaskTitle(options: GenerateTaskTitleOptions): Promise<string | null> {
  const { initialPrompt, repository, correlatedLogger, correlationId } = options;

  try {
    const [repoOwner, repoName] = repository.split('/');
    if (!repoOwner || !repoName) {
      correlatedLogger.warn({ repository }, 'Invalid repository format for title generation');
      return null;
    }

    const worktreePath = `${CLONES_BASE_PATH}/${repository}`;
    const githubToken = await getGitHubInstallationToken();

    const prompt = `Generate a short, descriptive title (5-8 words) for this task. Output ONLY the title, nothing else.

Task description:
${initialPrompt}`;

    const title = await runLightweightLLMAnalysis({
      prompt,
      model: 'haiku',
      correlationId,
      worktreePath,
      githubToken,
      issueRef: {
        number: 0, // No specific issue for draft title generation
        repoOwner,
        repoName
      }
    });

    const cleanedTitle = title.trim();
    correlatedLogger.info({ title: cleanedTitle }, 'Generated task title');
    return cleanedTitle;
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
async function createGitHubIssue(options: CreateGitHubIssueOptions): Promise<IssueLink> {
  const { octokit, owner, repoName, task, draftId, taskIndex, correlatedLogger } = options;
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
    await postImplementationComment({
      octokit,
      owner,
      repoName,
      issueNumber: response.data.number,
      implementation: task.implementation,
      draftId,
      correlatedLogger
    });
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
async function postImplementationComment(options: PostImplementationCommentOptions): Promise<void> {
  const { octokit, owner, repoName, issueNumber, implementation, draftId, correlatedLogger } = options;
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

/**
 * Creates all GitHub issues for the plan tasks with rate limiting.
 */
async function createAllGitHubIssues(
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>,
  owner: string,
  repoName: string,
  planJson: PlanTask[],
  draftId: string,
  correlatedLogger: CorrelatedLogger
): Promise<IssueLink[]> {
  const results: IssueLink[] = [];

  for (let i = 0; i < planJson.length; i++) {
    const issueLink = await createGitHubIssue({
      octokit,
      owner,
      repoName,
      task: planJson[i],
      draftId,
      taskIndex: i + 1,
      correlatedLogger
    });
    results.push(issueLink);

    if (i < planJson.length - 1) {
      await sleep(1000);
    }
  }

  return results;
}

/**
 * Builds the update data object for the draft after execution.
 */
function buildExecutionUpdateData(
  existingConfig: Record<string, unknown>,
  results: IssueLink[],
  generatedTitle: string | null,
  dbFn: typeof db.fn
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {
    status: 'executed',
    context_config: JSON.stringify({
      ...existingConfig,
      executionResults: results,
      executedAt: new Date().toISOString()
    }),
    updated_at: dbFn.now()
  };

  if (generatedTitle) {
    updateData.name = generatedTitle;
  }

  return updateData;
}

/**
 * Parses the context config from a draft.
 */
function parseContextConfig(contextConfig: string | Record<string, unknown>): Record<string, unknown> {
  return typeof contextConfig === 'string'
    ? JSON.parse(contextConfig)
    : (contextConfig || {});
}

/**
 * Parses the plan JSON from a draft.
 */
function parsePlanJson(planJson: string | PlanTask[]): PlanTask[] {
  const parsed = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Draft has no tasks to execute');
  }

  return parsed;
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

  const planJson = parsePlanJson(validDraft.plan_json);
  const { owner, repoName } = parseRepository(validDraft.repository);
  const octokit = await getAuthenticatedOctokit();

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  const results = await createAllGitHubIssues(octokit, owner, repoName, planJson, draftId, correlatedLogger);

  const existingConfig = parseContextConfig(validDraft.context_config);
  const effectiveCorrelationId = correlationId || draftId;
  const generatedTitle = await maybeGenerateTaskTitle(validDraft, draftId, correlatedLogger, effectiveCorrelationId);

  const updateData = buildExecutionUpdateData(existingConfig, results, generatedTitle, db.fn);

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

/**
 * Generates a task title if the draft has a default name.
 */
async function maybeGenerateTaskTitle(
  validDraft: TaskDraft,
  draftId: string,
  correlatedLogger: CorrelatedLogger,
  correlationId: string
): Promise<string | null> {
  if (isDefaultDraftName(validDraft.name, validDraft.initial_prompt) && validDraft.initial_prompt) {
    correlatedLogger.info({ draftId }, 'Generating task title');
    return generateTaskTitle({
      initialPrompt: validDraft.initial_prompt,
      repository: validDraft.repository,
      correlatedLogger,
      correlationId
    });
  }
  return null;
}
