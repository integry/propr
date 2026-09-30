import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { McpError } from './config.js';
import { classifyError, type McpErrorEnvelope } from './errorEnvelope.js';
import { digest } from './store.js';
import type { McpPrincipal } from './policy.js';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { artifactsFromReceipt, failureFromReceipt } from './operationLifecycle.js';
import { COMMAND_NOT_PICKED_UP_FAILURE, summarizeLifecycle } from './commandProgress.js';

const interruptionTimeoutMs = 120_000;
const REFINEMENT_OUTCOME_UNAVAILABLE = 'REFINEMENT_OUTCOME_UNAVAILABLE';

export interface OperationResult { status: number; data: unknown; content?: ContentBlock[] }
export type LifecycleState = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type LifecycleOutcome = 'completed' | 'failed' | 'cancelled';
export interface Operation {
  id: string; owner_id: string; grant_id: string; idempotency_key: string; tool: string; repository: string | null;
  state: string; result: string | null; created_at: number; updated_at: number; payload_hash: string;
  lifecycle: LifecycleState; accepted_at: number; started_at: number | null; finished_at: number | null;
  failure: string | null; artifacts: string | null; progress: string | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function recoveryReceipt(row: Pick<Operation, 'state' | 'result'>) {
  const result = json(row.result);
  const targetState = record(record(result)?.targetState);
  return { state: row.state, result, ...(targetState ? { targetState } : {}) };
}

function confirmedCancellationSource(row: Pick<Operation, 'tool'>, receipt: ReturnType<typeof recoveryReceipt>): string | undefined {
  const result = record(receipt.result);
  return row.tool === 'cancel_operation' && result?.cancellation === 'confirmed'
    && typeof result.operationId === 'string' && result.operationId.length > 0 ? result.operationId : undefined;
}

function iso(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function errorEnvelope(value: unknown): McpErrorEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as Partial<McpErrorEnvelope>;
  return typeof envelope.code === 'string' && typeof envelope.message === 'string'
    && typeof envelope.retryable === 'boolean' && typeof envelope.status === 'number'
    ? envelope as McpErrorEnvelope : undefined;
}

function isPickupFailure(value: unknown): boolean {
  return errorEnvelope(value)?.code === COMMAND_NOT_PICKED_UP_FAILURE.code;
}

function isRefinementOutcomeUnavailable(value: unknown): boolean {
  return errorEnvelope(value)?.code === REFINEMENT_OUTCOME_UNAVAILABLE;
}

function operationState(result: OperationResult): string {
  const reported = (result.data as { state?: string })?.state;
  if (reported === 'browser_required') return reported;
  if (result.status !== 202) return 'completed';
  return ['posted', 'queued', 'unknown', 'failed'].includes(reported || '') ? reported! : 'accepted';
}

function invocationInterrupted(row: Operation, now = Date.now()): boolean {
  const invokedAt = Number(row.accepted_at);
  return row.state === 'accepted' && row.result === null && Number.isFinite(invokedAt)
    && now - invokedAt > interruptionTimeoutMs;
}

function needsProgressRecovery(targetState: unknown, lifecycleMissing: boolean, progress: string | null): boolean {
  if (targetState === undefined) return false;
  return lifecycleMissing || progress === null;
}

function recoveredProgress(db: Knex, targetState: unknown, lifecycleMissing: boolean): unknown {
  if (lifecycleMissing) return JSON.stringify(targetState);
  return db.raw('COALESCE(progress, ?)', [JSON.stringify(targetState)]);
}

export class McpOperations {
  constructor(readonly db: Knex) {}

  async replay(principal: McpPrincipal, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const identity = { owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: String(args.idempotencyKey) };
    let previous = await this.db<Operation>('mcp_operations').where(identity).first();
    if (!previous) return undefined;
    if (previous.payload_hash !== digest(canonical({ tool, args }))) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
    await this.reconcileTerminalLifecycles(principal, previous.id);
    await this.markInterruptedInvocations(principal, previous.id);
    previous = (await this.db<Operation>('mcp_operations').where(identity).first())!;
    return this.project(previous);
  }

