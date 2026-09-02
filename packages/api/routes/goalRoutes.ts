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
  type Goal,
  type RepoToMonitor,
} from '@propr/core';
import {
  GOAL_ERROR_CODES,
  GOAL_EVENT_MAX_LIMIT,
  GOAL_IDEMPOTENCY_KEY_MAX_LENGTH,
  GOAL_IDENTIFIER_MAX_LENGTH,
  GOAL_LIST_MAX_LIMIT,
  GOAL_MESSAGE_BODY_MAX_LENGTH,
  GOAL_REASON_MAX_LENGTH,
  GOAL_SEARCH_MAX_LENGTH,
  GOAL_STATES,
  GOAL_EVENT_KINDS,
  type GoalState,
} from '@propr/shared';
import type { Knex } from 'knex';
import { isDemoMode } from '../demoMode.js';
import {
  normalizeCreateGoalInput,
  validateCreateGoalConfiguration,
  validateGoalAgentModel,
} from './goalRouteValidation.js';
import {
  toPublicGoal,
  toPublicGoalDetail,
  toPublicGoalEvent,
  toPublicGoalMessage,
} from './goalRouteDtos.js';

interface GoalRoutesDeps {
  db?: Knex;
  /** Optional low-latency hint to the SQL-backed goal supervisor. */
  goalWake?: (goalId: string) => void | Promise<void>;
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

/** Canonical header with a documented body fallback for older typed clients. */
function resolveIdempotencyKey(req: Request): string {
  const header = req.header('Idempotency-Key');
  const body = req.body as { idempotencyKey?: unknown } | undefined;
  const candidate = header !== undefined ? header : body?.idempotencyKey;
  if (typeof candidate === 'string') {
    const normalized = candidate.trim();
    if (normalized && Array.from(normalized).length <= GOAL_IDEMPOTENCY_KEY_MAX_LENGTH) {
      return normalized;
    }
  }
  throw new GoalError(
    GOAL_ERROR_CODES.invalidIdempotencyKey,
    `Idempotency-Key must contain between 1 and ${GOAL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    400
  );
}

function boundedOptionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a string`, 400);
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxLength) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must contain between 1 and ${maxLength} characters`, 400);
  }
  return normalized;
}

function parseLimit(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${max}`, 400);
  }
  return limit;
}

function parseExpectedVersion(req: Request): number | undefined {
  const body = req.body as { expectedVersion?: unknown } | undefined;
  const header = req.header('If-Match');
  const bodyVersion = body?.expectedVersion === undefined
    ? undefined
    : parseVersionNumber(body.expectedVersion, 'expectedVersion');
  const headerVersion = header === undefined
    ? undefined
    : parseIfMatchVersion(header);
  if (bodyVersion !== undefined && headerVersion !== undefined && bodyVersion !== headerVersion) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      'expectedVersion and If-Match must agree',
      400
    );
  }
  return headerVersion ?? bodyVersion;
}

function parseVersionNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `${field} must be a positive safe integer`, 400);
  }
  return value;
}

function parseIfMatchVersion(value: string): number {
  const match = value.match(/^\s*(?:"([1-9]\d*)"|([1-9]\d*))\s*$/);
  if (!match) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'If-Match must contain one positive integer version', 400);
  }
  return parseVersionNumber(Number(match[1] ?? match[2]), 'If-Match');
}

