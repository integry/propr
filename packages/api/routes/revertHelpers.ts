import { getUserWhitelist, getAuthenticatedOctokit, generateCorrelationId, generateAuthToken } from '@propr/core';
import type { SystemTaskJobData } from '@propr/core';
import { validatePositiveInteger } from './validation.js';

/** GitHub owner/repo names: alphanumeric, hyphens, underscores, dots. No slashes or whitespace. */
const GITHUB_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface RevertRequestBody {
  repo: string;
  pr: string;
  commit: string;
  commentId: string;
  owner: string;
}

export function validateRevertRequestBody(body: Record<string, unknown>): { valid: true; params: RevertRequestBody } | { valid: false; error: string } {
  const { repo, pr, commit, commentId, owner } = body;

  if (!repo || !pr || !commit || !commentId || !owner) {
    return { valid: false, error: 'Missing required parameters: repo, pr, commit, commentId, owner' };
  }

  if (typeof repo !== 'string' || repo.length > 100 || !GITHUB_NAME_PATTERN.test(repo)) {
    return { valid: false, error: 'Invalid repo name' };
  }

  if (typeof owner !== 'string' || owner.length > 100 || !GITHUB_NAME_PATTERN.test(owner)) {
    return { valid: false, error: 'Invalid owner name' };
  }

  const prValidation = validatePositiveInteger(pr, 'PR number', { required: true, max: 10000000 });
  if (!prValidation.valid) {
    return { valid: false, error: prValidation.error! };
  }

  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    return { valid: false, error: 'Invalid commit hash' };
  }

  const commentIdValidation = validatePositiveInteger(commentId, 'Comment ID', { required: true, max: 10000000000 });
  if (!commentIdValidation.valid) {
    return { valid: false, error: commentIdValidation.error! };
  }

  return { valid: true, params: { repo, pr, commit, commentId, owner } as RevertRequestBody };
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string | null;
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
  };
  author?: {
    login?: string;
  } | null;
}

export function formatCommit(c: GitHubCommit): CommitInfo {
  return {
    sha: c.sha,
    shortSha: c.sha.substring(0, 7),
    message: c.commit.message.split('\n')[0],
    author: c.commit.author?.name || c.author?.login || 'Unknown',
    date: c.commit.author?.date || null
  };
}

export function validateRevertPreviewParams(query: Record<string, string>): { valid: true; params: { owner: string; repo: string; pr: string; commit: string } } | { valid: false; error: string } {
  const { owner, repo, pr, commit } = query;

  if (!owner || !repo || !pr || !commit) {
    return { valid: false, error: 'Missing required parameters: owner, repo, pr, commit' };
  }

  if (typeof owner !== 'string' || owner.length > 100 || !GITHUB_NAME_PATTERN.test(owner)) {
    return { valid: false, error: 'Invalid owner name' };
  }

  if (typeof repo !== 'string' || repo.length > 100 || !GITHUB_NAME_PATTERN.test(repo)) {
    return { valid: false, error: 'Invalid repo name' };
  }

  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    return { valid: false, error: 'Invalid commit hash' };
  }

  return { valid: true, params: { owner, repo, pr, commit } };
}

export type AuthorizationResult = {
  authorized: true;
  requestingUser: string;
  systemTaskSecret: string;
} | {
  authorized: false;
  status: number;
  error: string;
}

export function checkRevertAuthorization(req: { user?: unknown }): AuthorizationResult {
  const requestingUser = (req.user as { username?: string })?.username || '';
  if (!requestingUser) {
    return { authorized: false, status: 401, error: 'Unable to determine requesting user' };
  }

  const whitelist = getUserWhitelist();
  if (whitelist.length === 0) {
    return { authorized: false, status: 403, error: 'User whitelist is not configured — destructive operations require an explicit allowlist' };
  }
  if (!whitelist.includes(requestingUser)) {
    return { authorized: false, status: 403, error: `User '${requestingUser}' is not allowed to perform system tasks` };
  }

  const systemTaskSecret = process.env.SYSTEM_TASK_SECRET;
  if (!systemTaskSecret) {
    console.error('[revert] SYSTEM_TASK_SECRET is not configured');
    return { authorized: false, status: 503, error: 'System task authorization is not configured' };
  }

  return { authorized: true, requestingUser, systemTaskSecret };
}

export type PrLookupResult = {
  success: true;
  prData: {
    head: { ref: string; repo?: { owner?: { login?: string }; name?: string; full_name?: string } | null };
    base: { ref: string; repo?: { full_name?: string } | null };
  };
  /** Reuse this Octokit instance for subsequent calls in the same request */
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
} | {
  success: false;
  status: number;
  error: string;
}

export async function lookupPr(owner: string, repo: string, prNumber: number, pr: string): Promise<PrLookupResult> {
  const octokit = await getAuthenticatedOctokit();
  try {
    const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner, repo, pull_number: prNumber
    });
    return { success: true, prData: response.data, octokit };
  } catch (prLookupError) {
    const err = prLookupError as { status?: number; message?: string };
    if (err.status === 404) {
      return { success: false, status: 404, error: `PR #${pr} not found in ${owner}/${repo}` };
    }
    console.error(`[revert] Failed to fetch PR #${pr} from ${owner}/${repo}:`, prLookupError);
    return { success: false, status: 502, error: `Unable to fetch PR #${pr} from GitHub` };
  }
}

