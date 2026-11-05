import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const taskId = 'task-push-salvage-2736';
const at = (minute: number, second = 0) => `2026-10-05T23:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const unblockUrl = 'https://github.com/acme/web/security/secret-scanning/unblock-secret/2Mf8bjCnMb7BJFkLxmEBhP2OkTm';
const rescueRef = `refs/propr/rescue/${taskId}`;

async function fixture(page: Page) {
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: true },
      [`/api/task/${taskId}/history`]: {
        history: [
          { state: 'PENDING', timestamp: at(30), metadata: { model: 'claude-opus-5-5' } },
          { state: 'PROCESSING', timestamp: at(30, 4) },
          { state: 'CLAUDE_EXECUTION', timestamp: at(31), reason: 'Agent execution started' },
          { state: 'POST_PROCESSING', timestamp: at(52) },
          {
            state: 'POST_PROCESSING', timestamp: at(53),
            reason: `Push rejected (push_protection); commits saved to ${rescueRef}`,
            metadata: { pushSalvage: { rung: 'rescue_ref', classification: 'push_protection', summary: `Push rejected (push_protection); commits saved to ${rescueRef}`, rescueRef, unblockUrls: [unblockUrl] } },
          },
          {
            state: 'FAILED', timestamp: at(53, 6),
            reason: 'Task failed: Push of branch 2736/salvage was rejected (push_protection)',
            metadata: {
              pushFailure: {
                diagnosis: {
                  classification: 'push_protection',
                  summary: 'GitHub secret scanning push protection blocked the push because the commits contain a detected secret. Remove the secret from the commits, or allow it through the unblock URL, then push again.',
                  unblockUrls: [unblockUrl],
                },
                rung: 'rescue_ref', branchName: '2736/salvage', repository: 'acme/web', rescueRef,
                recoveryInstruction: `The commits were pushed to \`${rescueRef}\` on acme/web. Recover them with: \`git fetch origin ${rescueRef} && git checkout -B 2736/salvage FETCH_HEAD\`, then push the branch.`,
              },
            },
          },
        ],
        taskInfo: { title: 'Salvage agent work before destroying the worktree', type: 'issue', number: 2736, issueNumber: 2736, repoOwner: 'acme', repoName: 'web', modelName: 'claude-opus-5-5' },
        usageMetricRecords: [],
      },
      [`/api/task/${taskId}/live-details`]: { events: [], todos: [], currentTask: null },
      '/api/notifications/unread-count': { unreadCount: 0 },
      '/api/notifications/preferences': { preferences: {}, quietHours: {}, badgeEnabled: false },
    };
    return route.fulfill(path in responses ? { json: responses[path] } : { status: 503, json: { error: 'Unavailable in push failure fixture' } });
  });
}

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ animations: 'disabled', path: `../.propr/previews/${name}.png` });
}

for (const width of [390, 1440]) {
  test(`task details explains a rejected push and where its commits are at ${width}px`, async ({ page }) => {
    await fixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tasks/${taskId}`);
    const failure = page.getByTestId('push-failure').first();
    await failure.scrollIntoViewIfNeeded();
    await expect(failure).toContainText('Push rejected: Secret scanning push protection');
    await expect(failure.getByRole('link', { name: unblockUrl })).toHaveAttribute('href', unblockUrl);
    await expect(failure.getByTestId('push-failure-recovery')).toContainText(rescueRef);
    await capture(page, `task-push-failure-${width}`);
  });
}
