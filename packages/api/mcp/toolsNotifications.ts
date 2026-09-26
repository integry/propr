import { z } from 'zod';
import { encodeNotificationCursor, notificationService, NotificationQueryValidationError } from '@propr/core';
import { NOTIFICATION_KINDS, type Notification } from '@propr/shared';
import type { createNotificationRoutes } from '../routes/notificationRoutes.js';
import { projectNotificationPreviews } from '../services/previewMediaProjection.js';
import { callWorkflow } from './adapter.js';
import { McpError } from './config.js';
import type { McpPrincipal } from './policy.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, idSchema, ok, workflow } from './tools.js';

type NotificationRoutes = ReturnType<typeof createNotificationRoutes>;
type Match = (notification: Notification) => Promise<boolean>;
type Access = (repository: string | undefined) => Promise<boolean>;

// The Inbox store is shared by every repository. Scan it in bounded pages and
// hand back a cursor when the budget runs out, so a narrow grant cannot turn
// one call into an unbounded table walk.
const SCAN_PAGE_SIZE = 100;
const SCAN_PAGE_BUDGET = 10;
const BULK_LIMIT = 500;

const kindsSchema = z.array(z.enum(NOTIFICATION_KINDS)).min(1).max(NOTIFICATION_KINDS.length).optional();
const cursorSchema = z.string().max(512).optional();

function repositoryOf(notification: Pick<Notification, 'target'>): string | undefined {
  return 'repository' in notification.target ? notification.target.repository : undefined;
}

/**
 * Repository notifications follow the current grant and GitHub access. System
 * notifications have no repository and are addressed to the user directly, so
 * they belong to the unscoped Inbox view only.
 */
function notificationAccess(deps: ToolDeps, principal: McpPrincipal, repository: string | undefined, write: boolean): Access {
  const authorized = new Map<string, Promise<boolean>>();
  return async target => {
    if (!target) return !repository;
    if (repository) return target.toLowerCase() === repository.toLowerCase();
    const key = target.toLowerCase();
    if (!authorized.has(key)) authorized.set(key, deps.policy.repository(principal, target, write).then(() => true, error => {
      if (error instanceof McpError && error.status === 403) return false;
      throw error;
    }));
    return authorized.get(key)!;
  };
}

async function scanNotifications(principal: McpPrincipal, options: { cursor?: string; includeDismissed: boolean; limit: number; match: Match }): Promise<{ items: Notification[]; nextCursor: string | null }> {
  const items: Notification[] = [];
  let cursor = options.cursor;
  for (let page = 0; page < SCAN_PAGE_BUDGET; page++) {
    let response;
    try { response = await notificationService.listNotifications(principal.user.id, { cursor, limit: SCAN_PAGE_SIZE, includeDismissed: options.includeDismissed }); }
    catch (error) {
      if (error instanceof NotificationQueryValidationError) throw new McpError('INVALID_INPUT', 'Notification cursor is invalid.');
      throw error;
    }
    for (const [index, notification] of response.notifications.entries()) {
      if (!await options.match(notification)) continue;
      items.push(notification);
      if (items.length === options.limit) {
        const more = index < response.notifications.length - 1 || response.nextCursor !== null;
        return { items, nextCursor: more ? encodeNotificationCursor({ occurredAt: notification.occurredAt, eventId: notification.id }) : null };
      }
    }
    if (!response.nextCursor) return { items, nextCursor: null };
    cursor = response.nextCursor;
  }
  return { items, nextCursor: cursor ?? null };
}

async function readAccessible(principal: McpPrincipal, id: string, access: Access): Promise<Notification> {
  const notification = await notificationService.getNotification(principal.user.id, id);
  if (!notification || !await access(repositoryOf(notification))) throw new McpError('NOT_FOUND', 'Notification not found.', 404);
  return notification;
}

