import type { Knex } from 'knex';
import { logger } from '@propr/core';

export const ENTITLEMENT_REFRESH_LEASE_TABLE =
  'notification_repository_entitlement_refresh_leases';
const ENTITLEMENT_GENERATION_TABLE = 'notification_repository_entitlement_generations';
const REGISTRATION_TOKEN = 'notification-scheduler-registration';
const INVALIDATION_TOKEN = 'notification-logout-tombstone';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TOMBSTONE_SAFETY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOMBSTONE_GC_BATCH_SIZE = 100;
const tombstoneSupport = new WeakMap<object, Promise<boolean>>();

export async function ensureEntitlementRefreshRegistration(
  database: Knex,
  userId: string
): Promise<boolean> {
  if (!await database.schema.hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE)) return false;
  await database(ENTITLEMENT_REFRESH_LEASE_TABLE).insert({
    user_id: userId,
    lease_token: REGISTRATION_TOKEN,
    expires_at: new Date(0).toISOString(),
  }).onConflict('user_id').ignore();
  const registration = database(ENTITLEMENT_REFRESH_LEASE_TABLE).where({ user_id: userId });
  if (await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'invalidated_at')) {
    registration.whereNull('invalidated_at');
  }
  return await registration.first('user_id') !== undefined;
}

function requireAuthGeneration(authGeneration: string): string {
  const generation = authGeneration.trim();
  if (!generation) throw new TypeError('Notification entitlement auth generation must be non-blank');
  return generation;
}

async function supportsEntitlementInvalidationTombstones(database: Knex): Promise<boolean> {
  let supported = tombstoneSupport.get(database);
  if (!supported) {
    supported = (async () => await database.schema.hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE)
      && await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'fencing_token')
      && await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'retry_after')
      && await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'invalidated_at')
      && await database.schema.hasColumn(ENTITLEMENT_REFRESH_LEASE_TABLE, 'auth_generation')
      && await database.schema.hasTable(ENTITLEMENT_GENERATION_TABLE))();
    tombstoneSupport.set(database, supported);
    void supported.then(
      (value) => { if (!value && tombstoneSupport.get(database) === supported) {
        tombstoneSupport.delete(database);
      } },
      () => { if (tombstoneSupport.get(database) === supported) {
        tombstoneSupport.delete(database);
      } }
    );
  }
  return supported;
}

async function pruneExpiredGenerationTombstones(
  transaction: Knex.Transaction,
  observedAt: Date
): Promise<void> {
  const cutoff = new Date(
    observedAt.getTime() - SESSION_MAX_AGE_MS - TOMBSTONE_SAFETY_WINDOW_MS
  ).toISOString();
  const expired = await transaction(ENTITLEMENT_GENERATION_TABLE)
    .select('user_id', 'auth_generation')
    .whereNotNull('invalidated_at')
    .andWhere('invalidated_at', '<', cutoff)
    .orderBy('invalidated_at', 'asc')
    .limit(TOMBSTONE_GC_BATCH_SIZE) as Array<{
      user_id: string;
      auth_generation: string;
    }>;
  if (expired.length === 0) return;
  await transaction(ENTITLEMENT_GENERATION_TABLE)
    .where((identities) => {
      expired.forEach((row, index) => {
        const identity = {
          user_id: row.user_id,
          auth_generation: row.auth_generation,
        };
        if (index === 0) identities.where(identity);
        else identities.orWhere(identity);
      });
    })
    .delete();
}

export async function activateNotificationRepositoryEntitlements(
  database: Knex,
  userId: string,
  authGeneration: string
): Promise<void> {
  const generation = requireAuthGeneration(authGeneration);
  if (!await supportsEntitlementInvalidationTombstones(database)) {
    if (!await ensureEntitlementRefreshRegistration(database, userId)) {
      throw new Error('Notification entitlement activation is fenced by an invalidation');
    }
    return;
  }
  const expiresAt = new Date(0).toISOString();
  await database.transaction(async (transaction) => {
    const observedAt = new Date();
    const activatedAt = observedAt.toISOString();
    await transaction(ENTITLEMENT_GENERATION_TABLE).insert({
      user_id: userId,
      auth_generation: generation,
      activated_at: activatedAt,
      invalidated_at: null,
    }).onConflict(['user_id', 'auth_generation']).ignore();
    const generationState = await transaction(ENTITLEMENT_GENERATION_TABLE)
      .where({ user_id: userId, auth_generation: generation })
      .first('invalidated_at') as { invalidated_at?: unknown } | undefined;
    if (!generationState || generationState.invalidated_at !== null) {
      throw new Error('Authenticated session generation has already been invalidated');
    }
    await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE).insert({
      user_id: userId,
      lease_token: REGISTRATION_TOKEN,
      fencing_token: 1,
      expires_at: expiresAt,
      retry_after: null,
      invalidated_at: null,
      auth_generation: generation,
    }).onConflict('user_id').merge({
      lease_token: REGISTRATION_TOKEN,
      fencing_token: transaction.raw(
        `${ENTITLEMENT_REFRESH_LEASE_TABLE}.fencing_token + 1`
      ),
      expires_at: expiresAt,
      retry_after: null,
      invalidated_at: null,
      auth_generation: generation,
    }).where((staleGeneration) => staleGeneration
      .whereNull('auth_generation')
      .orWhereNot('auth_generation', generation));
    const activated = await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE)
      .where({ user_id: userId, auth_generation: generation })
      .whereNull('invalidated_at')
      .first('user_id');
    if (!activated) {
      throw new Error('Authenticated session generation has already been invalidated');
    }
    await pruneExpiredGenerationTombstones(transaction, observedAt);
  });
}

