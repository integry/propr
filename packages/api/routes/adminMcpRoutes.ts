import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { db } from '@propr/core';
import { CONFIG_EVENT_CHANNEL } from '../services/configReloadSubscription.js';
import { MCP_SCOPES } from '../mcp/config.js';
import {
  loadMcpAdminSettings,
  saveMcpAdminSettingRows,
  resolveMcpStatus,
  invalidateMcpConfigCache,
  resetMcpKeyCheckValue,
} from '../mcp/configResolver.js';

interface AdminMcpRoutesDeps {
  database?: Knex;
  redisClient?: { publish(channel: string, message: string): Promise<unknown> };
}

async function logActivity(
  redisClient: AdminMcpRoutesDeps['redisClient'],
  description: string,
  username?: string,
): Promise<void> {
  if (!redisClient) return;
  try {
    const activity = {
      id: `activity-${Date.now()}-mcp`,
      type: 'mcp_settings_updated',
      timestamp: new Date().toISOString(),
      user: username,
      description,
      status: 'success',
    };
    await redisClient.publish('system:activity:log', JSON.stringify(activity));
  } catch { /* non-critical */ }
}

async function publishMcpUpdate(redisClient: AdminMcpRoutesDeps['redisClient']): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.publish(CONFIG_EVENT_CHANNEL, JSON.stringify({ type: 'config_update', subtype: 'mcp_settings_update', timestamp: Date.now() }));
  } catch { /* non-critical */ }
}

function validatePutSettingsBody(body: Record<string, unknown>): { error: string; code: string; status: number } | null {
  const { enabled, scopeCeiling, connectEnabled } = body;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return { error: 'enabled must be a boolean', code: 'INVALID_INPUT', status: 400 };
  }
  if (scopeCeiling !== undefined) {
    const invalid = !Array.isArray(scopeCeiling)
      || (scopeCeiling as unknown[]).some(s => typeof s !== 'string' || !(MCP_SCOPES as readonly string[]).includes(s as string));
    if (invalid) return { error: 'scopeCeiling must be an array of valid MCP scopes', code: 'INVALID_INPUT', status: 400 };
  }
  if (connectEnabled !== undefined && typeof connectEnabled !== 'boolean') {
    return { error: 'connectEnabled must be a boolean', code: 'INVALID_INPUT', status: 400 };
  }
  return null;
}

async function checkEnablePrerequisites(database: Knex): Promise<{ error: string; code: string; status: number } | null> {
  if (process.env.MCP_ENABLED === 'false') {
    return { error: 'MCP is disabled by operator configuration', code: 'OPERATOR_DISABLED', status: 403 };
  }
  if (process.env.NODE_ENV === 'test') return null;
  const status = await resolveMcpStatus(database);
  if (status.demoMode) return { error: 'MCP cannot be enabled in demo mode', code: 'DEMO_MODE', status: 403 };
  if (status.missingHttpsOrigin) return { error: 'MCP requires an HTTPS origin (API_PUBLIC_URL or GH_OAUTH_CALLBACK_URL)', code: 'MISSING_HTTPS_ORIGIN', status: 400 };
  if (status.missingSecretChain) return { error: 'MCP requires an encryption secret (PROPR_CREDENTIAL_ENCRYPTION_KEY, SYSTEM_TASK_SECRET, or SESSION_SECRET)', code: 'MISSING_SECRET_CHAIN', status: 400 };
  return null;
}

export function createAdminMcpRoutes({ database = db, redisClient }: AdminMcpRoutesDeps = {}) {
  async function getSettings(req: Request, res: Response): Promise<void> {
    try {
      const status = await resolveMcpStatus(database);
      const adminSettings = await loadMcpAdminSettings(database);
      res.json({
        status,
        settings: {
          enabled: adminSettings.enabled,
          scopeCeiling: adminSettings.scopeCeiling,
          connectEnabled: adminSettings.connectEnabled,
        },
        scopes: [...MCP_SCOPES],
      });
    } catch (error) {
      console.error('Failed to get MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to get MCP settings' });
    }
  }

  async function putSettings(req: Request, res: Response): Promise<void> {
    const body: Record<string, unknown> = req.body ?? {};
    const { enabled, scopeCeiling, connectEnabled } = body;

    const validationError = validatePutSettingsBody(body);
    if (validationError) { res.status(validationError.status).json({ error: validationError.error, code: validationError.code }); return; }

    try {
      if (enabled === true) {
        const prereqError = await checkEnablePrerequisites(database);
        if (prereqError) { res.status(prereqError.status).json({ error: prereqError.error, code: prereqError.code }); return; }
      }

      const updates: Record<string, string> = {};
      if (enabled !== undefined) updates.enabled = String(enabled);
      if (scopeCeiling !== undefined) updates.scope_ceiling = JSON.stringify(scopeCeiling);
      if (connectEnabled !== undefined) updates.connect_enabled = String(connectEnabled);

      if (Object.keys(updates).length > 0) {
        await saveMcpAdminSettingRows(updates, database);
        invalidateMcpConfigCache();
        await publishMcpUpdate(redisClient);
        const desc = enabled !== undefined ? (enabled ? 'enabled' : 'disabled') : 'updated';
        await logActivity(redisClient, `MCP server ${desc}`, req.user?.username);
      }

      const newStatus = await resolveMcpStatus(database);
      res.json({ status: newStatus });
    } catch (error) {
      console.error('Failed to update MCP admin settings:', error);
      res.status(500).json({ error: 'Failed to update MCP settings' });
    }
  }

  async function revokeAll(req: Request, res: Response): Promise<void> {
    try {
      const now = Date.now();
      // Count of grant rows this call invalidates. Rows an earlier sweep already
      // expired are left out so repeated invocations do not re-count them.
      const [counted] = await database('mcp_records')
        .where({ kind: 'grant' })
        .whereRaw('(expires_at IS NULL OR expires_at > ?)', [now])
        .count<Array<{ count: string | number }>>({ count: '*' });
      const revoked = Number(counted?.count ?? 0);

      // Delete rather than expire. Every value here is ciphertext sealed with the
      // current encryption key, and the key fingerprint is forgotten just below so
      // a rotated secret can be adopted; anything left behind would be unreadable
      // and its read path would throw instead of failing as an invalid grant.
      await database('mcp_records')
        .whereIn('kind', ['grant', 'access', 'refresh', 'code', 'pending', 'credential', 'client'])
        .delete();

      // Nothing usable remains that was encrypted under the previous secret.
      // Forgetting the key fingerprint clears the "Reconnect required" state and
      // lets an admin enable MCP again after a key rotation.
      await resetMcpKeyCheckValue(database);
      invalidateMcpConfigCache();
      await publishMcpUpdate(redisClient);

      await logActivity(redisClient, `Revoked all MCP connections (${revoked} grants invalidated)`, req.user?.username);
      res.json({ revoked, status: await resolveMcpStatus(database) });
    } catch (error) {
      console.error('Failed to revoke MCP grants:', error);
      res.status(500).json({ error: 'Failed to revoke MCP grants' });
    }
  }

  return { getSettings, putSettings, revokeAll };
}
