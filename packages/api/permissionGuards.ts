import { requirePermission } from './authorization.js';

export const requireManageSettings = requirePermission('instance.manage_settings');
export const requireManageAgents = requirePermission('instance.manage_agents');
export const requireManageMembers = requirePermission('instance.manage_members');
export const requireManageRuntime = requirePermission('instance.manage_runtime');
