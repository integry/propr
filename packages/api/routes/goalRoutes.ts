/**
 * Authenticated goal control-plane API under /api/goals.
 *
 * Every route is ownership-checked: a goal belongs to the authenticated user
 * and is never exposed to another. Creation additionally validates repository
 * access, a goal-capable agent/model catalog selection, concurrency bounds, and
 * Ultrafix settings. Mutations accept an optimistic version precondition and an
 * idempotency key; conflicts return stable machine-readable codes the UI can
 * branch on. Responses never include credential paths, tokens, or container
 * mounts. Demo mode is read-only (mutations are rejected before reaching here by
 * the shared middleware, and reads fall back to unfiltered ownership).
 */

import type { Request, Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import {
  db as sharedDb,
  GoalError,
  GoalLifecycleService,
  loadAgents,
  loadMonitoredReposRaw,
  type AgentConfig,
  type RepoToMonitor,
} from '@propr/core';
import {
  GOAL_ERROR_CODES,
  GOAL_STATES,
  GOAL_EVENT_KINDS,
  type GoalState,
} from '@propr/shared';
import type { Knex } from 'knex';
import { isDemoMode } from '../demoMode.js';
import {
  validateCreateGoalInput,
  validateGoalAgentModel,
} from './goalRouteValidation.js';

interface GoalRoutesDeps {
  db?: Knex;
  services?: {
    loadAgents?: () => Promise<AgentConfig[]>;
    loadRepositories?: () => Promise<RepoToMonitor[]>;
  };
}

function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ code: 'unauthenticated', error: 'User not authenticated' });
    return null;
  }
  return userId;
}

