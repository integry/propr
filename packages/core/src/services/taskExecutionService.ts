import { db } from '../db/connection.js';
import { getAuthenticatedOctokit, getGitHubInstallationToken } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';
import { ensureRepoCloned } from '../git/repoManager.js';
import { runLightweightLLMAnalysis } from '../claude/claudeService.js';
import { createPlanIssue } from '../config/planIssueManager.js';

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
  id?: string;
  title: string;
  body: string;
  implementation: string;
  notes?: string;
  issue_number?: number;
  issue_url?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Formats implementation content for proper markdown rendering on GitHub.
 *
 * New format: Already contains proper markdown with file headers as headings
 * and code in fenced blocks - returns as-is.
 *
 * Old format: Plain text that was wrapped in a single code block - attempts
 * to detect and reformat for backwards compatibility.
 *
 * @param implementation - The implementation content from the plan task
 * @returns Properly formatted markdown for the implementation
 */
function formatImplementation(implementation: string): string {
  // Check if implementation already has proper markdown formatting
  // (contains markdown headings or fenced code blocks)
  const hasMarkdownHeadings = /^###\s+File:/m.test(implementation);
  const hasFencedCodeBlocks = /```(?:diff|typescript|javascript|ts|js|json|python|go|rust|java|c|cpp|csharp|ruby|php|swift|kotlin|scala|shell|bash|sh|yaml|yml|xml|html|css|scss|sql|graphql|markdown|md|plaintext|text)/m.test(implementation);

  if (hasMarkdownHeadings || hasFencedCodeBlocks) {
    // Already properly formatted, return as-is
    return implementation;
  }

  // Old format detected - attempt to reformat for backwards compatibility
  // Look for file path patterns and diff-like content
  const lines = implementation.split('\n');
  const formattedLines: string[] = [];
  let inCodeBlock = false;
  let currentLanguage = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Detect file headers (various patterns)
    const fileHeaderMatch = trimmedLine.match(/^(?:File:|In file|Modify|Create|Update|Edit)\s*[`']?([^\s`']+\.[a-zA-Z]+)[`']?:?\s*$/i) ||
                           trimmedLine.match(/^([^\s]+\.[a-zA-Z]+):?\s*$/);

    if (fileHeaderMatch) {
      // Close any open code block
      if (inCodeBlock) {
        formattedLines.push('```');
        inCodeBlock = false;
      }

      const filePath = fileHeaderMatch[1];
      formattedLines.push(`\n### File: \`${filePath}\`\n`);
      continue;
    }

    // Detect start of diff content
    if (trimmedLine.startsWith('---') && lines[i + 1]?.trim().startsWith('+++')) {
      if (inCodeBlock) {
        formattedLines.push('```');
      }
      formattedLines.push('```diff');
      inCodeBlock = true;
      currentLanguage = 'diff';
      formattedLines.push(line);
      continue;
    }

    // Detect unified diff hunk headers
    if (trimmedLine.startsWith('@@') && trimmedLine.includes('@@')) {
      if (!inCodeBlock) {
        formattedLines.push('```diff');
        inCodeBlock = true;
        currentLanguage = 'diff';
      }
      formattedLines.push(line);
      continue;
    }

    // If we're in a diff block and hit a non-diff line, close the block
    if (inCodeBlock && currentLanguage === 'diff') {
      const isDiffLine = trimmedLine === '' ||
                         trimmedLine.startsWith('+') ||
                         trimmedLine.startsWith('-') ||
                         trimmedLine.startsWith(' ') ||
                         trimmedLine.startsWith('@@') ||
                         trimmedLine.startsWith('---') ||
                         trimmedLine.startsWith('+++');

      if (!isDiffLine && trimmedLine !== '') {
        formattedLines.push('```');
        inCodeBlock = false;
        currentLanguage = '';
      }
    }

    formattedLines.push(line);
  }

  // Close any open code block at the end
  if (inCodeBlock) {
    formattedLines.push('```');
  }

  return formattedLines.join('\n');
}

interface GenerateTitleOptions {
  draftId: string;
  planJson: PlanTask[];
  owner: string;
  repoName: string;
  oldName: string;
  correlationId?: string;
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
  const prompt = `Generate a short, descriptive title (5-8 words) for this task based on the following plan:\n\n${planSummary}\n\nTitle:`;

  correlatedLogger.info({ draftId }, 'Generating task title via LLM');

  const generatedTitle = await runLightweightLLMAnalysis({
    prompt,
    model: 'haiku',
    correlationId: correlationId || 'finalize-title-gen',
    worktreePath,
    githubToken,
    issueRef: { number: 0, repoOwner: owner, repoName }
  });

  const cleanTitle = generatedTitle.replace(/^"|"$/g, '').trim();
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

    // Update the task with issue information
    planJson[i].issue_number = response.data.number;
    planJson[i].issue_url = response.data.html_url;

    correlatedLogger.info({
      draftId,
      issueNumber: response.data.number,
      issueUrl: response.data.html_url
    }, 'Issue created');

    // Create plan_issue record to track this issue
    try {
      await createPlanIssue({
        draft_id: draftId,
        repository: draft.repository,
        issue_number: response.data.number
      });
      correlatedLogger.info({
        draftId,
        issueNumber: response.data.number
      }, 'Plan issue record created');
    } catch (planIssueError) {
      correlatedLogger.warn({
        err: (planIssueError as Error).message,
        draftId,
        issueNumber: response.data.number
      }, 'Failed to create plan issue record, continuing');
    }

    // Post implementation as a separate comment if it exists
    if (task.implementation) {
      const formattedImplementation = formatImplementation(task.implementation);
      const commentBody = '**Suggested Implementation:**\n\n' + formattedImplementation;

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
