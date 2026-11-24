import type { Request, Response } from 'express';
import {
  IDLE_SHUTDOWN_AFTER_ENV,
  IDLE_SHUTDOWN_ENV,
  IDLE_STATUS_REDIS_KEY,
  formatIdleShutdownDuration,
  isIdleShutdownEnvironmentManaged,
  parseIdleShutdownDuration,
  parseIdleShutdownStatus,
  resolveIdleShutdownConfig,
  type IdleShutdownStatus,
  type StoredIdleShutdownSetting,
} from '@propr/shared';
import { loadStoredIdleShutdownSetting, saveStoredIdleShutdownSetting } from '@propr/core';

/**
 * Instance-admin control for opt-in idle shutdown (issue #3770). The
 * environment pins the setting when `PROPR_IDLE_SHUTDOWN` or
 * `PROPR_IDLE_SHUTDOWN_AFTER` is set; otherwise the Web UI saves it to the
 * instance settings, and the daemon picks the change up on its next check.
 */

interface StatusReader {
  get(key: string): Promise<string | null>;
}

export interface IdleShutdownRouteDeps {
  redisClient: StatusReader;
  env?: NodeJS.ProcessEnv;
  loadStored?: typeof loadStoredIdleShutdownSetting;
  saveStored?: typeof saveStoredIdleShutdownSetting;
}

export interface IdleShutdownSettingsResponse {
  enabled: boolean;
  afterMs: number;
  after: string;
  source: 'environment' | 'settings' | 'default';
  environmentManaged: boolean;
  environment: Record<string, string | null>;
  warnings: string[];
  status: IdleShutdownStatus | null;
}

async function readStatus(redis: StatusReader): Promise<IdleShutdownStatus | null> {
  try {
    const raw = await redis.get(IDLE_STATUS_REDIS_KEY);
    return raw ? parseIdleShutdownStatus(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function createIdleShutdownRoutes(deps: IdleShutdownRouteDeps) {
  const env = () => deps.env ?? process.env;
  const loadStored = deps.loadStored ?? loadStoredIdleShutdownSetting;
  const saveStored = deps.saveStored ?? saveStoredIdleShutdownSetting;

  async function describe(): Promise<IdleShutdownSettingsResponse> {
    const environment = env();
    const config = resolveIdleShutdownConfig(environment, await loadStored());
    return {
      enabled: config.enabled,
      afterMs: config.afterMs,
      after: formatIdleShutdownDuration(config.afterMs),
      source: config.source,
      environmentManaged: isIdleShutdownEnvironmentManaged(environment),
      environment: {
        [IDLE_SHUTDOWN_ENV]: environment[IDLE_SHUTDOWN_ENV]?.trim() || null,
        [IDLE_SHUTDOWN_AFTER_ENV]: environment[IDLE_SHUTDOWN_AFTER_ENV]?.trim() || null,
      },
      warnings: config.warnings,
      status: await readStatus(deps.redisClient),
    };
  }

  async function getSettings(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await describe());
    } catch {
      res.status(503).json({ error: 'Idle shutdown settings are unavailable', code: 'SETTINGS_UNAVAILABLE' });
    }
  }

  async function putSettings(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter(key => key !== 'enabled' && key !== 'after');
    if (unknown.length > 0 || typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'Body must be { enabled: boolean, after?: string } (for example "15m")', code: 'INVALID_INPUT' });
      return;
    }
    if (isIdleShutdownEnvironmentManaged(env())) {
      res.status(409).json({
        error: `Idle shutdown is set by ${IDLE_SHUTDOWN_ENV}/${IDLE_SHUTDOWN_AFTER_ENV} in the environment; change it there`,
        code: 'ENVIRONMENT_MANAGED',
      });
      return;
    }
    try {
      const current = await loadStored();
      const afterMs = body.after === undefined ? current?.afterMs ?? resolveIdleShutdownConfig({}).afterMs : parseIdleShutdownDuration(body.after);
      if (afterMs === null) {
        res.status(400).json({ error: 'after must be a duration between 1m and 24h, such as "15m" or "1h30m"', code: 'INVALID_INPUT' });
        return;
      }
      const setting: StoredIdleShutdownSetting = { enabled: body.enabled, afterMs };
      if (!await saveStored(setting)) throw new Error('save failed');
      res.json(await describe());
    } catch {
      res.status(503).json({ error: 'Idle shutdown settings could not be saved', code: 'SETTINGS_UNAVAILABLE' });
    }
  }

  return { getSettings, putSettings };
}
