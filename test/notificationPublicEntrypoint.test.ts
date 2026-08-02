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
    'NOTIFICATION_SOURCE_ACTIVITY_STATUSES',
    'notificationSourceActivitySchema',
    'notificationUserStateSchema',
    'parseNotificationSourceActivity',
    'parseNotificationUserState',
    'parsePushDeliveryAttempt',
    'parsePushDeliveryJob',
    'parsePushSubscription',
    'parsePushSubscriptionInput',
    'parsePushSubscriptionsResponse',
    'pushDeliveryAttemptSchema',
    'pushDeliveryJobSchema',
    'pushSubscriptionInputSchema',
    'pushSubscriptionSchema',
    'pushSubscriptionsResponseSchema',
  ];
  for (const exportName of runtimeExports) {
    assert.ok(exportName in entrypoint, exportName + ' should be publicly exported');
  }
});
