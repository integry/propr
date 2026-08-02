import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const tsc = path.join(workspace, 'node_modules/typescript/bin/tsc');

test('builds and exposes the notification contract from @propr/shared', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'propr-notification-entrypoint-'),
  );
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const packageDirectory = path.join(
    temporaryDirectory,
    'node_modules',
    '@propr',
    'shared',
  );
  const packageDist = path.join(packageDirectory, 'dist');
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(workspace, 'packages/shared/package.json'),
    path.join(packageDirectory, 'package.json'),
  );
  fs.copyFileSync(
    path.join(workspace, 'test/fixtures/notificationPublicEntrypoint.ts'),
    path.join(temporaryDirectory, 'notificationPublicEntrypoint.ts'),
  );

  execFileSync(process.execPath, [
    tsc,
    '--project',
    'packages/shared/tsconfig.json',
    '--outDir',
    packageDist,
  ], {
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
    'notificationPublicEntrypoint.ts',
  ], {
    cwd: temporaryDirectory,
    stdio: 'pipe',
  });

  const entrypoint = await import(
    pathToFileURL(path.join(packageDist, 'index.js')).href
  );
  const runtimeExports = [
    'DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS',
    'DEFAULT_NOTIFICATION_QUIET_HOURS',
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
    'notificationCapabilitiesResponseSchema',
    'notificationEventSchema',
    'notificationListResponseSchema',
    'notificationPreferenceChannelsSchema',
    'notificationPreferenceSchema',
    'notificationPreferencesResponseSchema',
    'notificationPreferencesSchema',
    'notificationPreferencesUpdateSchema',
    'notificationQuietHoursSchema',
    'notificationSchema',
    'notificationSourceActivitySchema',
    'notificationStateResponseSchema',
    'notificationTargetSchema',
    'notificationUnreadCountResponseSchema',
    'notificationUserStateSchema',
    'parseISO8601Timestamp',
    'parseNotification',
    'parseNotificationAction',
    'parseNotificationCapabilitiesResponse',
    'parseNotificationEvent',
    'parseNotificationListResponse',
    'parseNotificationPreference',
    'parseNotificationPreferenceChannels',
    'parseNotificationPreferences',
    'parseNotificationPreferencesResponse',
    'parseNotificationPreferencesUpdate',
    'parseNotificationQuietHours',
    'parseNotificationSourceActivity',
    'parseNotificationStateResponse',
    'parseNotificationTarget',
    'parseNotificationUnreadCountResponse',
    'parseNotificationUserState',
    'parsePushDeliveryAttempt',
    'parsePushDeliveryJob',
    'parsePushSubscription',
    'parsePushSubscriptionEnrollmentResponse',
    'parsePushSubscriptionEndpoint',
    'parsePushSubscriptionInput',
    'parseIanaTimezone',
    'parseQuietHour',
    'parsePushSubscriptionsResponse',
    'pushDeliveryAttemptSchema',
    'pushDeliveryJobSchema',
    'pushSubscriptionEnrollmentResponseSchema',
    'pushSubscriptionsResponseSchema',
    'pushSubscriptionInputSchema',
    'pushSubscriptionSchema',
  ];
  for (const exportName of runtimeExports) {
    assert.ok(exportName in entrypoint, exportName + ' should be publicly exported');
  }
});
