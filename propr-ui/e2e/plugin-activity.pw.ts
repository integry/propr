import { expect, test } from '@playwright/test';
import { NOW, DEFAULTS, installFixture, capture, type Delivery, type State } from './plugins.fixture';

/**
 * The plugin detail's Activity list against the plugin API fixture: delivery
 * records with their outcome, attempt, duration, error and log lines, Retry on
 * a failed delivery, Degraded and Paused health with Resume, at desktop and
 * phone widths. With PROPR_CAPTURE_PREVIEWS set it captures the Activity list.
 */

/** Deliveries of the enabled example plugin: one gap, failures exhausting their retries, a timed-out attempt waiting to retry and successes. */
function deliveries(): Delivery[] {
  const at = (minutes: number) => NOW - minutes * 60_000;
  const base = { kind: 'event' as const, repository: 'integry/propr', timedOut: false, logs: [] as Delivery['logs'], nextAttemptAt: null, error: null };
  return [
    { ...base, id: 6, deliveryId: 'evt-4127-onMerged', eventSeq: 4127, eventType: 'pull_request.merged', handler: 'onMerged', status: 'failed', attempt: 5, createdAt: at(212), startedAt: at(2), finishedAt: at(2), durationMs: 412,
      error: 'Chat API answered 503 Service Unavailable', logs: [{ level: 'warn', message: 'chat.example refused the message (503)', at: at(2) }] },
    { ...base, id: 5, deliveryId: 'evt-4126-onTask', eventSeq: 4126, eventType: 'task.completed', handler: 'onTask', status: 'retrying', attempt: 2, nextAttemptAt: NOW + 4 * 60_000, createdAt: at(8), startedAt: at(1), finishedAt: at(0.5), durationMs: 30_000, timedOut: true,
      error: 'The handler did not finish within 30 seconds' },
    { ...base, id: 4, deliveryId: 'evt-4119-onMerged', eventSeq: 4119, eventType: 'pull_request.merged', handler: 'onMerged', status: 'failed', attempt: 5, createdAt: at(260), startedAt: at(20), finishedAt: at(20), durationMs: 388,
      error: 'Chat API answered 503 Service Unavailable' },
    { ...base, id: 3, deliveryId: 'evt-4102-onTask', eventSeq: 4102, eventType: 'task.completed', handler: 'onTask', status: 'succeeded', attempt: 1, createdAt: at(300), startedAt: at(300), finishedAt: at(300), durationMs: 184,
      logs: [{ level: 'info', message: 'posted task 9f3c to #propr-updates', at: at(300) }, { level: 'debug', message: 'thread 1731 reused', at: at(300) }] },
    { ...base, id: 2, deliveryId: 'evt-4098-onMerged', eventSeq: 4098, eventType: 'pull_request.merged', handler: 'onMerged', status: 'succeeded', attempt: 1, createdAt: at(340), startedAt: at(340), finishedAt: at(340), durationMs: 236 },
    { ...base, id: 1, deliveryId: 'gap-3901-3950-integry/propr', kind: 'gap', eventSeq: 3901, eventType: null, handler: null, status: 'skipped', attempt: 0, createdAt: at(400), startedAt: null, finishedAt: at(400), durationMs: null,
      error: 'Events after 3900 up to 3950 may have left the journal (retention) before they were delivered' },
  ];
}

test('shows delivery activity with Retry, Degraded and Paused with Resume', async ({ page }) => {
  const lastError = 'Chat API answered 503 Service Unavailable';
  const state: State = {
    installed: true, enabled: true, token: true, oauth: true, repositories: ['integry/propr'], refuseUninstall: false, settings: { ...DEFAULTS },
    activity: { health: { state: 'degraded', consecutiveFailures: 3, pauseAfterFailures: 10, lastError, lastErrorAt: NOW - 2 * 60_000, degradedAt: NOW - 20 * 60_000, pausedAt: null }, deliveries: deliveries() },
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFixture(page, state);
  await page.goto('/plugins/example-pack');
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(page.getByRole('heading', { level: 1 }).getByTestId('plugin-health')).toHaveText('Degraded');
  await expect(activity.getByTestId('plugin-health-notice')).toContainText('Degraded: 3 deliveries failed in a row');
  await expect(activity.getByTestId('plugin-delivery')).toHaveCount(6);
  await activity.getByTestId('plugin-delivery').nth(3).getByText('Log (2 lines)').click();
  await capture(page, 'plugins-activity-degraded-desktop', activity);

  await activity.getByRole('button', { name: 'Retry pull_request.merged to onMerged' }).first().click();
  await expect(activity.getByRole('status')).toContainText('Retry scheduled');
  await expect(activity.getByTestId('plugin-delivery').first()).toHaveAttribute('data-status', 'pending');

  // Later the failures go on and deliveries pause.
  state.activity!.health = { ...state.activity!.health, state: 'paused', consecutiveFailures: 10, pausedAt: NOW };
  await activity.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { level: 1 }).getByTestId('plugin-health')).toHaveText('Paused');
  const resume = activity.getByRole('button', { name: 'Resume deliveries' });
  await expect(resume).toBeVisible();
  await capture(page, 'plugins-activity-paused-desktop', activity);
  await resume.click();
  await expect(activity.getByRole('status')).toHaveText('Deliveries resumed.');
  await expect(page.getByTestId('plugin-health')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  state.activity!.health = { ...state.activity!.health, state: 'paused', consecutiveFailures: 10, pausedAt: NOW };
  await activity.getByRole('button', { name: 'Refresh' }).click();
  await expect(resume).toBeVisible();
  await expect(activity.getByRole('status')).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await capture(page, 'plugins-activity-paused-phone', activity);
});
