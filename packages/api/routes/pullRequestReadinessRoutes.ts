/**
 * `GET /api/pull-requests/:number/readiness`: the read-only readiness verdict
 * of one pull request. A thin wrapper around core's
 * `evaluatePullRequestReadiness`, which never writes to GitHub or Redis and
 * never changes auto-merge state. Errors answer with the `ErrorEnvelope`.
 */
import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  PullRequestReadinessUnavailableError,
  evaluatePullRequestReadiness,
  type PullRequestReadiness,
  type PullRequestReadinessDeps,
} from '@propr/core';
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
}

export function createPullRequestReadinessRoutes({ db, evaluate = evaluatePullRequestReadiness }: PullRequestReadinessRoutesDeps) {
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
