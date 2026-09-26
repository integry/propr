import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { loadMcpConfig, type McpConfig, type McpScope, MCP_SCOPES } from './config.js';
import { isDemoMode } from '../demoMode.js';

export const DEFAULT_UI_SCOPE_CEILING: McpScope[] = ['read', 'plan', 'review'];
const MCP_ENCRYPTION_CONTEXT = 'propr:mcp:v1';
const CACHE_TTL_MS = 5_000;

export interface McpAdminSettings {
  enabled: boolean;
  instanceId?: string;
  keyCheckValue?: string;
  scopeCeiling: McpScope[];
  connectEnabled: boolean;
}

export interface McpStatus {
  enabled: boolean;
  operatorForced?: 'on' | 'off';
  demoMode?: boolean;
  missingHttpsOrigin?: boolean;
  missingSecretChain?: boolean;
  keyChanged?: boolean;
  origin?: string;
  resource?: string;
  instanceId?: string;
  connectAvailable?: boolean;
  scopeCeiling: McpScope[];
}

// Module-level cache
let _cachedConfig: McpConfig | null | undefined = undefined;
let _cacheTimestamp = 0;
let _cachedOrigin: string | undefined = undefined;
let _cachedEnabled = false;
let _cachedScopeCeiling: McpScope[] | undefined = undefined;

// Only drop the resolved config, forcing the next resolve to re-read. The
// derived values below stay at their last resolved state: the synchronous
// readers have no way to resolve for themselves, and blanking them would make
// invalidation itself report MCP as off (dropping the consent origin from the
// redirect allowlist) until something unrelated happened to re-resolve. The
// next resolveMcpConfig() replaces them; callers that need that promptly
// (the config-reload subscriber) re-resolve right after invalidating.
export function invalidateMcpConfigCache(): void {
  _cachedConfig = undefined;
  _cacheTimestamp = 0;
}

/** Synchronous reads for middleware and CORS setup. Reflects last resolved state. */
export function getMcpOriginSync(): string | undefined { return _cachedOrigin; }
export function isMcpEnabledSync(): boolean { return _cachedEnabled; }
/** Admin scope ceiling from the last resolve, or undefined when no ceiling applies. */
export function getMcpScopeCeilingSync(): McpScope[] | undefined { return _cachedScopeCeiling; }

function cacheResolved(config: McpConfig | null, now: number, origin?: string): McpConfig | null {
  _cachedConfig = config;
  _cacheTimestamp = now;
  _cachedOrigin = config?.origin ?? origin;
  _cachedEnabled = config !== null;
  _cachedScopeCeiling = config?.scopeCeiling;
  return config;
}

export async function loadMcpAdminSettings(database: Knex = db): Promise<McpAdminSettings> {
  const rows = await database('mcp_admin_settings').select<Array<{ key: string; value: string }>>();
  const settings: McpAdminSettings = { enabled: false, scopeCeiling: DEFAULT_UI_SCOPE_CEILING, connectEnabled: true };
  for (const row of rows) {
    switch (row.key) {
      case 'enabled': settings.enabled = row.value === 'true'; break;
      case 'instance_id': settings.instanceId = row.value; break;
      case 'key_check_value': settings.keyCheckValue = row.value; break;
      case 'scope_ceiling': {
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (Array.isArray(parsed)) settings.scopeCeiling = (parsed as string[]).filter(s => (MCP_SCOPES as readonly string[]).includes(s)) as McpScope[];
        } catch { /* ignore */ }
        break;
      }
      case 'connect_enabled': settings.connectEnabled = row.value !== 'false'; break;
    }
  }
  return settings;
}

/**
 * Forget the encryption-key fingerprint so a rotated secret can be adopted.
 * Only meaningful once the records encrypted under the previous key are gone
 * (see revokeAll in adminMcpRoutes, which deletes them).
 */
export async function resetMcpKeyCheckValue(database: Knex = db): Promise<void> {
  await database('mcp_admin_settings').where({ key: 'key_check_value' }).delete();
}

/**
 * Persist a freshly generated instance identity without overwriting one that
 * another process (or an earlier concurrent resolve) already claimed, then
 * adopt whatever value actually won. The identity has to be single-valued:
 * McpOAuthProvider.grant() rejects grants minted under any other ID, so a
 * last-writer-wins merge here would strand the loser's in-memory config.
 */
async function claimMcpInstanceId(candidate: string, database: Knex): Promise<string> {
  await database('mcp_admin_settings')
    .insert({ key: 'instance_id', value: candidate, updated_at: Date.now() })
    .onConflict('key')
    .ignore();
  const row = await database('mcp_admin_settings')
    .where({ key: 'instance_id' })
    .first<{ value: string } | undefined>('value');
  return row?.value ?? candidate;
}

export async function saveMcpAdminSettingRows(updates: Record<string, string>, database: Knex = db): Promise<void> {
  const now = Date.now();
  const rows = Object.entries(updates).map(([key, value]) => ({ key, value, updated_at: now }));
  if (rows.length > 0) await database('mcp_admin_settings').insert(rows).onConflict('key').merge();
}

function deriveEncryptionKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  if (env.MCP_ENCRYPTION_KEY) {
    const raw = Buffer.from(env.MCP_ENCRYPTION_KEY, 'base64');
    return raw.length === 32 ? raw : undefined;
  }
  const secret = env.PROPR_CREDENTIAL_ENCRYPTION_KEY?.trim()
    || env.SYSTEM_TASK_SECRET?.trim()
    || env.SESSION_SECRET?.trim();
  if (!secret) return undefined;
  return createHash('sha256').update(MCP_ENCRYPTION_CONTEXT).update('\0').update(secret).digest();
}

function deriveKeyCheckValue(key: Buffer): string {
  return createHash('sha256').update('propr:mcp:key-check').update('\0').update(key).digest('hex');
}

function derivePublicOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    env.MCP_PUBLIC_ORIGIN,
    env.API_PUBLIC_URL ? (() => { try { return new URL(env.API_PUBLIC_URL!).origin; } catch { return undefined; } })() : undefined,
    env.GH_OAUTH_CALLBACK_URL ? (() => { try { return new URL(env.GH_OAUTH_CALLBACK_URL!).origin; } catch { return undefined; } })() : undefined,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c);
      if (u.protocol === 'https:') return u.origin;
    } catch { /* skip */ }
  }
  return undefined;
}

export async function resolveMcpConfig(database: Knex = db, env: NodeJS.ProcessEnv = process.env): Promise<McpConfig | null> {
  // env-managed path: keep existing behavior unchanged
  if (env.MCP_ENABLED === 'true') {
    const config = loadMcpConfig(env) ?? null;
    _cachedOrigin = config?.origin;
    _cachedEnabled = config !== null;
    _cachedScopeCeiling = config?.scopeCeiling;
    return config;
  }
  // hard-disabled by operator
  if (env.MCP_ENABLED === 'false' || isDemoMode()) {
    _cachedOrigin = undefined;
    _cachedEnabled = false;
    _cachedScopeCeiling = undefined;
    return null;
  }
  // check TTL cache
  const now = Date.now();
  if (_cachedConfig !== undefined && now - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedConfig;
  }
  const adminSettings = await loadMcpAdminSettings(database);
  if (!adminSettings.enabled) return cacheResolved(null, now);
  const origin = derivePublicOrigin(env);
  if (!origin) return cacheResolved(null, now);
  const encryptionKey = deriveEncryptionKey(env);
  if (!encryptionKey) return cacheResolved(null, now);
  // check key integrity
  const expectedCheck = deriveKeyCheckValue(encryptionKey);
  if (adminSettings.keyCheckValue && adminSettings.keyCheckValue !== expectedCheck) return cacheResolved(null, now, origin);
  // resolve instance ID
  let instanceId = env.MCP_INSTANCE_ID || adminSettings.instanceId;
  if (!instanceId) {
    instanceId = await claimMcpInstanceId(randomBytes(16).toString('base64url').slice(0, 24), database);
  }
  if (!adminSettings.keyCheckValue) {
    await saveMcpAdminSettingRows({ key_check_value: expectedCheck }, database);
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(instanceId)) return cacheResolved(null, now);
  return cacheResolved({ origin, resource: `${origin}/api/mcp`, instanceId, encryptionKey, scopeCeiling: adminSettings.scopeCeiling }, now);
}

export async function resolveMcpStatus(database: Knex = db, env: NodeJS.ProcessEnv = process.env): Promise<McpStatus> {
  const base: McpStatus = { enabled: false, scopeCeiling: DEFAULT_UI_SCOPE_CEILING };
  if (isDemoMode()) return { ...base, demoMode: true };
  if (env.MCP_ENABLED === 'true') {
    const cfg = loadMcpConfig(env) ?? null;
    const adminSettings = await loadMcpAdminSettings(database);
    return { enabled: cfg !== null, operatorForced: 'on', origin: cfg?.origin, resource: cfg?.resource, instanceId: cfg?.instanceId, scopeCeiling: adminSettings.scopeCeiling };
  }
  if (env.MCP_ENABLED === 'false') {
    return { ...base, operatorForced: 'off' };
  }
  const adminSettings = await loadMcpAdminSettings(database);
  const origin = derivePublicOrigin(env);
  const encryptionKey = deriveEncryptionKey(env);
  const keyChanged = !!(adminSettings.keyCheckValue && encryptionKey && adminSettings.keyCheckValue !== deriveKeyCheckValue(encryptionKey));
  return {
    enabled: adminSettings.enabled && !!origin && !!encryptionKey && !keyChanged,
    missingHttpsOrigin: !origin,
    missingSecretChain: !encryptionKey,
    keyChanged,
    origin: origin,
    resource: origin ? `${origin}/api/mcp` : undefined,
    instanceId: env.MCP_INSTANCE_ID || adminSettings.instanceId,
    connectAvailable: false,
    scopeCeiling: adminSettings.scopeCeiling,
  };
}
