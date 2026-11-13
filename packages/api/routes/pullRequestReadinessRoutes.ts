/**
 * `GET /api/pull-requests/:number/readiness`: the read-only readiness verdict
 * of one pull request. A thin wrapper around core's
 * `evaluatePullRequestReadiness`, which never writes to GitHub or Redis and
 * never changes auto-merge state. Errors answer with the `ErrorEnvelope`.
 *
 * The evaluation reads with the ProPR GitHub App identity, which can see
 * repositories the caller cannot, so the caller's own GitHub read access to
 * the repository is proven first (as MCP `get_pull_request_readiness` and the
 * repository-event routes do); a caller without it gets
 * `REPOSITORY_NOT_ACCESSIBLE` and the App is never consulted.
 */
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  PullRequestReadinessUnavailableError,
  evaluatePullRequestReadiness,
  type PullRequestReadiness,
  type PullRequestReadinessDeps,
} from '@propr/core';
import {
  handleGitHubRepositoryAccessError,
  resolveGitHubMetadataToken,
  verifyGitHubRepositoryAccess,
} from '../githubMetadataAuth.js';
import { loadPullRequestScores } from './reviewScoreStats.js';
import { validateRepository } from './validation.js';

export type ReadinessEvaluator = (owner: string, repo: string, prNumber: number, deps: PullRequestReadinessDeps) => Promise<PullRequestReadiness>;

/** The score loader projection the readiness evaluation reads its AI review from. */
export function readinessReviewScores(db: Knex): PullRequestReadinessDeps['loadReviewScores'] {
  return async (repository, prNumber) => (await loadPullRequestScores(db, repository, prNumber)).scores;
}

export interface ReadinessFailure { status: number; code: string; message: string; hint?: string }

/** Map an evaluation failure to an `ErrorEnvelope` status and code; shared by REST and MCP. */
export function readinessFailure(error: unknown): ReadinessFailure {
  if (error instanceof PullRequestReadinessUnavailableError) {
    if (error.status === 404) {
      return { status: 404, code: 'PULL_REQUEST_NOT_FOUND', message: 'The pull request does not exist, or the ProPR GitHub App cannot see it.' };
    }
    return { status: 502, code: 'GITHUB_UNAVAILABLE', message: 'GitHub did not return the pull request.', hint: 'Retry; the read has no side effects.' };
  }
  return { status: 500, code: 'READINESS_FAILED', message: 'Failed to evaluate pull request readiness.' };
}

interface PullRequestReadinessRoutesDeps {
  db: Knex;
  evaluate?: ReadinessEvaluator;
  /** Proves the caller can read the repository on GitHub; throws a GitHub-status error otherwise. */
  verifyAccess?: (req: Request, repository: string) => Promise<void>;
}

const defaultVerifyAccess = async (req: Request, repository: string) =>
  verifyGitHubRepositoryAccess(repository, await resolveGitHubMetadataToken(req));

/**
 * Prove the caller's own GitHub read access before the App identity is used.
 * Answers and returns false when access is not established.
 */
async function callerCanRead(req: Request, res: Response, repository: string, verifyAccess: NonNullable<PullRequestReadinessRoutesDeps['verifyAccess']>): Promise<boolean> {
  try {
    await verifyAccess(req, repository);
    return true;
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 403 || status === 404) {
      res.status(404).json({ code: 'REPOSITORY_NOT_ACCESSIBLE', message: 'Repository not found or not accessible' });
      return false;
    }
    if (await handleGitHubRepositoryAccessError(req, res, error)) return false;
    if (typeof status === 'number' && status >= 500) {
      res.status(502).json({ code: 'GITHUB_UNAVAILABLE', message: 'GitHub could not be reached to check repository access.', hint: 'Retry; the read has no side effects.' });
      return false;
    }
    console.error('Error checking repository access for /api/pull-requests/:number/readiness:', error);
    res.status(500).json({ code: 'READINESS_FAILED', message: 'Failed to check repository access.' });
    return false;
  }
}

export function createPullRequestReadinessRoutes({ db, evaluate = evaluatePullRequestReadiness, verifyAccess = defaultVerifyAccess }: PullRequestReadinessRoutesDeps) {
  const loadReviewScores = readinessReviewScores(db);

  async function getReadiness(req: Request, res: Response): Promise<void> {
    const prNumber = Number(req.params.number);
    if (!/^\d+$/.test(String(req.params.number)) || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      res.status(400).json({ code: 'INVALID_INPUT', message: 'Pull request number must be a positive integer.' });
      return;
    }
    const validation = validateRepository(req.query.repository);
    if (!validation.valid) {
      res.status(400).json({ code: 'INVALID_INPUT', message: validation.error ?? 'repository must be owner/repo.' });
      return;
    }
    const [owner, repo] = String(req.query.repository).trim().split('/');
    if (!await callerCanRead(req, res, `${owner}/${repo}`, verifyAccess)) return;
    try {
      res.json(await evaluate(owner, repo, prNumber, { loadReviewScores }));
    } catch (error) {
      const failure = readinessFailure(error);
      if (failure.status === 500) console.error('Error in /api/pull-requests/:number/readiness:', error);
      res.status(failure.status).json({ code: failure.code, message: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) });
    }
  }

  return { getReadiness };
}
