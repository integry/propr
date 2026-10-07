import type { Request, RequestHandler } from 'express';
import type { InstancePermission } from '@propr/shared';

export function hasPermission(req: Request, permission: InstancePermission): boolean {
  return req.authorization?.permissions.includes(permission) === true;
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
