import crypto from 'crypto';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger, { type EnhancedLogger } from '../utils/logger.js';
import { type Logger } from 'pino';
import { ensureRepoCloned } from '../git/repoManager.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { createPlanIssue } from '../config/planIssueManager.js';
import { buildUserNotesCommentBody, type PlanTaskAttachment } from './taskExecutionHelpers.js';

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

export interface EpicPRResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  branchName?: string;
  labelName?: string;
  error?: string;
}

export interface EnsureEpicPROptions {
  owner: string;
  repoName: string;
  firstIssueId: number;
  planName: string;
  baseBranch?: string;
  correlationId?: string;
}

/**
 * Regex pattern to detect Epic branch names.
 * Format: {id}-epic-{word1}-{word2}-{rand}
 * Example: 800-epic-short-name-x7y
 */
export const EPIC_BRANCH_PATTERN = /^(\d+)-epic-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]{3})$/;

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
  id?: string;
  title: string;
  body: string;
  implementation: string;
  notes?: string;
  attachments?: PlanTaskAttachment[];
  issue_number?: number;
  issue_url?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface GenerateTitleOptions {
  draftId: string;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  oldName: string;
  correlationId?: string;
}

/**
 * Cleans a generated title by removing markdown formatting, quotes, and prefixes.
 * Ensures the title is plain text suitable for display.
 */
function cleanGeneratedTitle(title: string): string {
  let cleaned = title;

  // Remove leading markdown header symbols (e.g., "# Title" or "## Title")
  cleaned = cleaned.replace(/^#+\s*/, '');

  // Remove "Title:" prefix (case-insensitive)
  cleaned = cleaned.replace(/^title:\s*/i, '');

  // Remove wrapping quotes (single, double, or backticks)
  cleaned = cleaned.replace(/^["'`]|["'`]$/g, '');

  // Remove markdown bold formatting (**text** or __text__)
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');

  // Remove markdown italic formatting (*text* or _text_)
  // Be careful not to remove underscores in the middle of words
  cleaned = cleaned.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1');
  cleaned = cleaned.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

  // Remove any remaining standalone markdown symbols at start/end
  cleaned = cleaned.replace(/^[*_#`]+|[*_#`]+$/g, '');

  // Trim whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

interface CreateIssueOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
}

interface CreatedIssue {
  number: number;
  url: string;
  title: string;
}

async function createGitHubIssue(options: CreateIssueOptions): Promise<CreatedIssue> {
  const { octokit, owner, repoName, task, draftId, correlatedLogger } = options;

  let issueBody = task.body || '';
  issueBody += '\n\n---\n*Created by GitFix AI Planner*';

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

  return {
    number: response.data.number,
    url: response.data.html_url,
    title: response.data.title
  };
}

interface PostIssueCommentsOptions {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repoName: string;
  issueNumber: number;
  task: PlanTask;
  draftId: string;
  correlatedLogger: Logger | EnhancedLogger;
}

async function postIssueComments(options: PostIssueCommentsOptions): Promise<void> {
  const { octokit, owner, repoName, issueNumber, task, draftId, correlatedLogger } = options;

  // Post implementation as a separate comment if it exists
  if (task.implementation) {
    const commentBody = '**Suggested Implementation:**\n\n' + task.implementation;

    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body: commentBody
    });

    correlatedLogger.info({
      draftId,
      issueNumber
    }, 'Implementation comment created');
  }

  // Post user notes and attachments as a separate comment if they exist
  const hasNotes = task.notes && task.notes.trim();
  const hasAttachments = task.attachments && task.attachments.length > 0;

  if (hasNotes || hasAttachments) {
    // Build comment body with images using direct URLs and linked text files
    // Files remain on the server and are not committed to the repository
    const userNotesCommentBody = buildUserNotesCommentBody({
      notes: task.notes,
      attachments: task.attachments || [],
      draftId,
      correlatedLogger
    });

    if (userNotesCommentBody) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body: userNotesCommentBody
      });

      correlatedLogger.info({
        draftId,
        issueNumber,
        hasNotes: !!task.notes,
        attachmentCount: task.attachments?.length || 0
      }, 'User notes comment created');
    }
  }
}

