import { test, expect, type Page } from '@playwright/test';
import { fixture, screenshot, taskId, title } from './new-task.fixture';

const ISSUE_URL = 'https://github.com/acme/billing/issues/42';
const INTAKE_ERROR = 'Implementation did not start after 3 attempts: Worktree disk pressure: admission reserve unavailable; data retained. Once the cause is fixed, Retry agent starts this same issue again without creating another.';

/**
 * The submission API after an accepted submission's intake job exhausted its
 * attempts before any task: the first poll still reads queued, the next one
 * reports the recorded failure, and only an explicit retry of the same
 * submission starts it again, after which a task is associated.
 */
async function intakeFailure(page: Page) {
  const calls: string[] = [];
  const keys: string[] = [];
  let polls = 0;
  let retried = false;
  await page.route('**/api/task-submissions**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${pathname}`);
    const submission = (state: string, error: string | null = null, task: string | null = null) =>
      route.fulfill({ json: { id: 'submission', state, issueNumber: 42, issueUrl: ISSUE_URL, taskId: task, error } });
    if (request.method() === 'POST' && pathname === '/api/task-submissions') { keys.push(request.headers()['idempotency-key']); return submission('queued'); }
    if (request.method() === 'POST' && pathname.endsWith('/retry')) { retried = true; return submission('queued'); }
    if (retried) return submission('queued', null, taskId);
    return ++polls < 2 ? submission('queued') : submission('failed', INTAKE_ERROR);
  });
  return { calls, keys };
}

const viewports = { desktop: { width: 1440, height: 960 }, 'mobile-390': { width: 390, height: 844 }, 'mobile-320': { width: 320, height: 640 } };

for (const [device, viewport] of Object.entries(viewports)) {
  test(`an intake that never started shows its failure and retries the existing issue on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    const { calls, keys } = await intakeFailure(page);
    await page.goto('/tasks/new');
    await page.getByText('Select a repository', { exact: true }).click();
    await page.getByRole('button', { name: /acme.*billing/ }).click();
    await page.getByLabel('Prompt', { exact: true }).fill(title);
    await page.getByRole('button', { name: 'Run task', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Queued — waiting for task details');

    // The poll reports the recorded failure: an actionable notice replaces the endless queued state.
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Issue #42 created, but agent failed to queue');
    await expect(alert).toContainText('Worktree disk pressure: admission reserve unavailable; data retained');
    await expect(alert).toContainText('Retry agent starts this same issue again without creating another');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'View issue #42' })).toHaveAttribute('href', ISSUE_URL);
    await expect(page.getByRole('button', { name: 'Start over' })).toHaveCount(0);
    // The request stays as submitted for the retry.
    await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(title);
    await expect(page.getByLabel('Prompt', { exact: true })).toBeDisabled();
    // The notice and its retry are visible together; the action footer stays on screen.
    await alert.scrollIntoViewIfNeeded();
    await expect(alert).toBeInViewport();
    const retry = page.getByRole('button', { name: 'Retry agent', exact: true });
    await expect(retry).toBeInViewport();
    // Nothing overflows the narrowest phone width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await screenshot(page, `new-task-intake-failure-${device}`);

    await retry.click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`));
    // One issue POST, then one retry of that same submission: no new issue, no new identity.
    expect(keys).toHaveLength(1);
    expect(calls.filter(call => call.startsWith('POST'))).toEqual(['POST /api/task-submissions', `POST /api/task-submissions/${keys[0]}/retry`]);
  });
}
