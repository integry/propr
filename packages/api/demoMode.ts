import type { NextFunction, Request, Response } from 'express';
import { DEMO_MODE_READ_ONLY_CODE, parseTruthyEnvValue } from '@propr/shared';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const DEMO_MODE_ACCESS_TOKEN = 'demo-mode';

export function isDemoMode(): boolean {
  return parseTruthyEnvValue(process.env.PROPR_DEMO_MODE);
}

export function getDemoUser(): Express.User {
  return {
    id: 'demo',
    login: 'demo',
    username: 'demo',
    displayName: 'Demo User',
    email: null,
    avatarUrl: null,
    accessToken: DEMO_MODE_ACCESS_TOKEN,
  };
}

function parseCommaSeparatedEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function getDemoVisibleUserIds(): string[] {
  const configuredIds = parseCommaSeparatedEnv(process.env.PROPR_DEMO_VISIBLE_USER_IDS);
  return configuredIds.length > 0 ? configuredIds : [getDemoUser().id];
}

export function isDemoDraftOwnerIdVisible(userId: unknown): boolean {
  return typeof userId === 'string' && getDemoVisibleUserIds().includes(userId);
}

function isDemoModeMetadataRequest(req: Request): boolean {
  return req.method.toUpperCase() === 'GET' &&
    (req.path === '/auth/demo-mode' || req.originalUrl === '/api/auth/demo-mode');
}

export function demoModeReadOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode() || !MUTATING_METHODS.has(req.method.toUpperCase()) || isDemoModeMetadataRequest(req)) {
    next();
    return;
  }

  res.status(403).json({
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
}
