import type { Knex } from 'knex';
import { isNotificationTimerDelay, logger, withNotificationDeadline } from '@propr/core';
import { createSessionAuthGeneration } from '../authSessionGeneration.js';
import { createSessionRedisClient } from '../serverRuntime.js';

const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';
const GENERATION_TABLE = 'notification_repository_entitlement_generations';
const SESSION_PREFIX = 'propr:session:';
const SESSION_SCAN_BATCH_SIZE = 100;
const DEFAULT_MAX_SCANNED_SESSIONS = 10_000;
const DEFAULT_RECOVERY_OPERATION_TIMEOUT_MS = 5_000;
const DEFAULT_RECOVERY_TOTAL_TIMEOUT_MS = 15_000;

export interface RecoveredEntitlementSessionCredential {
  accessToken: string;
  sessionExpiresAt: number;
  authGeneration: string;
}

export interface RecoveredEntitlementCredential {
  userId: string;
  accessToken: string;
  sessionExpiresAt: number;
  authGeneration?: string;
  /** Every live session retained for logout fallback after restart. */
  sessionCredentials?: readonly RecoveredEntitlementSessionCredential[];
}

interface StoredSession {
  cookie?: { expires?: unknown };
  passport?: { user?: unknown };
}

export interface EntitlementSessionRecoveryOptions {
  maxCredentials?: number;
  maxScannedSessions?: number;
  operationTimeoutMs?: number;
  totalTimeoutMs?: number;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseStoredSession(value: string): StoredSession | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as StoredSession
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionCredential(session: StoredSession): Omit<RecoveredEntitlementCredential,
  'authGeneration'> | undefined {
  if (typeof session.passport?.user !== 'object' || session.passport.user === null) {
    return undefined;
  }
  const user = session.passport.user as Record<string, unknown>;
  const userId = typeof user.id === 'string' ? user.id.trim() : '';
  const accessToken = typeof user.accessToken === 'string' ? user.accessToken.trim() : '';
  if (!userId || !accessToken || user.githubAuthInvalid === true) return undefined;
  const parsedExpiry = typeof session.cookie?.expires === 'string'
    ? Date.parse(session.cookie.expires)
    : Number.NaN;
  return Number.isFinite(parsedExpiry) && parsedExpiry > Date.now()
    ? { userId, accessToken, sessionExpiresAt: parsedExpiry }
    : undefined;
}

interface EligibleUserGenerations {
  scheduledAuthGeneration: string | null;
  activeAuthGenerations: Set<string> | null;
}

async function loadEligibleUserGenerations(
  database: Knex
): Promise<Map<string, EligibleUserGenerations>> {
  if (!await database.schema.hasTable(LEASE_TABLE)) return new Map();
  const hasAuthGeneration = await database.schema.hasColumn(LEASE_TABLE, 'auth_generation');
  const query = database(LEASE_TABLE).select(
    'user_id',
    ...(hasAuthGeneration ? ['auth_generation'] : [])
  );
  if (await database.schema.hasColumn(LEASE_TABLE, 'invalidated_at')) {
    query.whereNull('invalidated_at');
  }
  const rows = await query as Array<{ user_id: string; auth_generation?: unknown }>;
  const eligible = new Map<string, EligibleUserGenerations>(rows.map(row => [
    row.user_id,
    {
      scheduledAuthGeneration: typeof row.auth_generation === 'string'
        && row.auth_generation.trim() ? row.auth_generation.trim() : null,
      activeAuthGenerations: null,
    },
  ]));
  if (!await database.schema.hasTable(GENERATION_TABLE)) return eligible;
  const generations = await database(GENERATION_TABLE)
    .select('user_id', 'auth_generation')
    .whereNull('invalidated_at') as Array<{ user_id: string; auth_generation: unknown }>;
  for (const entry of eligible.values()) entry.activeAuthGenerations = new Set();
  for (const row of generations) {
    const generation = typeof row.auth_generation === 'string'
      ? row.auth_generation.trim()
      : '';
    const entry = eligible.get(row.user_id);
    if (entry && generation) entry.activeAuthGenerations?.add(generation);
  }
  for (const [userId, entry] of eligible) {
    if (entry.activeAuthGenerations?.size === 0
        || (entry.scheduledAuthGeneration
          && !entry.activeAuthGenerations?.has(entry.scheduledAuthGeneration))) {
      eligible.delete(userId);
    }
  }
  return eligible;
}

/** Rebuilds restart-safe schedules without persisting OAuth credentials in SQLite. */
export async function loadRecoverableEntitlementCredentials(
  database: Knex,
  options: EntitlementSessionRecoveryOptions = {}
): Promise<RecoveredEntitlementCredential[]> {
  const eligibleGenerations = await loadEligibleUserGenerations(database);
  if (eligibleGenerations.size === 0) return [];
  const maxCredentials = positiveSafeInteger(
    options.maxCredentials ?? eligibleGenerations.size,
    'notification entitlement recovery credential limit'
  );
  const maxScannedSessions = positiveSafeInteger(
    options.maxScannedSessions ?? DEFAULT_MAX_SCANNED_SESSIONS,
    'notification entitlement recovery scan limit'
  );
  const operationTimeoutMs = options.operationTimeoutMs
    ?? DEFAULT_RECOVERY_OPERATION_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_RECOVERY_TOTAL_TIMEOUT_MS;
  if (!isNotificationTimerDelay(operationTimeoutMs)
      || !isNotificationTimerDelay(totalTimeoutMs)) {
    throw new TypeError('notification entitlement recovery deadlines must be schedulable');
  }
  const client = createSessionRedisClient(operationTimeoutMs);
  client.on('error', (error) => logger.warn({
    error: error instanceof Error ? error.message : String(error),
  }, 'Session Redis error during notification entitlement recovery'));
  const credentials = new Map<string, Map<string, RecoveredEntitlementSessionCredential>>();
  try {
    await withNotificationDeadline(
      client.connect(),
      operationTimeoutMs,
      'connecting to session Redis for notification entitlement recovery'
    );
    await withNotificationDeadline((async () => {
      let cursor = 0;
      let scanned = 0;
      do {
        const page = await withNotificationDeadline(
          client.scan(cursor, { MATCH: `${SESSION_PREFIX}*`, COUNT: SESSION_SCAN_BATCH_SIZE }),
          operationTimeoutMs,
          'scanning sessions for notification entitlement recovery'
        );
        cursor = page.cursor;
        const keys = page.keys.slice(0, maxScannedSessions - scanned);
        scanned += keys.length;
        if (keys.length > 0) {
          const storedSessions = await withNotificationDeadline(
            client.mGet(keys),
            operationTimeoutMs,
            'loading sessions for notification entitlement recovery'
          );
          for (let index = 0; index < keys.length; index++) {
            const stored = storedSessions[index];
            if (!stored) continue;
            const session = parseStoredSession(stored);
            const credential = session ? sessionCredential(session) : undefined;
            if (!credential || !eligibleGenerations.has(credential.userId)) continue;
            const eligibility = eligibleGenerations.get(credential.userId)!;
            const sessionId = keys[index].slice(SESSION_PREFIX.length);
            const sessionGeneration = sessionId
              ? createSessionAuthGeneration(sessionId)
              : undefined;
            if (!sessionGeneration
                || (eligibility.activeAuthGenerations !== null
                  && !eligibility.activeAuthGenerations.has(sessionGeneration))
                || (eligibility.activeAuthGenerations === null
                  && eligibility.scheduledAuthGeneration
                  && sessionGeneration !== eligibility.scheduledAuthGeneration)) {
              continue;
            }
            let userCredentials = credentials.get(credential.userId);
            if (!userCredentials) {
              userCredentials = new Map();
              credentials.set(credential.userId, userCredentials);
            }
            const current = userCredentials.get(sessionGeneration);
            if (!current || current.sessionExpiresAt < credential.sessionExpiresAt) {
              userCredentials.set(sessionGeneration, {
                accessToken: credential.accessToken,
                sessionExpiresAt: credential.sessionExpiresAt,
                authGeneration: sessionGeneration,
              });
            }
          }
        }
      } while (cursor !== 0 && scanned < maxScannedSessions);
    })(), totalTimeoutMs, 'recovering notification entitlement sessions');
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) },
      'Could not recover repository entitlement schedules from active sessions');
    return [];
  } finally {
    if (client.isOpen) {
      try {
        await withNotificationDeadline(
          client.quit(),
          operationTimeoutMs,
          'closing notification entitlement recovery Redis client'
        );
      } catch {
        await client.disconnect().catch(() => undefined);
      }
    }
  }
  const recovered = [...credentials].flatMap(([userId, userCredentials]) => {
    const eligibility = eligibleGenerations.get(userId);
    if (!eligibility) return [];
    const sessions = [...userCredentials.values()].sort(
      (left, right) => right.sessionExpiresAt - left.sessionExpiresAt
    );
    const scheduled = eligibility.scheduledAuthGeneration
      ? userCredentials.get(eligibility.scheduledAuthGeneration)
      : sessions[0];
    return scheduled ? [{ ...scheduled, userId, sessionCredentials: sessions }] : [];
  });
  return recovered.sort(
    (left, right) => right.sessionExpiresAt - left.sessionExpiresAt
  ).slice(0, maxCredentials);
}
