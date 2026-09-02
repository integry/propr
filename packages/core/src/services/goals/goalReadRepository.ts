import crypto from 'crypto';
import type { Knex } from 'knex';
import {
  GOAL_DEFAULT_MAX_ACTIVE_TASKS,
  GOAL_ERROR_CODES,
  GOAL_LIST_DEFAULT_LIMIT,
  GOAL_LIST_MAX_LIMIT,
  GOAL_MAX_MAX_ACTIVE_TASKS,
  GOAL_MERGE_POLICIES,
  GOAL_MIN_MAX_ACTIVE_TASKS,
  GOAL_OBJECTIVE_MAX_LENGTH,
  GOAL_SEARCH_MAX_LENGTH,
  GOAL_ULTRAFIX_GOAL_MAX,
  GOAL_ULTRAFIX_GOAL_MIN,
  GOAL_ULTRAFIX_MAX_CYCLES_MAX,
  GOAL_ULTRAFIX_MAX_CYCLES_MIN,
  isTerminalGoalState,
} from '@propr/shared';
import type {
  CreateGoalInput,
  Goal,
  GoalActiveTimeStats,
  GoalRecord,
  ListGoalsQuery,
  ListGoalsResult,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  characterLength,
  decodeCursor,
  encodeCursor,
  goalTransaction,
  idempotencyKey,
  nowIso,
  readIdempotentReplay,
  runIdempotent,
  toGoal,
  toSummary,
  type GoalSummaryRecord,
} from './goalRepositorySupport.js';

