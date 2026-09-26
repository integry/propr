import type { Request, Response } from 'express';
import { Octokit } from '@octokit/core';
import { refreshGitHubTokenWithResult } from './authGithubTokens.js';
import {
  githubUserGrantService,
  type GitHubUserGrantResolution,
  type GitHubUserGrantService,
} from './githubUserGrantService.js';

export class GitHubMetadataAuthorizationError extends Error {
  constructor(
    public readonly code: 'GITHUB_AUTHORIZATION_REQUIRED' | 'GITHUB_REAUTH_REQUIRED' | 'GITHUB_AUTHORIZATION_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'GitHubMetadataAuthorizationError';
  }
}

function errorForGrant(result: GitHubUserGrantResolution): GitHubMetadataAuthorizationError {
  if (result.status === 'missing') {
    return new GitHubMetadataAuthorizationError(
      'GITHUB_AUTHORIZATION_REQUIRED',
      'GitHub authorization is required for repository access. Sign in to this ProPR instance in a browser, then retry from the desktop app.',
    );
  }
  if (result.status === 'temporarily_unavailable') {
    return new GitHubMetadataAuthorizationError(
      'GITHUB_AUTHORIZATION_UNAVAILABLE',
      'GitHub authorization could not be refreshed right now. Please retry shortly.',
    );
  }
  return new GitHubMetadataAuthorizationError(
    'GITHUB_REAUTH_REQUIRED',
    'GitHub authorization has expired or was revoked. Sign in to this ProPR instance again in a browser, then retry from the desktop app.',
  );
}

export async function resolveGitHubMetadataToken(
  req: Request,
  service: Pick<GitHubUserGrantService, 'resolve'> = githubUserGrantService,
  forceRefresh = false,
): Promise<string> {
  const sessionToken = req.user?.accessToken?.trim();
  if (sessionToken) return sessionToken;
  if (req.authenticationMethod !== 'instance_token' || !req.user?.id) {
    throw new GitHubMetadataAuthorizationError(
      'GITHUB_AUTHORIZATION_REQUIRED',
      'No GitHub access token is available. Sign in with GitHub and try again.',
    );
  }
  const result = await service.resolve(req.user.id, forceRefresh);
  if (result.status !== 'active') throw errorForGrant(result);
  return result.accessToken;
}

/** Verify repository-level user authority before an installation token is used for cloning or execution. */
export async function verifyGitHubRepositoryAccess(
  repository: string,
  accessToken: string,
  createOctokit: (token: string) => Octokit = token => new Octokit({ auth: token }),
): Promise<void> {
  const [owner, repo, extra] = repository.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid repository format');
  await createOctokit(accessToken).request('GET /repos/{owner}/{repo}', { owner, repo });
}

export function sendGitHubMetadataAuthorizationError(
  error: GitHubMetadataAuthorizationError,
  res: Response,
): void {
  const status = error.code === 'GITHUB_AUTHORIZATION_UNAVAILABLE' ? 503 : 403;
  res.status(status).json({ error: error.message, code: error.code, message: error.message });
}

export async function handleGitHubRepositoryAccessError(
  req: Request,
  res: Response,
  error: unknown,
): Promise<boolean> {
  if (error instanceof GitHubMetadataAuthorizationError) {
    sendGitHubMetadataAuthorizationError(error, res);
    return true;
  }
  const status = (error as { status?: number })?.status;
  if (status === 401) {
    await refreshRejectedGitHubMetadataToken(req, res);
    return true;
  }
  if (status === 403 || status === 404) {
    res.status(404).json({ error: 'Repository not found or not accessible', code: 'REPOSITORY_NOT_ACCESSIBLE' });
    return true;
  }
  return false;
}

export async function refreshRejectedGitHubMetadataToken(req: Request, res: Response): Promise<void> {
  if (req.authenticationMethod !== 'instance_token') {
    const result = await refreshGitHubTokenWithResult(req, true);
    if (result.status === 'refreshed') {
      res.status(401).json({ error: 'Token refreshed', code: 'TOKEN_REFRESHED', message: 'Your GitHub token has been refreshed. Please retry your request.' });
      return;
    }
    if (result.status === 'temporarily-unavailable') {
      sendGitHubMetadataAuthorizationError(errorForGrant({ status: 'temporarily_unavailable' }), res);
      return;
    }
    sendGitHubMetadataAuthorizationError(errorForGrant({ status: 'reauth_required' }), res);
    return;
  }
  try {
    await resolveGitHubMetadataToken(req, githubUserGrantService, true);
    res.status(401).json({ error: 'Token refreshed', code: 'TOKEN_REFRESHED', message: 'Your GitHub authorization was refreshed. Please retry your request.' });
  } catch (error) {
    if (error instanceof GitHubMetadataAuthorizationError) {
      sendGitHubMetadataAuthorizationError(error, res);
      return;
    }
    throw error;
  }
}