  async run(principal: McpPrincipal, { tool, args, repository }: { tool: string; args: Record<string, unknown>; repository?: string }, invoke: (operationId: string) => Promise<OperationResult>): Promise<Record<string, unknown>> {
    const key = String(args.idempotencyKey || '');
    if (!/^[\w.-]{8,128}$/.test(key)) throw new McpError('IDEMPOTENCY_KEY_REQUIRED', 'Provide a stable 8–128 character idempotencyKey for this action.');
    const identity = { owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: key };
    const payloadHash = digest(canonical({ tool, args }));
    const id = randomUUID();
    const acceptedAt = Date.now();
    const inserted = await this.db('mcp_operations').insert({ ...identity, id, tool, repository: repository || null,
      payload_hash: payloadHash, state: 'accepted', lifecycle: 'accepted', accepted_at: acceptedAt, artifacts: JSON.stringify({}),
      created_at: acceptedAt, updated_at: acceptedAt }).onConflict(['owner_id', 'grant_id', 'idempotency_key']).ignore().returning('id');
    if (!inserted.length) {
      let previous = await this.db<Operation>('mcp_operations').where(identity).first();
      if (!previous || previous.payload_hash !== payloadHash) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
      await this.reconcileTerminalLifecycles(principal, previous.id);
      previous = (await this.db<Operation>('mcp_operations').where(identity).first())!;
      return this.project(previous);
    }
    try {
      const result = await invoke(id);
      const state = operationState(result);
      const recorded = await this.db('mcp_operations').where({ id }).whereNotIn('state', ['completed', 'failed', 'cancelled'])
        .update({ state, result: JSON.stringify(result.data), updated_at: Date.now() });
      if (!recorded) return this.project((await this.db<Operation>('mcp_operations').where({ id }).first())!);
      const receipt = { state, result: result.data };
      await this.recordArtifacts(id, artifactsFromReceipt({ repository: repository || null }, receipt));
      if (['completed', 'failed', 'cancelled'].includes(state)) {
        const failure = errorEnvelope((result.data as { error?: unknown } | null)?.error) ?? failureFromReceipt(receipt);
        await this.finish(id, state as LifecycleOutcome, failure);
      } else if (state === 'unknown') {
        const failure = errorEnvelope((result.data as { error?: unknown } | null)?.error);
        await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'unknown'])
          .update({ lifecycle: 'unknown', failure: failure ? JSON.stringify(failure) : null, updated_at: Date.now() });
      } else {
        // A live invocation result is authoritative if a concurrent poll had
        // already classified its previously result-less receipt as interrupted.
        await this.markAccepted(id);
      }
    } catch (error) {
      // A transport failure can follow an external side effect. Never replay it
      // automatically or claim it was rolled back. The handle remains durable.
      const envelope = classifyError(error, { sideEffectsPossible: true });
      const state = envelope.code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed';
      const recorded = await this.db('mcp_operations').where({ id }).whereNotIn('state', ['completed', 'failed', 'cancelled'])
        .update({ state, result: JSON.stringify({ error: envelope }), updated_at: Date.now() });
      if (!recorded) return this.project((await this.db<Operation>('mcp_operations').where({ id }).first())!);
      if (state === 'failed') await this.finish(id, 'failed', envelope);
      else await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'unknown'])
        .update({ lifecycle: 'unknown', failure: JSON.stringify(envelope), updated_at: Date.now() });
    }
    return this.project((await this.db<Operation>('mcp_operations').where({ id }).first())!);
  }

  async get(principal: McpPrincipal, id: string): Promise<Operation> {
    await this.reconcileTerminalLifecycles(principal, id);
    await this.markInterruptedInvocations(principal, id);
    const row = await this.db<Operation>('mcp_operations').where({ id, owner_id: principal.user.id, grant_id: principal.grant.id }).first();
    if (!row) throw new McpError('NOT_FOUND', 'Operation not found.', 404);
    return row;
  }

  /** Repair a process interruption after its terminal receipt write but before lifecycle synchronization. */
  // eslint-disable-next-line complexity -- recovery atomically reconciles lifecycle, artifacts, failure, and progress
  async reconcileTerminalLifecycles(principal: McpPrincipal, id?: string): Promise<void> {
    const query = this.db('mcp_operations').where({ owner_id: principal.user.id, grant_id: principal.grant.id })
      .whereIn('state', ['completed', 'failed', 'cancelled']);
    if (id) query.andWhere({ id });
    const rows = await query.select<Operation[]>();
    for (const row of rows) {
      const receipt = recoveryReceipt(row);
      const cancellationSourceId = confirmedCancellationSource(row, receipt);
      await this.finishCancellationSource(row, cancellationSourceId);
      const targetState = receipt.targetState;
      const result = record(receipt.result);
      const terminalProgress = result?.ultrafixProgress ?? targetState;
      const artifacts = artifactsFromReceipt(row, receipt);
      const storedArtifacts = json(row.artifacts);
      const artifactRecord = storedArtifacts && typeof storedArtifacts === 'object' && !Array.isArray(storedArtifacts)
        ? storedArtifacts as Record<string, unknown> : {};
      const missingArtifacts = Object.fromEntries(Object.entries(artifacts)
        .filter(([key, value]) => canonical(artifactRecord[key]) !== canonical(value)));
      const failure = row.state === 'failed' ? failureFromReceipt(receipt) : undefined;
      const pickupFailure = isPickupFailure(json(row.failure));
      const unavailableRefinementOutcome = isRefinementOutcomeUnavailable(json(row.failure));
      const failureNeedsRecovery = !!failure && (row.failure === null || pickupFailure || unavailableRefinementOutcome);
      const failureNeedsClearing = pickupFailure && !failure;
      const failureNeedsUpdate = failureNeedsRecovery || failureNeedsClearing;
      const lifecycleMissing = ['accepted', 'running', 'unknown'].includes(row.lifecycle) || row.finished_at === null;
      const progressNeedsRecovery = needsProgressRecovery(terminalProgress, lifecycleMissing, row.progress);
      if (!lifecycleMissing && !Object.keys(missingArtifacts).length && !failureNeedsUpdate && !progressNeedsRecovery) continue;

      const update: Record<string, unknown> = { updated_at: Date.now() };
      if (lifecycleMissing) {
        update.lifecycle = row.state;
        // The receipt update time is the strongest durable evidence of when
        // the terminal outcome was persisted; recovery itself must not move it.
        update.finished_at = this.db.raw('COALESCE(finished_at, ?, ?)', [row.updated_at, Date.now()]);
      }
      if (Object.keys(missingArtifacts).length) {
        update.artifacts = this.db.raw("json_patch(COALESCE(artifacts, '{}'), ?)", [JSON.stringify(missingArtifacts)]);
      }
      if (failureNeedsRecovery) {
        // A pickup timeout is only nonterminal evidence. Once the durable
        // receipt proves execution failed, its failure supersedes that timeout.
        update.failure = JSON.stringify(failure);
      } else if (failureNeedsClearing) {
        // Terminal receipts without recoverable failure detail still prove the
        // pickup timeout obsolete, but have no failure to store in its place.
        update.failure = null;
      }
      if (progressNeedsRecovery) {
        // A terminal tracker receipt is newer than any nonterminal progress
        // recorded before lifecycle synchronization was interrupted.
        update.progress = recoveredProgress(this.db, terminalProgress, lifecycleMissing);
      }

      // Do not attach metadata derived from a receipt that changed after the
      // read. A later reconciliation will use the newer durable evidence.
      const eligible = this.db('mcp_operations').where({
        id: row.id, owner_id: row.owner_id, grant_id: row.grant_id,
        state: row.state, lifecycle: row.lifecycle,
      });
      if (row.result === null) eligible.whereNull('result');
      else eligible.andWhere('result', row.result);
      if (failureNeedsUpdate) {
        // Do not replace a terminal failure written after this receipt was read.
        if (row.failure === null) eligible.whereNull('failure');
        else eligible.andWhere('failure', row.failure);
      }
      await eligible.update(update);
    }
  }

  async markInterruptedInvocations(principal: McpPrincipal, id?: string): Promise<void> {
    const now = Date.now();
    const query = this.db('mcp_operations').where({ owner_id: principal.user.id, grant_id: principal.grant.id })
      .where({ state: 'accepted' }).whereNull('result').whereIn('lifecycle', ['accepted', 'running', 'unknown'])
      .where('accepted_at', '<', now - interruptionTimeoutMs);
    if (id) query.andWhere({ id });
    await query.update({ state: 'unknown', lifecycle: 'unknown', updated_at: now });
  }

  async markStarted(id: string, at = Date.now()): Promise<void> {
    await this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'running', 'unknown']).update({
      lifecycle: 'running',
      started_at: this.db.raw('COALESCE(started_at, ?)', [at]),
      failure: null,
      updated_at: Date.now(),
    });
  }

  async markUnknown(id: string, failure?: McpErrorEnvelope): Promise<void> {
    const eligible = this.db('mcp_operations').where({ id }).whereIn('lifecycle', ['accepted', 'running', 'unknown']);
    if (isPickupFailure(failure)) {
      const validResult = "CASE WHEN json_valid(result) THEN result ELSE '{}' END";
      const validArtifacts = "CASE WHEN json_valid(artifacts) THEN artifacts ELSE '{}' END";
      eligible.whereNot('state', 'running').whereNull('started_at')
        .whereRaw(`json_extract(${validResult}, '$.continuation.taskId') IS NULL`)
        .whereRaw(`json_extract(${validArtifacts}, '$.taskId') IS NULL`);
    }
    await eligible.update({
      lifecycle: 'unknown',
      ...(failure ? { failure: JSON.stringify(failure) } : {}),
      updated_at: Date.now(),
    });
  }

  /** Stop polling when mutable backend metadata has displaced this operation's only outcome evidence. */
  async markOutcomeUnavailable(id: string, failure: McpErrorEnvelope): Promise<void> {
    await this.db('mcp_operations').where({ id })
      .whereIn('state', ['accepted', 'posted', 'queued', 'running', 'unknown'])
      .whereIn('lifecycle', ['accepted', 'running', 'unknown'])
      .update({
        state: 'unknown',
        lifecycle: 'unknown',
        failure: JSON.stringify(failure),
        updated_at: Date.now(),
      });
  }

  async markAccepted(id: string): Promise<void> {
    await this.db('mcp_operations').where({ id, lifecycle: 'unknown' }).whereNull('started_at').update({
      lifecycle: 'accepted',
      updated_at: Date.now(),
    });
  }

  async recordArtifacts(id: string, partial: Record<string, unknown>): Promise<void> {
    if (!Object.keys(partial).length) return;
    await this.db('mcp_operations').where({ id }).update({
      artifacts: this.db.raw("json_patch(COALESCE(artifacts, '{}'), ?)", [JSON.stringify(partial)]),
      updated_at: Date.now(),
    });
  }

  async recordProgress(id: string, progress: unknown): Promise<void> {
    const serialized = JSON.stringify(progress);
    await this.db('mcp_operations').where({ id })
      .whereIn('lifecycle', ['accepted', 'running', 'unknown'])
      .whereNotIn('state', ['completed', 'failed', 'cancelled'])
      .update({ progress: this.db.raw(`CASE
        WHEN json_extract(CASE WHEN json_valid(progress) THEN progress ELSE '{}' END, '$.phase') = 'stopping'
          THEN json_set(?, '$.phase', 'stopping')
        ELSE ?
      END`, [serialized, serialized]), updated_at: Date.now() });
  }

  async finish(id: string, outcome: LifecycleOutcome, failure?: McpErrorEnvelope, progress?: unknown): Promise<void> {
    const at = Date.now();
    const pickupFailureSql = "json_extract(CASE WHEN json_valid(failure) THEN failure ELSE '{}' END, '$.code') = ?";
    const unavailableRefinementOutcomeSql = "json_extract(CASE WHEN json_valid(failure) THEN failure ELSE '{}' END, '$.code') = ?";
    const eligible = this.db('mcp_operations').where({ id }).andWhere(builder => {
      builder.whereIn('lifecycle', ['accepted', 'running', 'unknown']);
      if (outcome === 'failed' && failure) builder.orWhere(nested => nested.where({ lifecycle: 'failed' })
        .andWhere(current => current.whereNull('failure')
          .orWhereRaw(pickupFailureSql, [COMMAND_NOT_PICKED_UP_FAILURE.code])
          .orWhereRaw(unavailableRefinementOutcomeSql, [REFINEMENT_OUTCOME_UNAVAILABLE])));
      else builder.orWhere(nested => nested.where({ lifecycle: outcome })
        .whereRaw(pickupFailureSql, [COMMAND_NOT_PICKED_UP_FAILURE.code]));
    });
    const update: Record<string, unknown> = {
      lifecycle: outcome,
      finished_at: this.db.raw('COALESCE(finished_at, ?)', [at]),
      failure: failure ? this.db.raw(`CASE
        WHEN failure IS NULL OR json_extract(CASE WHEN json_valid(failure) THEN failure ELSE '{}' END, '$.code') IN (?, ?) THEN ?
        ELSE failure
      END`, [COMMAND_NOT_PICKED_UP_FAILURE.code, REFINEMENT_OUTCOME_UNAVAILABLE, JSON.stringify(failure)]) : null,
      updated_at: at,
    };
    if (progress !== undefined) update.progress = this.db.raw(`CASE
      WHEN lifecycle IN ('accepted', 'running', 'unknown') THEN ?
      ELSE COALESCE(progress, ?)
    END`, [JSON.stringify(progress), JSON.stringify(progress)]);
    await eligible.update(update);
  }

  /** Apply durable cancellation evidence only to the receipt owner's source operation. */
  async finishCancellationSource(
    cancellation: Pick<Operation, 'id' | 'owner_id' | 'grant_id'>,
    sourceId: string | undefined,
  ): Promise<void> {
    if (!sourceId) return;
    const durable = await this.db<Operation>('mcp_operations').where({
      id: cancellation.id, owner_id: cancellation.owner_id, grant_id: cancellation.grant_id, tool: 'cancel_operation',
    }).whereIn('state', ['completed', 'failed', 'cancelled']).first('result', 'updated_at');
    const result = record(json(durable?.result));
    if (result?.cancellation !== 'confirmed' || result.operationId !== sourceId) return;

    const now = Date.now();
    const confirmedAt = Number(durable?.updated_at);
    await this.db('mcp_operations').where({
      id: sourceId, owner_id: cancellation.owner_id, grant_id: cancellation.grant_id,
    }).whereIn('lifecycle', ['accepted', 'running', 'unknown']).update({
      lifecycle: 'cancelled',
      finished_at: this.db.raw('COALESCE(finished_at, ?)', [Number.isFinite(confirmedAt) ? confirmedAt : now]),
      failure: null,
      updated_at: now,
    });
  }

  project(row: Operation): Record<string, unknown> {
    const interrupted = invocationInterrupted(row);
    const terminal = ['completed', 'failed', 'cancelled'].includes(row.lifecycle);
    const stale = !terminal && interrupted;
    const state = terminal ? row.lifecycle : stale ? 'unknown' : row.state;
    const lifecycle = {
      state: interrupted && !terminal ? 'unknown' : row.lifecycle,
      acceptedAt: iso(row.accepted_at),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      failure: json(row.failure),
      artifacts: json(row.artifacts) ?? {},
      progress: json(row.progress),
    };
    const commandReceipt = ['review_pull_request', 'fix_review_findings', 'run_ultrafix', 'comment_on_pull_request'].includes(row.tool);
    return { operationId: row.id, tool: row.tool, state, result: json(row.result), lifecycle: {
      ...lifecycle, ...(commandReceipt ? { summary: summarizeLifecycle(row.tool, lifecycle) } : {}),
    },
      ...(['accepted', 'posted', 'queued', 'running'].includes(state) ? { retryAfterSeconds: 3 } : {}),
      ...(stale ? { message: 'Execution may have been interrupted. Inspect the target; this action will not be replayed automatically.' } : {}) };
  }
}
