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