export async function invalidateNotificationRepositoryEntitlements(
  database: Knex,
  userId: string,
  authGeneration: string
): Promise<boolean> {
  const generation = requireAuthGeneration(authGeneration);
  try {
    const hasRefreshLeases = await database.schema.hasTable(ENTITLEMENT_REFRESH_LEASE_TABLE);
    const hasTombstones = hasRefreshLeases
      && await supportsEntitlementInvalidationTombstones(database);
    return await database.transaction(async (transaction) => {
      if (hasTombstones) {
        const observedAt = new Date();
        const invalidatedAt = observedAt.toISOString();
        await transaction(ENTITLEMENT_GENERATION_TABLE).insert({
          user_id: userId,
          auth_generation: generation,
          activated_at: invalidatedAt,
          invalidated_at: invalidatedAt,
        }).onConflict(['user_id', 'auth_generation']).merge({
          invalidated_at: invalidatedAt,
        });
        const current = await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE)
          .where({ user_id: userId })
          .forUpdate()
          .first('auth_generation') as { auth_generation?: unknown } | undefined;
        const currentGeneration = typeof current?.auth_generation === 'string'
          ? current.auth_generation.trim()
          : '';
        const currentIsActive = currentGeneration
          ? await transaction(ENTITLEMENT_GENERATION_TABLE)
            .where({ user_id: userId, auth_generation: currentGeneration })
            .whereNull('invalidated_at')
            .first('auth_generation')
          : undefined;
        // A delayed logout from an older session must not revoke the active
        // user-wide snapshot or disturb the credential that currently refreshes it.
        if (currentGeneration && currentGeneration !== generation && currentIsActive) {
          await pruneExpiredGenerationTombstones(transaction, observedAt);
          return false;
        }
        const replacement = await transaction(ENTITLEMENT_GENERATION_TABLE)
          .where({ user_id: userId })
          .whereNull('invalidated_at')
          .orderBy('activated_at', 'desc')
          .first('auth_generation') as { auth_generation?: unknown } | undefined;
        const replacementGeneration = typeof replacement?.auth_generation === 'string'
          ? replacement.auth_generation.trim()
          : '';
        if (replacementGeneration) {
          const expiresAt = new Date(0).toISOString();
          await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE).insert({
            user_id: userId,
            lease_token: REGISTRATION_TOKEN,
            fencing_token: 1,
            expires_at: expiresAt,
            retry_after: null,
            invalidated_at: null,
            auth_generation: replacementGeneration,
          }).onConflict('user_id').merge({
            lease_token: REGISTRATION_TOKEN,
            fencing_token: transaction.raw(
              `${ENTITLEMENT_REFRESH_LEASE_TABLE}.fencing_token + 1`
            ),
            expires_at: expiresAt,
            retry_after: null,
            invalidated_at: null,
            auth_generation: replacementGeneration,
          });
          await pruneExpiredGenerationTombstones(transaction, observedAt);
          return false;
        }
      }
      await transaction('notification_repository_entitlements').where({ user_id: userId }).delete();
      await transaction('notification_repository_entitlement_snapshots').where({ user_id: userId }).delete();
      if (hasTombstones) {
        const invalidatedAt = new Date().toISOString();
        const expiresAt = new Date(0).toISOString();
        await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE).insert({
          user_id: userId,
          lease_token: INVALIDATION_TOKEN,
          fencing_token: 1,
          expires_at: expiresAt,
          retry_after: null,
          invalidated_at: invalidatedAt,
          auth_generation: generation,
        }).onConflict('user_id').merge({
          lease_token: INVALIDATION_TOKEN,
          fencing_token: transaction.raw(
            `${ENTITLEMENT_REFRESH_LEASE_TABLE}.fencing_token + 1`
          ),
          expires_at: expiresAt,
          retry_after: null,
          invalidated_at: invalidatedAt,
          auth_generation: generation,
        }).where((matchingGeneration) => matchingGeneration
          .whereNull('auth_generation')
          .orWhere('auth_generation', generation));
      } else if (hasRefreshLeases) {
        await transaction(ENTITLEMENT_REFRESH_LEASE_TABLE).where({ user_id: userId }).delete();
      }
      if (hasTombstones) {
        await pruneExpiredGenerationTombstones(transaction, new Date());
      }
      return true;
    });
  } catch (error) {
    logger.warn({ userId, error: error instanceof Error ? error.message : String(error) },
      'Failed to invalidate cached repository notification access');
    throw error;
  }
}
