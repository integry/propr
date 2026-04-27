import { getUserWhitelist, getAuthenticatedOctokit } from '@propr/core';
import { validatePositiveInteger } from './validation.js';

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

  if (typeof repo !== 'string' || repo.length > 100) {
    return { valid: false, error: 'Invalid repo name' };
  }

  if (typeof owner !== 'string' || owner.length > 100) {
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

  if (typeof owner !== 'string' || owner.length > 100) {
    return { valid: false, error: 'Invalid owner name' };
  }

  if (typeof repo !== 'string' || repo.length > 100) {
    return { valid: false, error: 'Invalid repo name' };
  }

  if (typeof commit !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commit)) {
    return { valid: false, error: 'Invalid commit hash' };
  }

  return { valid: true, params: { owner, repo, pr, commit } };
}

export interface AuthorizationResult {
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

export interface PrLookupResult {
  success: true;
  prData: {
    head: { ref: string; repo?: { owner?: { login?: string }; name?: string; full_name?: string } | null };
    base: { ref: string; repo?: { full_name?: string } | null };
  };
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
    return { success: true, prData: response.data };
  } catch (prLookupError) {
    const err = prLookupError as { status?: number; message?: string };
    if (err.status === 404) {
      return { success: false, status: 404, error: `PR #${pr} not found in ${owner}/${repo}` };
    }
    console.error(`[revert] Failed to fetch PR #${pr} from ${owner}/${repo}:`, prLookupError);
    return { success: false, status: 502, error: `Unable to fetch PR #${pr} from GitHub` };
  }
}

export async function checkUserRepoAccess(targetOwner: string, targetRepo: string, requestingUser: string): Promise<{ allowed: true } | { allowed: false; status: number; error: string }> {
  const octokit = await getAuthenticatedOctokit();
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
    console.error(`[revert] Failed to verify user scope for ${requestingUser} on ${targetOwner}/${targetRepo}:`, scopeError);
    return { allowed: false, status: 403, error: `Unable to verify user access to ${targetOwner}/${targetRepo}` };
  }
}