function sendGoalError(res: Response, error: unknown): void {
  if (error instanceof GoalError) {
    res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  console.error('Goal route failure:', error);
  res.status(500).json({ code: 'goal_internal_error', error: 'Internal server error' });
}

/** The idempotency key comes from a header or the body, header taking priority. */
function resolveIdempotencyKey(req: Request): string | undefined {
  const header = req.header('Idempotency-Key');
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  if (typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim().length > 0) {
    return body.idempotencyKey.trim();
  }
  return undefined;
}

function parseExpectedVersion(req: Request): number | undefined {
  const body = req.body as { expectedVersion?: unknown } | undefined;
  if (typeof body?.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)) {
    return body.expectedVersion;
  }
  const header = req.header('If-Match');
  if (header) {
    const parsed = Number(header.replace(/"/g, '').trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  if (body?.expectedVersion !== undefined || header !== undefined) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'expectedVersion must be an integer', 400);
  }
  return undefined;
}

export function createGoalRoutes(deps: GoalRoutesDeps = {}) {
  const db = deps.db ?? sharedDb;
  const lifecycle = new GoalLifecycleService(db);
  const repository = lifecycle.repository;
  const loadAgentsFn = deps.services?.loadAgents ?? loadAgents;
  const loadRepositoriesFn = deps.services?.loadRepositories ?? loadMonitoredReposRaw;

  /**
   * Confirm the goal exists and belongs to the caller. Not-found and
   * cross-owner access both surface as goal_not_found so ownership is never
   * disclosed by a differing status (except in demo mode, which is read-only
   * and shares resources).
   */
  async function ensureOwnedGoal(
    goalId: string,
    userId: string
  ): Promise<void> {
    const goal = await repository.getGoal(goalId);
    if (!goal || (!isDemoMode() && goal.ownerUserId !== userId)) {
      throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    }
  }

  async function createGoal(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const result = await validateCreateGoalInput(
        (req.body ?? {}) as Record<string, unknown>,
        userId,
        { loadAgents: loadAgentsFn, loadRepositories: loadRepositoriesFn }
      );
      if (!result.ok) {
        res.status(result.status).json({ code: result.code, error: result.error });
        return;
      }
      const goal = await repository.createGoal({
        ...result.input,
        idempotencyKey: resolveIdempotencyKey(req),
      });
      res.status(201).json({ goal });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function listGoals(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const repositoryFilter =
        typeof req.query.repository === 'string' ? req.query.repository : undefined;
      const stateFilter =
        typeof req.query.state === 'string' &&
        GOAL_STATES.includes(req.query.state as GoalState)
          ? (req.query.state as GoalState)
          : undefined;
      if (typeof req.query.state === 'string' && !stateFilter) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.validation,
          error: `state must be one of: ${GOAL_STATES.join(', ')}`,
        });
        return;
      }
      const limit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

      const result = await repository.listGoals({
        // In demo mode all goals share the demo user, matching read-only semantics.
        ownerUserId: userId,
        repository: repositoryFilter,
        state: stateFilter,
        limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
        cursor,
      });
      res.json(result);
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function getGoal(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const detail = await lifecycle.getDetail(req.params.goalId);
      res.json(detail);
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  function mutation(
    handler: (
      goalId: string,
      options: { expectedVersion?: number; reason?: string; idempotencyKey?: string }
    ) => Promise<unknown>
  ) {
    return async (req: FlatRequest, res: Response): Promise<void> => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      try {
        await ensureOwnedGoal(req.params.goalId, userId);
        const body = (req.body ?? {}) as { reason?: unknown };
        const goal = await handler(req.params.goalId, {
          expectedVersion: parseExpectedVersion(req),
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        res.json({ goal });
      } catch (error) {
        sendGoalError(res, error);
      }
    };
  }

  const pauseGoal = mutation((goalId, options) => lifecycle.pause(goalId, options));
  const resumeGoal = mutation((goalId, options) => lifecycle.resume(goalId, options));
  const cancelGoal = mutation((goalId, options) => lifecycle.cancel(goalId, options));

  async function requestModelChange(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const goal = await repository.requireGoal(req.params.goalId);
      const body = (req.body ?? {}) as { model?: unknown; reason?: unknown };
      const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
      if (!requestedModel) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.validation,
          error: 'model is required',
        });
        return;
      }
      // Validate against the goal's agent catalog so an unusable model cannot
      // be requested.
      const catalogError = await validateGoalAgentModel(goal.agent, requestedModel, loadAgentsFn);
      if (catalogError) {
        res.status(catalogError.status).json({
          code: catalogError.code,
          error: catalogError.error,
        });
        return;
      }
      const updated = await repository.requestModelChange(
        req.params.goalId,
        requestedModel,
        {
          expectedVersion: parseExpectedVersion(req),
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          idempotencyKey: resolveIdempotencyKey(req),
        }
      );
      res.json({ goal: updated });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function enqueueMessage(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const body = (req.body ?? {}) as {
        body?: unknown;
        predefinedKind?: unknown;
      };
      const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
      const predefinedKind =
        typeof body.predefinedKind === 'string' ? body.predefinedKind.trim() : null;
      if (!messageBody) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.validation,
          error: 'body is required',
        });
        return;
      }
      const idempotencyKey = resolveIdempotencyKey(req);
      if (!idempotencyKey) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.validation,
          error: 'An Idempotency-Key is required to enqueue a message',
        });
        return;
      }
      const message = await repository.enqueueMessage(req.params.goalId, {
        body: messageBody,
        predefinedKind,
        idempotencyKey,
      });
      res.status(201).json({ message });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function readEvents(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const afterRaw = req.query.afterSequence ?? req.query.cursor;
      const afterSequence =
        typeof afterRaw === 'string' && afterRaw.length > 0
          ? Number(afterRaw)
          : undefined;
      if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.invalidCursor,
          error: 'afterSequence must be a non-negative integer',
        });
        return;
      }
      const limit =
        typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      if (kind !== undefined && !GOAL_EVENT_KINDS.includes(kind as (typeof GOAL_EVENT_KINDS)[number])) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.invalidEventKind,
          error: `kind must be one of: ${GOAL_EVENT_KINDS.join(', ')}`,
        });
        return;
      }
      const result = await repository.readEvents(req.params.goalId, {
        afterSequence,
        limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
        kind,
      });
      res.json(result);
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  return {
    createGoal,
    listGoals,
    getGoal,
    pauseGoal,
    resumeGoal,
    cancelGoal,
    requestModelChange,
    enqueueMessage,
    readEvents,
  };
}
