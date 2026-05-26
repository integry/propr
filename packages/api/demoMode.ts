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

export function demoModeReadOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode() || !MUTATING_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  res.status(403).json({
    code: DEMO_MODE_READ_ONLY_CODE,
    error: 'Demo mode is read-only. Mutating requests are disabled.'
  });
}