export function addNotificationTools(tools: McpTool[], deps: ToolDeps, notifications: NotificationRoutes): void {
  const { db } = deps;
  const update = (action: 'read' | 'dismiss', principal: McpPrincipal, id: string) =>
    callWorkflow(action === 'read' ? notifications.markRead : notifications.dismiss, principal, { params: { id } });

  tools.push({ name: 'list_notifications', description: 'List your Inbox notifications newest first, with their recap, severity, target and read/dismissed state. Without repository this is the whole Inbox: every repository in this grant plus system notifications. A page can hold fewer than limit items; continue with nextCursor while it is not null.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema.optional(), kinds: kindsSchema, unreadOnly: z.boolean().default(false), includeDismissed: z.boolean().default(false), cursor: cursorSchema, limit: z.number().int().min(1).max(100).default(20) }).strict(), run: async ({ principal, args }) => {
    const access = notificationAccess(deps, principal, args.repository, false);
    const { items, nextCursor } = await scanNotifications(principal, { cursor: args.cursor, includeDismissed: args.includeDismissed, limit: args.limit, match: async notification =>
      (!args.kinds || args.kinds.includes(notification.kind)) && (!args.unreadOnly || !notification.readAt) && access(repositoryOf(notification)) });
    return ok({ notifications: await projectNotificationPreviews(items), nextCursor });
  } });
  tools.push({ name: 'get_notification', description: 'Read one of your notifications, including a dismissed one.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema.optional(), notificationId: idSchema }).strict(), run: async ({ principal, args }) => {
    const notification = await readAccessible(principal, args.notificationId, notificationAccess(deps, principal, args.repository, false));
    return ok({ notification: (await projectNotificationPreviews([notification]))[0] });
  } });
  tools.push({ name: 'get_notification_unread_count', description: 'Count your unread Inbox notifications per repository in this grant and for system notifications.', scope: 'read', readOnly: true, schema: z.object({ repository: repositorySchema.optional() }).strict(), run: async ({ principal, args }) => {
    const repositoryExpression = "json_extract(event.target_json, '$.repository')";
    const rows = await db('notification_user_states as receipt')
      .join('notification_events as event', 'event.event_id', 'receipt.event_id')
      .where({ 'receipt.user_id': principal.user.id, 'receipt.inbox_enabled': true })
      .whereNull('receipt.read_at').whereNull('receipt.dismissed_at')
      .select(db.raw(`${repositoryExpression} as repository`)).count({ count: '*' })
      .groupByRaw(repositoryExpression) as Array<{ repository: string | null; count: number | string }>;
    const access = notificationAccess(deps, principal, args.repository, false);
    const repositories: Array<{ repository: string; unreadCount: number }> = [];
    let system = 0;
    for (const row of rows) {
      const count = Number(row.count);
      if (!row.repository) { if (!args.repository) system += count; continue; }
      if (await access(row.repository)) repositories.push({ repository: row.repository, unreadCount: count });
    }
    const unreadCount = system + repositories.reduce((total, row) => total + row.unreadCount, 0);
    return ok(args.repository ? { unreadCount, repositories } : { unreadCount, repositories, system: { unreadCount: system } });
  } });

  for (const action of ['read', 'dismiss'] as const) tools.push({ name: action === 'read' ? 'mark_notification_read' : 'dismiss_notification', description: action === 'read' ? 'Mark one of your notifications read. Omit repository for a system notification.' : 'Dismiss one of your notifications from the Inbox. Omit repository for a system notification.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema.optional(), notificationId: idSchema }).strict(), run: async ({ principal, args }) => {
    await readAccessible(principal, args.notificationId, notificationAccess(deps, principal, args.repository, true));
    const response = await update(action, principal, args.notificationId);
    return ok({ notification: (response.data as { notification: unknown }).notification });
  } });
  tools.push({ name: 'update_notifications', description: 'Read or dismiss an explicit bounded set of your notifications. With repository every notification must belong to it; without it each must be a system notification or belong to a repository in this grant.', scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema.optional(), notificationIds: z.array(idSchema).min(1).max(100), action: z.enum(['read', 'dismiss']) }).strict(), run: async ({ principal, args }) => {
    const ids = [...new Set<string>(args.notificationIds)];
    const access = notificationAccess(deps, principal, args.repository, true);
    for (const id of ids) {
      const notification = await notificationService.getNotification(principal.user.id, id);
      if (!notification || !await access(repositoryOf(notification))) throw new McpError('NOT_FOUND', 'One or more notifications are outside this grant or repository.', 404);
    }
    for (const id of ids) await update(args.action, principal, id);
    return ok({ action: args.action, notificationIds: ids });
  } });
  for (const action of ['dismiss', 'read'] as const) tools.push({ name: action === 'dismiss' ? 'clear_notifications' : 'mark_all_notifications_read', description: `${action === 'dismiss' ? 'Dismiss (clear) every active notification' : 'Mark every unread notification read'} in the Inbox, optionally limited to one repository or to kinds. Without repository this covers system notifications and every repository in this grant. Processes up to ${BULK_LIMIT} per call and scans a bounded window; while hasMore is true, call again with cursor set to the returned nextCursor.`, scope: 'plan', schema: z.object({ ...mutationShape, repository: repositorySchema.optional(), kinds: kindsSchema, cursor: cursorSchema }).strict(), run: async ({ principal, args }) => {
    const access = notificationAccess(deps, principal, args.repository, true);
    // Resume from the cursor so a window of non-matching notifications (other
    // repositories or kinds, or already read) cannot be rescanned forever.
    const { items, nextCursor } = await scanNotifications(principal, { cursor: args.cursor, includeDismissed: false, limit: BULK_LIMIT, match: async notification =>
      (!args.kinds || args.kinds.includes(notification.kind)) && (action === 'dismiss' || !notification.readAt) && access(repositoryOf(notification)) });
    for (const notification of items) await update(action, principal, notification.id);
    return ok({ action, count: items.length, notificationIds: items.map(notification => notification.id), nextCursor, hasMore: nextCursor !== null });
  } });

  workflow(tools, { name: 'get_notification_preferences', description: 'Read your notification preferences.', scope: 'read', readOnly: true, schema: z.object({}).strict() }, notifications.getPreferences, () => ({}));
  workflow(tools, { name: 'set_notification_category_preferences', description: 'Enable or disable inbox and push delivery for a notification category. Browser push subscription requires browser setup.', scope: 'plan', schema: z.object({ ...mutationShape, category: z.enum(NOTIFICATION_KINDS), inboxEnabled: z.boolean().optional(), pushEnabled: z.boolean().optional() }).strict() }, notifications.updatePreferences, args => ({ body: { preferences: { [args.category]: { inboxEnabled: args.inboxEnabled, pushEnabled: args.pushEnabled } } } }));
  workflow(tools, { name: 'update_notification_preferences', description: 'Update your badge and quiet-hours preferences. Null start/end clears quiet hours.', scope: 'plan', schema: z.object({ ...mutationShape, badgeEnabled: z.boolean().optional(), quietHours: z.object({ start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional(), timezone: z.string().max(100).optional() }).strict().optional() }).strict() }, notifications.updatePreferences, args => ({ body: { badgeEnabled: args.badgeEnabled, quietHours: args.quietHours } }));
}
