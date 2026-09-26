import assert from 'node:assert/strict';
import { createNotificationEvent, notificationService } from '@propr/core';

type Call = (name: string, args: Record<string, unknown>, mutation?: boolean) => Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface InboxNotificationFixture {
  call: Call; modern: boolean; repository: string; instanceId: string;
  client: {
    callTool: (args: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: unknown }>;
    readResource: (args: { uri: string }) => Promise<{ contents: unknown[] }>;
  };
}

/** Inbox-wide notification tools: ordering, filters, pagination, grant scoping and bulk actions. */
export async function verifyInboxNotifications({ call, client, modern, repository, instanceId }: InboxNotificationFixture): Promise<void> {
  const review = await createNotificationEvent({ kind: 'review', severity: 'warning', deduplicationKey: `fixture-review-${modern}`, occurredAt: new Date(Date.now() - 3000), title: 'Retry transient failures', body: 'Score 7/10 · 1 issue', target: { type: 'review', repository, prNumber: 42 }, recipients: ['123'] });
  const system = await createNotificationEvent({ kind: 'system_failure', severity: 'error', deduplicationKey: `fixture-system-${modern}`, occurredAt: new Date(Date.now() - 2000), title: 'Worker unavailable', body: 'Queue processing stopped', target: { type: 'system_failure', component: 'worker' }, recipients: ['123'] });
  const foreign = await createNotificationEvent({ kind: 'task', deduplicationKey: `fixture-foreign-${modern}`, occurredAt: new Date(Date.now() - 1000), title: 'Outside grant', body: 'Hidden', target: { type: 'task', repository: 'other/repo', taskId: `foreign-${modern}` }, recipients: ['123'] });
  const inbox = await call('list_notifications', {});
  assert.deepEqual(inbox.notifications.map((item: { id: string }) => item.id), [system.id, review.id]);
  assert.deepEqual((await call('list_notifications', { repository })).notifications.map((item: { id: string }) => item.id), [review.id]);
  assert.deepEqual((await call('list_notifications', { kinds: ['system_failure'] })).notifications.map((item: { id: string }) => item.id), [system.id]);
  const firstPage = await call('list_notifications', { limit: 1 });
  assert.deepEqual(firstPage.notifications.map((item: { id: string }) => item.id), [system.id]);
  assert.deepEqual((await call('list_notifications', { limit: 1, cursor: firstPage.nextCursor })).notifications.map((item: { id: string }) => item.id), [review.id]);
  assert.equal((await call('get_notification', { notificationId: review.id })).notification.body, 'Score 7/10 · 1 issue');
  const hidden = await client.callTool({ name: 'get_notification', arguments: { notificationId: foreign.id } }); assert.equal(hidden.isError, true);
  const resource = await client.readResource({ uri: `propr://instances/${instanceId}/notifications/${system.id}` });
  assert.equal(JSON.parse((resource.contents[0] as { text: string }).text).data.notification.id, system.id);
  const unread = await call('get_notification_unread_count', {});
  assert.deepEqual([unread.unreadCount, unread.repositories, unread.system.unreadCount], [2, [{ repository, unreadCount: 1 }], 1]);
  assert.equal((await call('mark_notification_read', { notificationId: system.id }, true)).state, 'completed');
  assert.equal((await call('get_notification_unread_count', { repository })).unreadCount, 1);
  const allRead = await call('mark_all_notifications_read', {}, true);
  assert.deepEqual(allRead.result.notificationIds, [review.id]);
  assert.deepEqual((await call('list_notifications', { unreadOnly: true })).notifications, []);
  const resumed = await call('clear_notifications', { cursor: firstPage.nextCursor }, true);
  assert.deepEqual([resumed.result.notificationIds, resumed.result.nextCursor, resumed.result.hasMore], [[review.id], null, false]);
  const cleared = await call('clear_notifications', {}, true);
  assert.deepEqual([cleared.result.notificationIds, cleared.result.hasMore], [[system.id], false]);
  assert.deepEqual((await call('list_notifications', {})).notifications, []);
  assert.equal((await call('get_notification', { notificationId: review.id })).notification.dismissedAt !== null, true);
  assert.equal((await notificationService.getNotification('123', foreign.id))!.dismissedAt, null);
}
