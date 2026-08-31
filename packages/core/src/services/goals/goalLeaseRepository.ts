import type { Knex } from 'knex';
import { GOAL_ERROR_CODES, GOAL_LEASE_TTL_MAX_MS } from '@propr/shared';
import type { GoalRecord } from './goalTypes.js';
import {
  GoalError,
  boundedText,
  goalTransaction,
  nowIso,
  requireGoalRecord,
  validateFence,
} from './goalRepositorySupport.js';

export class GoalLeaseRepository {
  constructor(private readonly db: Knex) {}

  async claimLease(goalId: string, owner: string, ttlMs: number): Promise<{ epoch: number; expiresAt: string }> {
    const id = boundedText(goalId, 'goalId') as string;
    const leaseOwner = boundedText(owner, 'leaseOwner') as string;
    validateTtl(ttlMs);
    const now = nowIso();
    const expiresAt = nowIso(Date.now() + ttlMs);
    return goalTransaction(this.db, async (trx) => {
      const affected = await trx('goals').where('goal_id', id).andWhere((available) => {
        void available.whereNull('lease_owner')
          .orWhere((expired) => void expired.whereNotNull('lease_expires_at').andWhere('lease_expires_at', '<=', now));
      }).update({
        lease_owner: leaseOwner,
        lease_epoch: trx.raw('lease_epoch + 1'),
        lease_expires_at: expiresAt,
        updated_at: now,
      });
      if (affected !== 1) {
        const exists = await trx('goals').where('goal_id', id).first('goal_id');
        if (!exists) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
        throw new GoalError(GOAL_ERROR_CODES.leaseConflict, 'Controller lease is held by another owner', 409);
      }
      const goal = await requireGoalRecord(trx, id);
      return { epoch: goal.lease_epoch, expiresAt };
    });
  }

  async renewLease(goalId: string, owner: string, epoch: number, ttlMs: number): Promise<{ expiresAt: string }> {
    const id = boundedText(goalId, 'goalId') as string;
    const leaseOwner = boundedText(owner, 'leaseOwner') as string;
    validateFence({ leaseOwner, leaseEpoch: epoch });
    validateTtl(ttlMs);
    const now = nowIso();
    const expiresAt = nowIso(Date.now() + ttlMs);
    return goalTransaction(this.db, async (trx) => {
      const affected = await trx('goals').where({
        goal_id: id,
        lease_owner: leaseOwner,
        lease_epoch: epoch,
      }).whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now)
        .update({ lease_expires_at: expiresAt, updated_at: now });
      if (affected !== 1) await throwLeaseFailure(trx, id);
      return { expiresAt };
    });
  }

  async releaseLease(goalId: string, owner: string, epoch: number): Promise<void> {
    const id = boundedText(goalId, 'goalId') as string;
    const leaseOwner = boundedText(owner, 'leaseOwner') as string;
    validateFence({ leaseOwner, leaseEpoch: epoch });
    const now = nowIso();
    await goalTransaction(this.db, async (trx) => {
      const affected = await trx('goals').where({
        goal_id: id,
        lease_owner: leaseOwner,
        lease_epoch: epoch,
      }).whereNotNull('lease_expires_at').andWhere('lease_expires_at', '>', now)
        .update({ lease_owner: null, lease_expires_at: null, updated_at: now });
      if (affected !== 1) await throwLeaseFailure(trx, id);
    });
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > GOAL_LEASE_TTL_MAX_MS) {
    throw new GoalError(
      GOAL_ERROR_CODES.validation,
      `Lease TTL must be a positive safe integer no greater than ${GOAL_LEASE_TTL_MAX_MS}`,
      400
    );
  }
}

async function throwLeaseFailure(trx: Knex.Transaction, goalId: string): Promise<never> {
  const goal = await trx<GoalRecord>('goals').where('goal_id', goalId).first();
  if (!goal) throw new GoalError(GOAL_ERROR_CODES.notFound, 'Goal not found', 404);
  throw new GoalError(GOAL_ERROR_CODES.staleLease, 'Controller lease is stale or expired', 409);
}
