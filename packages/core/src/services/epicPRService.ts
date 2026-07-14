import crypto from 'crypto';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import logger from '../utils/logger.js';

type OctokitLike = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;

interface CreatePROptions {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
}

/**
 * Create a PR as draft when supported, falling back to ready-for-review on
 * GitHub Free private repos where drafts are unavailable.
 */
export async function createEpicPRWithDraftFallback(
  octokit: OctokitLike,
  opts: CreatePROptions
): Promise<{ data: { number: number; html_url: string } }> {
  try {
    return await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      ...opts,
      draft: true
    });
  } catch (err) {
    const e = err as Error & { status?: number; message?: string };
    const msg = e.message ?? '';
    if (e.status === 422 && /draft.*not supported/i.test(msg)) {
      return await octokit.request('POST /repos/{owner}/{repo}/pulls', {
        ...opts,
        draft: false
      });
    }
    throw err;
  }
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

interface ResolveEpicBaseBranchOptions {
  octokit: Pick<OctokitLike, 'request'>;
  owner: string;
  repo: string;
  explicitBase: string | undefined;
  correlatedLogger: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

/**
 * Regex pattern to detect Epic branch names.
 * Format: {id}-epic-{word1}-{word2}-{rand}
 * Example: 800-epic-short-name-x7y
 */
export const EPIC_BRANCH_PATTERN = /^(\d+)-epic-([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]{3})$/;

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
 * Extracts the first issue ID from an Epic branch name.
 *
 * @param branchName - The Epic branch name (e.g., "800-epic-short-name-x7y")
 * @returns The first issue ID, or null if not a valid Epic branch
 */
export function extractFirstIssueIdFromEpicBranch(branchName: string): number | null {
  const match = branchName.match(EPIC_BRANCH_PATTERN);
  if (!match) {
    return null;
  }
  return parseInt(match[1], 10);
}

/**
 * Resolve the branch an epic should fork from. Never assume 'main': repositories
 * differ (e.g. 'master'), and forking from a non-existent branch makes the
 * base-SHA lookup 404 — which previously caused epic creation to silently fall
 * back to no epic and send auto-merge straight to the default branch. Honor an
 * explicit base when given, otherwise use the repository's actual default
 * branch, falling back to 'main' only if that lookup fails.
 */
export async function resolveEpicBaseBranch({
  octokit,
  owner,
  repo,
  explicitBase,
  correlatedLogger
}: ResolveEpicBaseBranchOptions): Promise<string> {
  if (explicitBase) return explicitBase;
  try {
    const repoResponse = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    return (repoResponse.data as { default_branch?: string }).default_branch || 'main';
  } catch (repoError) {
    correlatedLogger.warn({ owner, repo, error: (repoError as Error).message }, 'Failed to resolve repository default branch for epic base; falling back to main');
    return 'main';
  }
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
  const { owner, repoName, firstIssueId, planName, correlationId } = options;
  const correlatedLogger = correlationId ? logger.withCorrelation(correlationId) : logger;

  const octokit = await getAuthenticatedOctokit();

  const baseBranch = await resolveEpicBaseBranch({
    octokit,
    owner,
    repo: repoName,
    explicitBase: options.baseBranch,
    correlatedLogger
  });

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
    // GitHub label descriptions have a 100 character limit
    const labelDescription = `Base branch label for Epic: ${planName}`.slice(0, 100);
    try {
      await octokit.request('POST /repos/{owner}/{repo}/labels', {
        owner,
        repo: repoName,
        name: labelName,
        color: '0e8a16', // Green color for epic labels
        description: labelDescription
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
      const prResponse = await createEpicPRWithDraftFallback(octokit, {
        owner,
        repo: repoName,
        title: `[Epic] ${planName}`,
        head: branchName,
        base: baseBranch,
        body: `## Epic PR\n\nThis PR aggregates all changes for: **${planName}**\n\nChild PRs should target the \`${branchName}\` branch using the \`${labelName}\` label.\n\n---\n*Created by ProPR AI Planner*`
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
      } else if (err.status === 422 && err.message?.includes('No commits between')) {
        // No commits yet - branch and label are ready, PR will be created when first child PR merges
        correlatedLogger.info({ branchName, labelName }, 'Epic branch ready, PR will be created when commits are added');
        return {
          success: true,
          branchName,
          labelName
          // prNumber and prUrl are undefined - PR will be created later
        };
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
