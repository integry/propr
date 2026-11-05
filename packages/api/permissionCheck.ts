import type { Request, RequestHandler } from 'express';
import type { InstancePermission } from '@propr/shared';
import { isDemoViewer, isDemoViewerRead } from './demoMode.js';

export function hasPermission(req: Request, permission: InstancePermission): boolean {
  const authorization = req.authorization;
  if (authorization?.source === 'demo') {
    // The demo viewer set only grants reads, and only while demo mode is on.
    return isDemoViewer(authorization) && isDemoViewerRead(req.method) && authorization.permissions.includes(permission);
  }
  return authorization?.permissions.includes(permission) === true;
}

export function requirePermission(permission: InstancePermission): RequestHandler {
  return (req, res, next) => {
    if (hasPermission(req, permission)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Forbidden',
      code: 'INSUFFICIENT_INSTANCE_PERMISSION',
      message: `This action requires the ${permission} permission.`
    });
  };
}