async function generateAndSaveTaskTitle(options: GenerateTitleOptions): Promise<void> {
  const { draftId, planJson, owner, repoName, oldName, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const githubToken = await getGitHubInstallationToken();
  const repoUrl = `https://github.com/${owner}/${repoName}.git`;

  const worktreePath = await ensureRepoCloned({
    repoUrl,
    owner,
    repoName,
    authToken: githubToken
  });

  const planSummary = JSON.stringify(planJson).substring(0, 3000);
  const prompt = `Generate a short, descriptive title (5-8 words) for this task based on the following plan.

STRICT FORMATTING RULES:
- Output ONLY the title text, nothing else
- Do NOT use markdown formatting (no **, __, *, _, or # symbols)
- Do NOT wrap the title in quotes
- Do NOT prefix with "Title:" or any other label
- Plain text only

Plan:
${planSummary}

Title (plain text only):`;

  correlatedLogger.info({ draftId }, 'Generating task title via LLM');

  // Build metadata for LLM log tracking
  const titleGenerationMetadata = {
    planTaskCount: planJson.length,
    planSummaryLength: planSummary.length,
    oldName,
  };

  const generatedTitle = await runLightweightLLMAnalysis({
    prompt,
    model: 'haiku',
    correlationId: correlationId || 'finalize-title-gen',
    worktreePath,
    githubToken,
    issueRef: { number: 0, repoOwner: owner, repoName },
    executionType: 'title-generation',
    metadata: titleGenerationMetadata
  });

  const cleanTitle = cleanGeneratedTitle(generatedTitle);
  if (cleanTitle && db) {
    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({ name: cleanTitle });

    correlatedLogger.info({ draftId, oldName, newName: cleanTitle }, 'Updated task title');
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

  try {
    await generateAndSaveTaskTitle({
      draftId,
      planJson,
      owner,
      repoName,
      oldName: draft.name,
      correlationId
    });
  } catch (err) {
    correlatedLogger.warn({ err: (err as Error).message }, 'Failed to generate task title, keeping original name');
  }

  const octokit = await getAuthenticatedOctokit();
  const results: IssueLink[] = [];

  correlatedLogger.info({ draftId, taskCount: planJson.length }, 'Creating GitHub issues');

  for (let i = 0; i < planJson.length; i++) {
    const task = planJson[i];

    correlatedLogger.info({
      draftId,
      taskIndex: i + 1,
      taskTitle: task.title
    }, 'Creating issue');

    const createdIssue = await createGitHubIssue({
      octokit,
      owner,
      repoName,
      task,
      draftId,
      correlatedLogger
    });

    results.push(createdIssue);

    // Update the task with issue information
    planJson[i].issue_number = createdIssue.number;
    planJson[i].issue_url = createdIssue.url;

    // Create plan_issue record to track this issue
    try {
      await createPlanIssue({
        draft_id: draftId,
        repository: draft.repository,
        issue_number: createdIssue.number
      });
      correlatedLogger.info({
        draftId,
        issueNumber: createdIssue.number
      }, 'Plan issue record created');
    } catch (planIssueError) {
      correlatedLogger.warn({
        err: (planIssueError as Error).message,
        draftId,
        issueNumber: createdIssue.number
      }, 'Failed to create plan issue record, continuing');
    }

    // Post implementation and user notes comments
    await postIssueComments({
      octokit,
      owner,
      repoName,
      issueNumber: createdIssue.number,
      task,
      draftId,
      correlatedLogger
    });

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
      plan_json: JSON.stringify(planJson),
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

/**
 * Generates a random 3-character alphanumeric suffix for branch name collision prevention.
 */
function generateRandomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(3);
  for (let i = 0; i < 3; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Truncates a plan name to a maximum of 2 words, keeping only alphanumeric characters.
 * Returns the words in lowercase, separated by hyphens.
 *
 * @param planName - The full plan name to truncate
 * @returns Truncated name with max 2 words (e.g., "short-name")
 */
function truncatePlanName(planName: string): string {
  // Extract alphanumeric words only
  const words = planName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 0)
    .slice(0, 2);

  // Ensure we have at least one word
  if (words.length === 0) {
    return 'epic';
  }

  // If only one word, duplicate it to maintain format
  if (words.length === 1) {
    return `${words[0]}-branch`;
  }

  return words.join('-');
}

/**
 * Generates an Epic branch name following the format: {id}-epic-{word1}-{word2}-{rand}
 *
 * @param firstIssueId - The ID of the first issue in the plan
 * @param planName - The plan name to be truncated
 * @returns Branch name like "800-epic-short-name-x7y"
 */
export function generateEpicBranchName(firstIssueId: number, planName: string): string {
  const truncatedName = truncatePlanName(planName);
  const randomSuffix = generateRandomSuffix();
  return `${firstIssueId}-epic-${truncatedName}-${randomSuffix}`;
}

/**
 * Checks if a branch name matches the Epic branch pattern.
 *
 * @param branchName - The branch name to check
 * @returns True if the branch name matches the Epic pattern
 */
export function isEpicBranch(branchName: string): boolean {
  return EPIC_BRANCH_PATTERN.test(branchName);
}

/**
 * Ensures an Epic PR exists for a plan, creating the branch, label, and PR if needed.
 *
 * - Branch naming: {firstIssueId}-epic-{word1}-{word2}-{rand}
 * - Creates a base-{branchName} label for child PRs to target
 * - Creates a draft PR for the Epic branch
 *
 * @param options - Options for creating the Epic PR
 * @returns Result containing PR info and branch/label names
 */
export async function ensureEpicPR(options: EnsureEpicPROptions): Promise<EpicPRResult> {
  const { owner, repoName, firstIssueId, planName, baseBranch = 'main', correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const octokit = await getAuthenticatedOctokit();

  // Generate the Epic branch name
  const branchName = generateEpicBranchName(firstIssueId, planName);
  const labelName = `base-${branchName}`;

  correlatedLogger.info({
    owner,
    repoName,
    firstIssueId,
    branchName,
    labelName,
    baseBranch
  }, 'Ensuring Epic PR exists');

  try {
    // Step 1: Get the base branch SHA
    const baseBranchRef = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner,
      repo: repoName,
      ref: `heads/${baseBranch}`
    });
    const baseSha = baseBranchRef.data.object.sha;

    // Step 2: Create the Epic branch
    try {
      await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
        owner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      });
      correlatedLogger.info({ branchName, baseSha }, 'Epic branch created');
    } catch (branchError) {
      const err = branchError as Error & { status?: number };
      if (err.status === 422 && err.message?.includes('Reference already exists')) {
        correlatedLogger.info({ branchName }, 'Epic branch already exists');
      } else {
        throw branchError;
      }
    }

    // Step 3: Create the base label for child PRs
    try {
      await octokit.request('POST /repos/{owner}/{repo}/labels', {
        owner,
        repo: repoName,
        name: labelName,
        color: '0e8a16', // Green color for epic labels
        description: `Base branch label for Epic: ${planName}`
      });
      correlatedLogger.info({ labelName }, 'Epic label created');
    } catch (labelError) {
      const err = labelError as Error & { status?: number };
      if (err.status === 422 && err.message?.includes('already_exists')) {
        correlatedLogger.info({ labelName }, 'Epic label already exists');
      } else {
        throw labelError;
      }
    }

    // Step 4: Create the Epic PR (draft)
    let prNumber: number;
    let prUrl: string;

    try {
      const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
        owner,
        repo: repoName,
        title: `[Epic] ${planName}`,
        head: branchName,
        base: baseBranch,
        body: `## Epic PR\n\nThis PR aggregates all changes for: **${planName}**\n\nChild PRs should target the \`${branchName}\` branch using the \`${labelName}\` label.\n\n---\n*Created by GitFix AI Planner*`,
        draft: true
      });
      prNumber = prResponse.data.number;
      prUrl = prResponse.data.html_url;
      correlatedLogger.info({ prNumber, prUrl }, 'Epic PR created');
    } catch (prError) {
      const err = prError as Error & { status?: number; message?: string };
      if (err.status === 422 && err.message?.includes('A pull request already exists')) {
        // Find the existing PR
        const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo: repoName,
          head: `${owner}:${branchName}`,
          state: 'open'
        });
        if (existingPRs.data.length > 0) {
          prNumber = existingPRs.data[0].number;
          prUrl = existingPRs.data[0].html_url;
          correlatedLogger.info({ prNumber, prUrl }, 'Found existing Epic PR');
        } else {
          throw new Error('Epic PR creation failed and no existing PR found');
        }
      } else {
        throw prError;
      }
    }

    return {
      success: true,
      prNumber,
      prUrl,
      branchName,
      labelName
    };

  } catch (error) {
    const err = error as Error;
    correlatedLogger.error({
      error: err.message,
      owner,
      repoName,
      branchName
    }, 'Failed to ensure Epic PR');

    return {
      success: false,
      error: err.message
    };
  }
}