export class GoalReadRepository {
  constructor(private readonly db: Knex) {}

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const normalized = normalizeCreateInput(input);
    const goalId = normalized.goalId ?? crypto.randomUUID();
    const request = createIdempotencyRequest(normalized);
    const effect = (trx: Knex.Transaction) => this.insertGoal(trx, goalId, normalized);
    if (input.idempotencyKey === undefined) {
      return goalTransaction(this.db, effect);
    }
    return runIdempotent({
      db: this.db,
      ownerUserId: normalized.ownerUserId,
      operation: 'create',
      key: idempotencyKey(input.idempotencyKey),
      request,
      goalId,
      effect,
    });
  }

  async readCreateGoalReplay(input: CreateGoalInput): Promise<Goal | null> {
    const normalized = normalizeCreateInput(input);
    if (input.idempotencyKey === undefined) return null;
    return readIdempotentReplay<Goal>(this.db, {
      ownerUserId: normalized.ownerUserId,
      operation: 'create',
      key: input.idempotencyKey,
      request: createIdempotencyRequest(normalized),
    });
  }

  private async insertGoal(
    trx: Knex.Transaction,
    goalId: string,
    input: NormalizedCreateInput
  ): Promise<Goal> {
    const existing = await trx<GoalRecord>('goals').where('goal_id', goalId).first();
    if (existing) {
      throw new GoalError(GOAL_ERROR_CODES.idempotencyConflict, 'The requested goal identifier already exists', 409);
    }
    const now = nowIso();
    const record: GoalRecord = {
      goal_id: goalId,
      owner_user_id: input.ownerUserId,
      repository: input.repository,
      objective: input.objective,
      state: 'queued',
      agent: input.agent,
      requested_model: input.requestedModel,
      effective_model: input.effectiveModel,
      max_active_tasks: input.maxActiveTasks,
      ultrafix_enabled: input.ultrafixEnabled ? 1 : 0,
      ultrafix_goal: input.ultrafixGoal,
      ultrafix_max_cycles: input.ultrafixMaxCycles,
      merge_policy: input.mergePolicy,
      version: 1,
      lease_owner: null,
      lease_epoch: 0,
      lease_expires_at: null,
      terminal_reason: null,
      created_at: now,
      updated_at: now,
    };
    await trx('goals').insert(record);
    return toGoal(record);
  }

  async getGoal(goalId: string): Promise<Goal | null> {
    const id = boundedText(goalId, 'goalId') as string;
    const row = await this.db<GoalRecord>('goals').where('goal_id', id).first();
    return row ? toGoal(row) : null;
  }

  async requireGoal(goalId: string): Promise<Goal> {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
    return goal;
  }

  async listGoals(query: ListGoalsQuery): Promise<ListGoalsResult> {
    const visibility: unknown = (query as Partial<ListGoalsQuery> | null | undefined)?.visibility;
    let ownerUserId: string | null;
    if (visibility === 'owner') {
      ownerUserId = boundedText(
        (query as { ownerUserId?: unknown }).ownerUserId,
        'ownerUserId'
      ) as string;
    } else if (visibility === 'all-demo') {
      ownerUserId = null;
    } else {
      throw new GoalError(
        GOAL_ERROR_CODES.validation,
        "visibility must be 'owner' or 'all-demo'",
        400
      );
    }
    const limit = query.limit ?? GOAL_LIST_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOAL_LIST_MAX_LIMIT) {
      throw new GoalError(GOAL_ERROR_CODES.validation, `limit must be an integer from 1 to ${GOAL_LIST_MAX_LIMIT}`, 400);
    }
    const repository = query.repository === undefined
      ? undefined
      : boundedText(query.repository, 'repository') as string;
    const search = normalizeSearch(query.search);
    const cursorBinding = {
      ownerUserId,
      repository,
      state: query.state,
      search,
    };
    const cursor = decodeCursor(query.cursor, cursorBinding);
    const latestSequenceSql = await this.db.schema.hasTable('goal_event_state')
      ? '(SELECT high_watermark FROM goal_event_state s WHERE s.goal_id = goals.goal_id)'
      : '(SELECT COALESCE(MAX(sequence), 0) FROM goal_events e WHERE e.goal_id = goals.goal_id)';
    let builder = this.db<GoalSummaryRecord>('goals')
      .select('goals.*')
      .select(this.db.raw(`COALESCE(${latestSequenceSql}, 0) AS latest_sequence`));
    if (ownerUserId !== null) builder = builder.where('owner_user_id', ownerUserId);
    if (repository) builder = builder.andWhere('repository', repository);
    if (query.state) builder = builder.andWhere('state', query.state);
    if (search) {
      const pattern = `%${escapeLike(search)}%`;
      builder = builder.andWhere((nested) => {
        void nested.whereRaw("objective LIKE ? ESCAPE '\\' COLLATE NOCASE", [pattern])
          .orWhereRaw("repository LIKE ? ESCAPE '\\' COLLATE NOCASE", [pattern]);
      });
    }
    if (cursor) {
      builder = builder.andWhere((nested) => {
        void nested.where('created_at', '<', cursor.createdAt).orWhere((sameTime) => {
          void sameTime.where('created_at', cursor.createdAt).andWhere('goal_id', '<', cursor.goalId);
        });
      });
    }
    const rows = await builder.orderBy('created_at', 'desc').orderBy('goal_id', 'desc').limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      goals: page.map(toSummary),
      nextCursor: rows.length > limit && last
        ? encodeCursor(last.created_at, last.goal_id, cursorBinding)
        : null,
    };
  }

  async getActiveTimeStats(goalId: string): Promise<GoalActiveTimeStats> {
    const goal = await this.requireGoal(goalId);
    const intervals = await this.db('goal_pause_intervals').where('goal_id', goalId).select('paused_at', 'resumed_at');
    const now = Date.now();
    let end = now;
    if (isTerminalGoalState(goal.state)) {
      const terminalTransition = await this.db('goal_state_transitions')
        .where({ goal_id: goalId, to_state: goal.state })
        .orderBy('id', 'desc')
        .first('created_at') as { created_at: string } | undefined;
      if (!terminalTransition) {
        throw new Error(`Terminal goal ${goalId} has no durable terminal transition`);
      }
      end = Date.parse(terminalTransition.created_at);
    }
    const elapsedMs = Math.max(0, end - Date.parse(goal.createdAt));
    let pausedMs = 0;
    let currentlyPaused = false;
    for (const interval of intervals) {
      const resumedAt = interval.resumed_at ? Date.parse(interval.resumed_at) : end;
      if (!interval.resumed_at) currentlyPaused = true;
      pausedMs += Math.max(0, resumedAt - Date.parse(interval.paused_at));
    }
    const transitions = await this.db('goal_state_transitions').where('goal_id', goalId)
      .orderBy('id', 'asc').select('to_state', 'created_at');
    let recoveryStarted: number | null = null;
    let recoveryMs = 0;
    for (const transition of transitions) {
      const at = Date.parse(transition.created_at);
      if (transition.to_state === 'recovering') recoveryStarted = at;
      else if (recoveryStarted !== null) {
        recoveryMs += Math.max(0, at - recoveryStarted);
        recoveryStarted = null;
      }
    }
    if (recoveryStarted !== null) recoveryMs += Math.max(0, end - recoveryStarted);
    return { elapsedMs, pausedMs, activeMs: Math.max(0, elapsedMs - pausedMs), currentlyPaused, recoveryMs };
  }
}

