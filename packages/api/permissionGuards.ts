import type { RequestHandler } from 'express';
import { requirePermission } from './authorization.js';

export const requireManageSettings = requirePermission('instance.manage_settings');
export const requireManageAgents = requirePermission('instance.manage_agents');
export const requireManageMembers = requirePermission('instance.manage_members');
export const requireManageRuntime = requirePermission('instance.manage_runtime');

/**
 * Agent Tank's demo feed contains synthetic data and is safe for the read-only
 * demo user. Real installations still require the agent-management permission.
 */
export const requireAgentTankUsageAccess: RequestHandler = (req, res, next) => {
    if (req.authorization?.source === 'demo') {
        next();
        return;
    }
    requireManageAgents(req, res, next);
};
