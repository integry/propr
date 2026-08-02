import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const tsc = path.join(workspace, 'node_modules/typescript/bin/tsc');

test('builds and exposes the notification contract from @propr/shared', async () => {
  execFileSync(process.execPath, [tsc, '--project', 'packages/shared/tsconfig.json'], {
    cwd: workspace,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, [
    tsc,
    '--noEmit',
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    'test/fixtures/notificationPublicEntrypoint.ts',
  ], {
    cwd: workspace,
    stdio: 'pipe',
  });

  const entrypoint = await import(
    pathToFileURL(path.join(workspace, 'packages/shared/dist/index.js')).href
  );
  const runtimeExports = [
    'MAX_CANONICAL_TIMESTAMP_EPOCH_MS',
    'NOTIFICATION_ACTION_TYPES',
    'NOTIFICATION_KINDS',
    'NOTIFICATION_PAYLOAD_LIMITS',
    'NOTIFICATION_SEVERITIES',
    'NOTIFICATION_SOURCE_ACTIVITY_TYPES',
    'NOTIFICATION_SOURCE_ACTIVITY_STATUSES',
    'PUSH_DELIVERY_ATTEMPT_STATUSES',
    'PUSH_DELIVERY_STATUSES',
    'WEB_PUSH_ENDPOINT_HOSTS',
    'WEB_PUSH_ENDPOINT_HOST_SUFFIXES',
    'iso8601TimestampSchema',
    'normalizeISO8601Timestamp',
    'notificationActionSchema',
    'notificationEventSchema',
    'notificationListResponseSchema',
    'notificationPreferenceChannelsSchema',
    'notificationPreferenceSchema',
    'notificationPreferencesResponseSchema',
    'notificationPreferencesSchema',
    'notificationSchema',
    'notificationSourceActivitySchema',
    'notificationStateResponseSchema',
    'notificationTargetSchema',
    'notificationUnreadCountResponseSchema',
    'notificationUserStateSchema',
    'parseISO8601Timestamp',
    'parseNotification',
    'parseNotificationAction',
    'parseNotificationEvent',
    'parseNotificationListResponse',
    'parseNotificationPreference',
    'parseNotificationPreferenceChannels',
    'parseNotificationPreferences',
    'parseNotificationPreferencesResponse',
    'parseNotificationSourceActivity',
    'parseNotificationStateResponse',
    'parseNotificationTarget',
    'parseNotificationUnreadCountResponse',
    'parseNotificationUserState',
    'parsePushDeliveryAttempt',
    'parsePushDeliveryJob',
    'parsePushSubscription',
    'parsePushSubscriptionInput',
    'parsePushSubscriptionsResponse',
    'pushDeliveryAttemptSchema',
    'pushDeliveryJobSchema',
    'pushSubscriptionsResponseSchema',
    'pushSubscriptionInputSchema',
    'pushSubscriptionSchema',
  ];
  for (const exportName of runtimeExports) {
    assert.ok(exportName in entrypoint, exportName + ' should be publicly exported');
  }
});