interface NormalizedCreateInput {
  goalId?: string;
  ownerUserId: string;
  repository: string;
  objective: string;
  agent: string;
  requestedModel: string;
  effectiveModel: string;
  maxActiveTasks: number;
  ultrafixEnabled: boolean;
  ultrafixGoal: number | null;
  ultrafixMaxCycles: number | null;
  mergePolicy: NonNullable<CreateGoalInput['mergePolicy']>;
}

function createIdempotencyRequest(input: NormalizedCreateInput): object {
  return {
    goalId: input.goalId ?? null, repository: input.repository,
    objective: input.objective, agent: input.agent,
    requestedModel: input.requestedModel, effectiveModel: input.effectiveModel,
    maxActiveTasks: input.maxActiveTasks, ultrafixEnabled: input.ultrafixEnabled,
    ultrafixGoal: input.ultrafixGoal, ultrafixMaxCycles: input.ultrafixMaxCycles,
    mergePolicy: input.mergePolicy,
  };
}

function normalizeCreateInput(input: CreateGoalInput): NormalizedCreateInput {
  const maxActiveTasks: unknown = input.maxActiveTasks === undefined
    ? GOAL_DEFAULT_MAX_ACTIVE_TASKS
    : input.maxActiveTasks;
  if (typeof maxActiveTasks !== 'number'
    || !Number.isSafeInteger(maxActiveTasks) || maxActiveTasks < GOAL_MIN_MAX_ACTIVE_TASKS
    || maxActiveTasks > GOAL_MAX_MAX_ACTIVE_TASKS) {
    throw new GoalError(GOAL_ERROR_CODES.concurrencyBound, 'maxActiveTasks is outside the supported range', 400);
  }
  const { ultrafixEnabled, ultrafixGoal, ultrafixMaxCycles } = validateUltrafixInput(input);
  const mergePolicy: unknown = input.mergePolicy === undefined ? 'manual' : input.mergePolicy;
  if (typeof mergePolicy !== 'string'
    || !GOAL_MERGE_POLICIES.includes(mergePolicy as NonNullable<CreateGoalInput['mergePolicy']>)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'mergePolicy is invalid', 400);
  }
  return {
    goalId: input.goalId === undefined ? undefined : boundedText(input.goalId, 'goalId') as string,
    ownerUserId: boundedText(input.ownerUserId, 'ownerUserId') as string,
    repository: boundedText(input.repository, 'repository') as string,
    objective: boundedText(input.objective, 'objective', GOAL_OBJECTIVE_MAX_LENGTH) as string,
    agent: boundedText(input.agent, 'agent') as string,
    requestedModel: boundedText(input.requestedModel, 'requestedModel') as string,
    effectiveModel: boundedText(input.effectiveModel ?? input.requestedModel, 'effectiveModel') as string,
    maxActiveTasks,
    ultrafixEnabled,
    ultrafixGoal,
    ultrafixMaxCycles,
    mergePolicy: mergePolicy as NonNullable<CreateGoalInput['mergePolicy']>,
  };
}

function validateUltrafixInput(input: CreateGoalInput): Pick<
  NormalizedCreateInput,
  'ultrafixEnabled' | 'ultrafixGoal' | 'ultrafixMaxCycles'
> {
  const ultrafixEnabled = input.ultrafixEnabled ?? false;
  const ultrafixGoal = input.ultrafixGoal ?? null;
  const ultrafixMaxCycles = input.ultrafixMaxCycles ?? null;
  if (typeof ultrafixEnabled !== 'boolean'
    || (!ultrafixEnabled && (ultrafixGoal !== null || ultrafixMaxCycles !== null))
    || (ultrafixEnabled && (!Number.isSafeInteger(ultrafixGoal)
      || (ultrafixGoal as number) < GOAL_ULTRAFIX_GOAL_MIN
      || (ultrafixGoal as number) > GOAL_ULTRAFIX_GOAL_MAX
      || !Number.isSafeInteger(ultrafixMaxCycles)
      || (ultrafixMaxCycles as number) < GOAL_ULTRAFIX_MAX_CYCLES_MIN
      || (ultrafixMaxCycles as number) > GOAL_ULTRAFIX_MAX_CYCLES_MAX))) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'Ultrafix settings are invalid', 400);
  }
  return { ultrafixEnabled, ultrafixGoal, ultrafixMaxCycles };
}

function normalizeSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const search = value.trim();
  if (!search || characterLength(search) > GOAL_SEARCH_MAX_LENGTH) {
    throw new GoalError(GOAL_ERROR_CODES.validation, `search must contain between 1 and ${GOAL_SEARCH_MAX_LENGTH} characters`, 400);
  }
  return search;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
