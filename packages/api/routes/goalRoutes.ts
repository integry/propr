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
  GOAL_EVENT_MAX_BYTES,
  GOAL_IDENTIFIER_MAX_LENGTH,
  GOAL_LIST_MAX_LIMIT,
  GOAL_MESSAGE_BODY_MAX_LENGTH,
  GOAL_MESSAGE_MAX_LIMIT,
  GOAL_CANNED_ACTIONS,
  GOAL_CHECKLIST_MAX_LIMIT,
  GOAL_REASON_MAX_LENGTH,
  GOAL_SEARCH_MAX_LENGTH,
  GOAL_STATES,
  GOAL_EVENT_KINDS,
  type GoalState,
  type GoalCannedAction,
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
import {
  boundedOptionalText, parseExpectedVersion, parseLimit, requireUserId,
  resolveIdempotencyKey, sendGoalError,
} from './goalRouteRequest.js';

interface GoalRoutesDeps {
  db?: Knex;
  services?: {
    loadAgents?: () => Promise<AgentConfig[]>;
    loadRepositories?: () => Promise<RepoToMonitor[]>;
  };
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
    const repositories = await loadRepositoriesFn();
    if (!repositories.some(entry => entry.name === goal.repository && entry.enabled)) {
      throw new GoalError(GOAL_ERROR_CODES.repositoryForbidden, 'Repository access was revoked', 403);
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
      const configurationError = await validateCreateGoalConfiguration(result.input, {
        loadAgents: loadAgentsFn, loadRepositories: loadRepositoriesFn,
      });
      if (configurationError) {
        res.status(configurationError.status).json({ code: configurationError.code, error: configurationError.error });
        return;
      }
      const replay = await repository.readCreateGoalReplay(input);
      if (replay) {
        res.status(201).json({ goal: toPublicGoal(replay) });
        return;
      }
      const goal = await repository.createGoal(input);
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
      const enabledRepositories = new Set((await loadRepositoriesFn())
        .filter(entry => entry.enabled).map(entry => entry.name));
      if (repositoryFilter && !enabledRepositories.has(repositoryFilter)) {
        throw new GoalError(GOAL_ERROR_CODES.repositoryForbidden, 'Repository access was revoked', 403);
      }
      const result = await (isDemoMode()
        ? repository.listGoals({ visibility: 'all-demo', ...listOptions })
        : repository.listGoals({ visibility: 'owner', ownerUserId: userId, ...listOptions }));
      res.json({ ...result, goals: result.goals.filter(goal => enabledRepositories.has(goal.repository)) });
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
        cannedAction?: unknown;
      };
      const messageBody = boundedOptionalText(body.body, 'body', GOAL_MESSAGE_BODY_MAX_LENGTH);
      const rawAction = body.cannedAction ?? body.predefinedKind;
      const cannedAction = rawAction === undefined || rawAction === null ? null
        : typeof rawAction === 'string' && GOAL_CANNED_ACTIONS.includes(rawAction as GoalCannedAction)
          ? rawAction as GoalCannedAction
          : (() => { throw new GoalError(GOAL_ERROR_CODES.validation, 'cannedAction is not recognized', 400); })();
      if (!messageBody && !cannedAction) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'body or cannedAction is required', 400);
      }
      if (messageBody && cannedAction) {
        throw new GoalError(GOAL_ERROR_CODES.validation, 'body and cannedAction are mutually exclusive', 400);
      }
      const idempotencyKey = resolveIdempotencyKey(req);
      const message = await repository.enqueueMessage(req.params.goalId, {
        body: messageBody ?? '',
        cannedAction,
        authorUserId: userId,
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
      const afterRaw = req.query.afterSequence;
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
      const maxBytes = parseLimit(req.query.maxBytes, GOAL_EVENT_MAX_BYTES);
      const cursor = req.query.cursor === undefined ? null
        : typeof req.query.cursor === 'string' ? req.query.cursor
          : (() => { throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400); })();
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      if (kind !== undefined && !GOAL_EVENT_KINDS.includes(kind as (typeof GOAL_EVENT_KINDS)[number])) {
        res.status(400).json({
          code: GOAL_ERROR_CODES.invalidEventKind,
          error: `kind must be one of: ${GOAL_EVENT_KINDS.join(', ')}`,
        });
        return;
      }
      const result = await repository.readEventPage(req.params.goalId, {
        cursor,
        afterSequence,
        limit,
        maxBytes,
        kind,
      });
      res.json({
        schemaVersion: 1,
        events: result.events.map(toPublicGoalEvent),
        nextCursor: result.nextCursor,
        asOfSequence: result.asOfSequence,
      });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function readMessages(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const cursor = req.query.cursor === undefined ? null
        : typeof req.query.cursor === 'string' ? req.query.cursor
          : (() => { throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400); })();
      const limit = parseLimit(req.query.limit, GOAL_MESSAGE_MAX_LIMIT);
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const result = await repository.readMessagePage(req.params.goalId, { cursor, limit, state });
      res.json({
        schemaVersion: 1,
        messages: result.messages.map(toPublicGoalMessage),
        nextCursor: result.nextCursor,
        asOfSequence: result.asOfSequence,
      });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function cancelMessage(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      // Cancellation has its own stable message identity; the header is still
      // required so every public mutation follows the same retry contract.
      resolveIdempotencyKey(req);
      const messageId = boundedOptionalText(req.params.messageId, 'messageId', GOAL_IDENTIFIER_MAX_LENGTH);
      if (!messageId) throw new GoalError(GOAL_ERROR_CODES.validation, 'messageId is required', 400);
      const message = await repository.cancelMessage(req.params.goalId, messageId, userId);
      res.json({ message: toPublicGoalMessage(message) });
    } catch (error) {
      sendGoalError(res, error);
    }
  }

  async function readChecklist(req: FlatRequest, res: Response): Promise<void> {
    const userId = requireUserId(req, res);
    if (!userId) return;
    try {
      await ensureOwnedGoal(req.params.goalId, userId);
      const cursor = req.query.cursor === undefined ? null
        : typeof req.query.cursor === 'string' ? req.query.cursor
          : (() => { throw new GoalError(GOAL_ERROR_CODES.invalidCursor, 'Goal cursor is invalid', 400); })();
      const limit = parseLimit(req.query.limit, GOAL_CHECKLIST_MAX_LIMIT);
      const page = await repository.withReadSnapshot(async snapshot => {
        const nodes = await snapshot.readNodePage(req.params.goalId, { cursor, limit });
        const asOfSequence = await snapshot.getLatestSequence(req.params.goalId);
        return { ...nodes, asOfSequence };
      });
      res.json({
        schemaVersion: 1,
        nodes: page.nodes.map(node => ({
          nodeId: node.nodeId, goalId: node.goalId, parentNodeId: node.parentNodeId,
          kind: node.kind, externalRef: node.externalRef, externalKind: node.externalKind,
          title: node.title, status: node.status, orderIndex: node.orderIndex,
          createdAt: node.createdAt, updatedAt: node.updatedAt,
        })),
        nextCursor: page.nextCursor,
        asOfSequence: page.asOfSequence,
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
    readMessages,
    cancelMessage,
    readChecklist,
    readEvents,
  };
}
