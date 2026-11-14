import type { CurrentUser } from '../../api/proprTypes';
import { userHasPermission } from '../../contexts/AuthContext';

/** Instance data (database export, repository cache cleanup). */
export const canManageInstanceStorage = (user: CurrentUser | null): user is CurrentUser =>
  user?.role === 'admin' && userHasPermission(user, 'instance.manage_settings');

/** Follow-up handoffs held for an operator. */
export const canManageHeldFollowups = (user: CurrentUser | null): user is CurrentUser =>
  user?.role === 'admin' && userHasPermission(user, 'instance.manage_runtime');

/** Plugins: a durable administrator who may change instance settings, as the plugin API requires. */
export const canManagePlugins = (user: CurrentUser | null): user is CurrentUser =>
  user?.role === 'admin' && userHasPermission(user, 'instance.manage_settings');
