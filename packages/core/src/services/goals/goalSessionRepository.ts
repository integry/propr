import crypto from 'crypto';
import type { Knex } from 'knex';
import { GOAL_ERROR_CODES } from '@propr/shared';
import type {
  GoalProviderSessionRecord,
  ProviderSessionUpdate,
} from './goalTypes.js';
import {
  GoalError,
  boundedText,
  guardLease,
  goalTransaction,
  nowIso,
} from './goalRepositorySupport.js';

const MAX_RECOVERY_METADATA_BYTES = 4096;

/**
 * Durable identity and recovery state for the goal's one provider-native
 * session. Provider ownership comes only from the immutable goals.agent value;
 * callers cannot select or replace it while updating resume metadata.
 */
export class GoalSessionRepository {
  constructor(private readonly db: Knex) {}

  async upsertProviderSession(
    goalId: string,
    fields: ProviderSessionUpdate
  ): Promise<void> {
    validateProviderFields(fields);
    await goalTransaction(this.db, async (trx) => {
      const goal = await guardLease(trx, goalId, fields);
      const existing = await trx<GoalProviderSessionRecord>('goal_provider_sessions')
        .where({ goal_id: goalId }).first();
      if (existing && existing.agent !== goal.agent) {
        throw new GoalError(
          GOAL_ERROR_CODES.sessionConflict,
          'Provider session ownership does not match the selected goal agent',
          409
        );
      }
      const recoveryJson = fields.recoveryMetadata === undefined
        ? existing?.recovery_metadata_json ?? null
        : validateRecoveryMetadata(fields.recoveryMetadata);
      const now = nowIso();
      if (existing) {
        assertStableIdentity('providerThreadId', existing.provider_thread_id, fields.providerThreadId);
        assertStableIdentity('worktreeId', existing.worktree_id, fields.worktreeId);
        const affected = await trx('goal_provider_sessions').where({
          session_id: existing.session_id,
          goal_id: goalId,
          agent: goal.agent,
          lease_generation: existing.lease_generation,
        }).update({
          provider_thread_id: preserveUndefined(fields.providerThreadId, existing.provider_thread_id),
          runtime_id: preserveUndefined(fields.runtimeId, existing.runtime_id),
          worktree_id: preserveUndefined(fields.worktreeId, existing.worktree_id),
          last_checkpoint: preserveUndefined(fields.lastCheckpoint, existing.last_checkpoint),
          native_status: preserveUndefined(fields.nativeStatus, existing.native_status),
          requested_model: fields.requestedModel ?? existing.requested_model,
          effective_model: fields.effectiveModel ?? existing.effective_model,
          recovery_metadata_json: recoveryJson,
          lease_generation: fields.leaseEpoch,
          updated_at: now,
        });
        if (affected !== 1) {
          throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Provider session changed concurrently', 409);
        }
        return;
      }
      await trx('goal_provider_sessions').insert({
        session_id: crypto.randomUUID(),
        goal_id: goalId,
        agent: goal.agent,
        provider_thread_id: fields.providerThreadId ?? null,
        runtime_id: fields.runtimeId ?? null,
        worktree_id: fields.worktreeId ?? null,
        last_checkpoint: fields.lastCheckpoint ?? null,
        native_status: fields.nativeStatus ?? null,
        requested_model: fields.requestedModel ?? goal.requested_model,
        effective_model: fields.effectiveModel ?? goal.effective_model,
        recovery_metadata_json: recoveryJson,
        lease_generation: fields.leaseEpoch,
        created_at: now,
        updated_at: now,
      });
    });
  }

  async getProviderSession(goalId: string): Promise<GoalProviderSessionRecord | null> {
    const id = boundedText(goalId, 'goalId') as string;
    const row = await this.db<GoalProviderSessionRecord>('goal_provider_sessions')
      .where({ goal_id: id }).first();
    return row ?? null;
  }
}

function validateProviderFields(fields: ProviderSessionUpdate): void {
  for (const [name, value] of Object.entries({
    providerThreadId: fields.providerThreadId,
    runtimeId: fields.runtimeId,
    worktreeId: fields.worktreeId,
    nativeStatus: fields.nativeStatus,
    requestedModel: fields.requestedModel,
    effectiveModel: fields.effectiveModel,
  })) {
    if (value !== undefined) boundedText(value, name, undefined, true);
  }
  if (fields.lastCheckpoint !== undefined && fields.lastCheckpoint !== null
    && (typeof fields.lastCheckpoint !== 'string'
      || Buffer.byteLength(fields.lastCheckpoint, 'utf8') > 4096)) {
    throw new GoalError(GOAL_ERROR_CODES.validation, 'lastCheckpoint exceeds 4096 bytes', 400);
  }
}

function preserveUndefined<T>(value: T | undefined, existing: T): T {
  return value === undefined ? existing : value;
}

function assertStableIdentity(
  field: string,
  existing: string | null,
  requested: string | null | undefined
): void {
  if (existing !== null && requested !== undefined && requested !== existing) {
    throw new GoalError(
      GOAL_ERROR_CODES.sessionConflict,
      `${field} cannot replace the goal's provider-native session identity`,
      409
    );
  }
}

function validateRecoveryMetadata(value: ProviderSessionUpdate['recoveryMetadata']): string | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRecovery();
  const metadata = value as unknown as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'reason', 'attempt', 'lastEventSequence', 'providerState']);
  if (Object.keys(metadata).some((key) => !allowed.has(key)) || metadata.schemaVersion !== 1) invalidRecovery();
  if (metadata.reason !== undefined
    && (typeof metadata.reason !== 'string' || metadata.reason.length > 256)) invalidRecovery();
  for (const field of ['attempt', 'lastEventSequence'] as const) {
    const candidate = metadata[field];
    if (candidate !== undefined
      && (!Number.isSafeInteger(candidate) || (candidate as number) < 0)) invalidRecovery();
  }
  if (metadata.providerState !== undefined
    && !['starting', 'active', 'interrupted', 'recoverable'].includes(metadata.providerState as string)) invalidRecovery();
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECOVERY_METADATA_BYTES) invalidRecovery();
  return json;
}

function invalidRecovery(): never {
  throw new GoalError(GOAL_ERROR_CODES.recoveryMetadataInvalid, 'Recovery metadata is invalid', 400);
}
