import type { Knex } from 'knex';
import {
  ENTITLEMENT_REFRESH_LEASE_TABLE,
  invalidateNotificationRepositoryEntitlements,
} from './notificationEntitlementFencing.js';

interface ScheduledEntitlementSession {
  authGeneration?: string;
  credentials: Map<string, string>;
  registrationEstablished: boolean;
  retry: boolean;
}

interface RestoredEntitlementSession {
  accessToken: string;
  authGeneration: string;
  credentials: Map<string, string>;
  registrationEstablished: boolean;
  retry: boolean;
}

interface ScheduledEntitlementInvalidationOptions {
  database: Knex;
  userId: string;
  authGeneration: string;
  entry?: ScheduledEntitlementSession;
  pendingAuthGeneration?: string;
  isClosed(): boolean;
  forgetPendingGeneration(): void;
  removeEntry(entry: ScheduledEntitlementSession): void;
  restoreEntry(session: RestoredEntitlementSession): void;
}

function ownsActiveSchedule(
  entry: ScheduledEntitlementSession | undefined,
  activeGeneration: string | undefined,
  invalidatedGeneration: string
): boolean {
  if (!entry) return false;
  return activeGeneration === invalidatedGeneration || activeGeneration === undefined;
}

/** Cancels local work first, then resumes only a durably selected live session. */
export async function invalidateScheduledEntitlementRefresh(
  options: ScheduledEntitlementInvalidationOptions
): Promise<void> {
  const generation = options.authGeneration.trim();
  const activeGeneration = options.entry?.authGeneration ?? options.pendingAuthGeneration;
  if (options.pendingAuthGeneration === generation) options.forgetPendingGeneration();

  const remainingCredentials = new Map(options.entry?.credentials);
  remainingCredentials.delete(generation);
  const removedActiveSchedule = ownsActiveSchedule(
    options.entry,
    activeGeneration,
    generation
  );
  const retainedRetry = options.entry?.retry ?? false;
  const retainedRegistration = options.entry?.registrationEstablished ?? false;
  if (removedActiveSchedule && options.entry) options.removeEntry(options.entry);
  else options.entry?.credentials.delete(generation);

  const invalidated = await invalidateNotificationRepositoryEntitlements(
    options.database,
    options.userId,
    generation
  );
  if (invalidated || !removedActiveSchedule || options.isClosed()) return;

  const replacement = await options.database(ENTITLEMENT_REFRESH_LEASE_TABLE)
    .where({ user_id: options.userId })
    .whereNull('invalidated_at')
    .first('auth_generation') as { auth_generation?: unknown } | undefined;
  const replacementGeneration = typeof replacement?.auth_generation === 'string'
    ? replacement.auth_generation.trim()
    : '';
  const accessToken = remainingCredentials.get(replacementGeneration);
  if (!replacementGeneration || !accessToken) return;
  options.restoreEntry({
    accessToken,
    authGeneration: replacementGeneration,
    credentials: remainingCredentials,
    registrationEstablished: retainedRegistration,
    retry: retainedRetry,
  });
}
