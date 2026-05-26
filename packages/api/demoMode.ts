import type { NextFunction, Request, Response } from 'express';

export const DEMO_MODE_READ_ONLY_CODE = 'DEMO_MODE_READ_ONLY';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isDemoMode(): boolean {
  return process.env.PROPR_DEMO_MODE === 'true';
}

export function getDemoUser(): Express.User {
  return {
    id: 'demo',
    username: 'demo',
    displayName: 'Demo User',
    email: null,
    avatarUrl: null,
    accessToken: 'demo-mode',
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
