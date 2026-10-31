import type { RequestHandler } from 'express';
import { isDemoViewer } from './demoMode.js';
import { requirePermission } from './permissionCheck.js';

export const requireManageSettings = requirePermission('instance.manage_settings');
export const requireManageAgents = requirePermission('instance.manage_agents');
export const requireManageMembers = requirePermission('instance.manage_members');
export const requireManageRuntime = requirePermission('instance.manage_runtime');

export const DEMO_LIVE_DATA_UNAVAILABLE_CODE = 'DEMO_MODE_LIVE_DATA_UNAVAILABLE';

/**
 * Agent Tank's demo feed contains synthetic data and is safe for the read-only
 * demo user. Real installations still require the agent-management permission.
 */
export const requireAgentTankUsageAccess: RequestHandler = (req, res, next) => {
    if (isDemoViewer(req.authorization)) {
        next();
        return;
    }
    requireManageAgents(req, res, next);
};

/**
 * The demo viewer reads the curated demo database only. Management reads that
 * probe the host, daemons, registries or stored credentials stay closed to it.
 */
export const refuseDemoViewer: RequestHandler = (req, res, next) => {
    if (!isDemoViewer(req.authorization)) {
        next();
        return;
    }
    res.status(403).json({
        error: 'Forbidden',
        code: DEMO_LIVE_DATA_UNAVAILABLE_CODE,
        message: 'This view reads live installation state, which the read-only demo does not expose.'
    });
};
