import type { Knex } from 'knex';
import { createClient } from 'redis';
import { logger } from '@propr/core';
import { createSessionAuthGeneration } from '../authSessionGeneration.js';

const LEASE_TABLE = 'notification_repository_entitlement_refresh_leases';
const SESSION_PREFIX = 'propr:session:';

export interface RecoveredEntitlementCredential {
  userId: string;
  accessToken: string;
  sessionExpiresAt: number;
}

interface StoredSession {
  cookie?: { expires?: unknown };
  passport?: { user?: unknown };
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

function sessionCredential(session: StoredSession): RecoveredEntitlementCredential | undefined {
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

async function loadEligibleUserGenerations(database: Knex): Promise<Map<string, string | null>> {
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
  return new Map(rows.map(row => [
    row.user_id,
    typeof row.auth_generation === 'string' && row.auth_generation.trim()
      ? row.auth_generation
      : null,
  ]));
}

/** Rebuilds restart-safe schedules without persisting OAuth credentials in SQLite. */
export async function loadRecoverableEntitlementCredentials(
  database: Knex
): Promise<RecoveredEntitlementCredential[]> {
  const eligibleGenerations = await loadEligibleUserGenerations(database);
  if (eligibleGenerations.size === 0) return [];
  const sessionRedisHost = process.env.SESSION_REDIS_HOST || process.env.REDIS_HOST || 'redis';
  const sessionRedisPort = process.env.SESSION_REDIS_PORT || process.env.REDIS_PORT || '6379';
  const client = createClient({ url: `redis://${sessionRedisHost}:${sessionRedisPort}` });
  client.on('error', (error) => logger.warn({
    error: error instanceof Error ? error.message : String(error),
  }, 'Session Redis error during notification entitlement recovery'));
  const credentials = new Map<string, RecoveredEntitlementCredential>();
  try {
    await client.connect();
    for await (const key of client.scanIterator({ MATCH: `${SESSION_PREFIX}*`, COUNT: 100 })) {
      const stored = await client.get(key);
      if (!stored) continue;
      const session = parseStoredSession(stored);
      const credential = session ? sessionCredential(session) : undefined;
      if (!credential || !eligibleGenerations.has(credential.userId)) continue;
      const expectedGeneration = eligibleGenerations.get(credential.userId);
      const sessionId = key.slice(SESSION_PREFIX.length);
      if (expectedGeneration && (!sessionId
          || createSessionAuthGeneration(sessionId) !== expectedGeneration)) {
        continue;
      }
      const current = credentials.get(credential.userId);
      if (!current || current.sessionExpiresAt < credential.sessionExpiresAt) {
        credentials.set(credential.userId, credential);
      }
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) },
      'Could not recover repository entitlement schedules from active sessions');
    return [];
  } finally {
    if (client.isOpen) {
      try { await client.quit(); } catch { await client.disconnect().catch(() => undefined); }
    }
  }
  return [...credentials.values()].sort(
    (left, right) => right.sessionExpiresAt - left.sessionExpiresAt
  );
}