export function createGoalRoutes(deps: GoalRoutesDeps = {}) {
  const db = deps.db ?? sharedDb;
  const lifecycle = new GoalLifecycleService(db);
  const repository = lifecycle.repository;
  const loadAgentsFn = deps.services?.loadAgents ?? loadAgents;
  const loadRepositoriesFn = deps.services?.loadRepositories ?? loadMonitoredReposRaw;

  async function signalGoal(goalId: string): Promise<void> {
    try {
      await deps.goalWake?.(goalId);
    } catch (error) {
      // The committed SQL row is itself the durable wake-up source. Surface the
      // transient hint failure operationally without turning a successful,
      // replayable create into a misleading HTTP failure.
      console.error('Goal wake hint failed; startup scan will recover it:', error);
    }
  }

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
      const idempotencyKey = resolveIdempotencyKey(req);
      const result = normalizeCreateGoalInput((req.body ?? {}) as Record<string, unknown>, userId);
      if (!result.ok) {
        res.status(result.status).json({ code: result.code, error: result.error });
        return;
      }
      const input = { ...result.input, idempotencyKey };
      const replay = await repository.readCreateGoalReplay(input);
      if (replay) {
        await signalGoal(replay.goalId);
        res.status(201).json({ goal: toPublicGoal(replay) });
        return;
      }
      const configurationError = await validateCreateGoalConfiguration(result.input, {
        loadAgents: loadAgentsFn, loadRepositories: loadRepositoriesFn,
      });
      if (configurationError) {
        res.status(configurationError.status).json({ code: configurationError.code, error: configurationError.error });
        return;
      }
      const goal = await repository.createGoal(input);
      // The durable queued row is already committed. A failed/missing wake does
      // not lose work because the supervisor startup/interval scan reads SQL.
      await signalGoal(goal.goalId);
      res.status(201).json({ goal: toPublicGoal(goal) });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function listGoals(req: Request, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      const repositoryFilter =
        boundedOptionalText(req.query.repository, 'repository', GOAL_IDENTIFIER_MAX_LENGTH);
      const stateFilter =
        typeof req.query.state === 'string' &&
        GOAL_STATES.includes(req.query.state as GoalState)
          ? (req.query.state as GoalState)
          : undefined;
      if (req.query.state !== undefined && !stateFilter) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.validation,
          error: `state must be one of: ${GOAL_STATES.join(', ')}`,
        });
        return;
      }
      if (req.query.page !== undefined) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'page is not supported; use cursor keyset pagination', 400);
      }
      const limit = parseLimit(req.query.limit, GOAL_LIST_MAX_LIMIT);
      if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') {
        throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400);
      }
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
      const search = boundedOptionalText(req.query.search, 'search', GOAL_SEARCH_MAX_LENGTH);

      const listOptions = { repository: repositoryFilter, state: stateFilter, search, limit, cursor };
      const result = await (isDemoMode()
        ? repository.listGoals({ visibility: 'all-demo', ...listOptions })
        : repository.listGoals({ visibility: 'owner', ownerUserId: userId, ...listOptions }));
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
      res.json(toPublicGoalDetail(detail));
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  function mutation(
    handler: (
      goalId: string,
      options: { expectedVersion?: number; reason?: string; idempotencyKey: string }
    ) => Promise<Goal>
  ) {
    return async (req: FlatRequest, res: Response): Promise<void> => {
      const userId = requireUserId(req, res);
      if (!userId) return;
      try {
        await ensureOwnedGoal(req.params.goalId, userId);
        const idempotencyKey = resolveIdempotencyKey(req);
        const body = (req.body ?? {}) as { reason?: unknown };
        const goal = await handler(req.params.goalId, {
          expectedVersion: parseExpectedVersion(req),
          reason: boundedOptionalText(body.reason, 'reason', GOAL_REASON_MAX_LENGTH),
          idempotencyKey,
        });
        res.json({ goal: toPublicGoal(goal) });
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
      const idempotencyKey = resolveIdempotencyKey(req);
      const goal = await repository.requireGoal(req.params.goalId);
      const body = (req.body ?? {}) as { model?: unknown; reason?: unknown };
      const requestedModel = boundedOptionalText(body.model, 'model', GOAL_IDENTIFIER_MAX_LENGTH);
      if (!requestedModel) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'model is required', 400);
      }
      const expectedVersion = parseExpectedVersion(req);
      const reason = boundedOptionalText(body.reason, 'reason', GOAL_REASON_MAX_LENGTH);
      const replay = await repository.readModelChangeReplay(
        req.params.goalId, requestedModel, { expectedVersion, reason, idempotencyKey }
      );
      if (replay) {
        res.json({ goal: toPublicGoal(replay) });
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
          expectedVersion,
          reason,
          idempotencyKey,
        }
      );
      res.json({ goal: toPublicGoal(updated) });
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
      const messageBody = boundedOptionalText(body.body, 'body', GOAL_MESSAGE_BODY_MAX_LENGTH) ?? '';
      const predefinedKind = boundedOptionalText(
        body.predefinedKind,
        'predefinedKind',
        GOAL_IDENTIFIER_MAX_LENGTH
      ) ?? null;
      const idempotencyKey = resolveIdempotencyKey(req);
      const message = await repository.enqueueMessage(req.params.goalId, {
        body: messageBody,
        predefinedKind,
        idempotencyKey,
      });
      res.status(201).json({ message: toPublicGoalMessage(message) });
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
      const afterSequence = afterRaw === undefined ? undefined
        : typeof afterRaw === 'string' && /^\d+$/.test(afterRaw) ? Number(afterRaw) : Number.NaN;
      if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.invalidCursor,
          error: 'afterSequence must be a non-negative integer',
        });
        return;
      }
      const limit = parseLimit(req.query.limit, GOAL_EVENT_MAX_LIMIT);
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
        limit,
        kind,
      });
      res.json({
        events: result.events.map(toPublicGoalEvent),
        nextCursor: result.nextCursor,
      });
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