interface VerifyCommitBelongsToPrParams {
  octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
  owner: string;
  repo: string;
  prNumber: number;
  commit: string;
}

/**
 * Verify that a commit hash belongs to the given PR's commit list.
 * Prevents arbitrary commit hash injection for destructive git reset.
 */
export async function verifyCommitBelongsToPr({
  octokit, owner, repo, prNumber, commit
}: VerifyCommitBelongsToPrParams): Promise<{ valid: true } | { valid: false; status: number; error: string }> {
  try {
    const prCommits = await octokit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      owner, repo, pull_number: prNumber, per_page: 100
    }) as Array<{ sha: string }>;
    const found = prCommits.some(c => c.sha === commit || c.sha.startsWith(commit));
    if (!found) {
      return { valid: false, status: 400, error: `Commit ${commit} does not belong to PR #${prNumber}` };
    }
    return { valid: true };
  } catch (err) {
    console.error(`[revert] Failed to fetch commits for PR #${prNumber}:`, err);
    return { valid: false, status: 502, error: `Unable to verify commit against PR #${prNumber}` };
  }
}

export async function checkUserRepoAccess(targetOwner: string, targetRepo: string, requestingUser: string, existingOctokit?: Awaited<ReturnType<typeof getAuthenticatedOctokit>>): Promise<{ allowed: true } | { allowed: false; status: number; error: string }> {
  const octokit = existingOctokit ?? await getAuthenticatedOctokit();
  try {
    const { data: permissionData } = await octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
      owner: targetOwner,
      repo: targetRepo,
      username: requestingUser
    });
    const permission = permissionData.permission;
    if (permission !== 'admin' && permission !== 'write' && permission !== 'maintain') {
      return { allowed: false, status: 403, error: `User '${requestingUser}' does not have write access to ${targetOwner}/${targetRepo}` };
    }
    return { allowed: true };
  } catch (scopeError) {
    const err = scopeError as { status?: number; message?: string };
    // GitHub returns 404 when the user is not a collaborator or the repo doesn't exist,
    // and 403 when the app lacks permission to check collaborators on the repo.
    // Both indicate an authorization problem, not a server error.
    if (err.status === 404 || err.status === 403) {
      return { allowed: false, status: 403, error: `User '${requestingUser}' does not have access to ${targetOwner}/${targetRepo}` };
    }
    console.error(`[revert] Failed to verify user scope for ${requestingUser} on ${targetOwner}/${targetRepo}:`, scopeError);
    return { allowed: false, status: 502, error: `Unable to verify user access to ${targetOwner}/${targetRepo}` };
  }
}

/**
 * Verify that the GitHub App installation can access a repository.
 * For fork PRs, the app may only be installed on the base repo/org,
 * not on the contributor's fork, making push operations impossible.
 */
export async function verifyAppRepoAccess(targetOwner: string, targetRepo: string, existingOctokit?: Awaited<ReturnType<typeof getAuthenticatedOctokit>>): Promise<{ accessible: true } | { accessible: false; status: number; error: string }> {
  const octokit = existingOctokit ?? await getAuthenticatedOctokit();
  try {
    await octokit.request('GET /repos/{owner}/{repo}', {
      owner: targetOwner,
      repo: targetRepo
    });
    return { accessible: true };
  } catch (repoError) {
    const err = repoError as { status?: number; message?: string };
    if (err.status === 404 || err.status === 403) {
      return {
        accessible: false,
        status: 422,
        error: `GitHub App does not have access to fork repository ${targetOwner}/${targetRepo} — the app must be installed on the fork for revert operations`
      };
    }
    console.error(`[revert] Failed to verify app access to ${targetOwner}/${targetRepo}:`, repoError);
    return { accessible: false, status: 502, error: `Unable to verify app access to ${targetOwner}/${targetRepo}` };
  }
}

export function buildRevertJobData(params: {
  owner: string;
  repo: string;
  prNumber: number;
  commit: string;
  targetCommentId: number;
  requestingUser: string;
  systemTaskSecret: string;
  branch: string;
  isFork: boolean;
  headRepoOwner: string;
  headRepoName: string;
}): SystemTaskJobData {
  const { owner, repo, prNumber, commit, targetCommentId, requestingUser, systemTaskSecret, branch, isFork, headRepoOwner, headRepoName } = params;
  const correlationId = generateCorrelationId();
  const authTimestamp = Date.now();

  const tokenFields: Parameters<typeof generateAuthToken>[0] = {
    type: 'revert',
    owner,
    repoName: repo,
    prNumber,
    requestingUser,
    commitHash: commit,
    targetCommentId,
    prBranch: branch,
    authTimestamp,
    ...(isFork ? { headRepoOwner, headRepoName } : {})
  };
  const authToken = generateAuthToken(tokenFields, systemTaskSecret);

  return {
    type: 'revert',
    repoName: repo,
    prNumber,
    commitHash: commit,
    targetCommentId,
    prBranch: branch,
    owner,
    correlationId,
    requestingUser,
    authToken,
    authTimestamp,
    ...(isFork ? { headRepoOwner, headRepoName } : {})
  };
}
