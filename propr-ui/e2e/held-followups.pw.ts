import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hour = 60 * 60 * 1000;
const base = {
  predecessorTaskIds: [], successorTaskId: null, settlement: null, operatorAuthorized: false, liveness: 'not_checked',
  completionCommentUrl: null, retainedWorktreePath: '/tmp/git-processor/worktrees/sample/website/pr-followup',
};
const handoffs = [
  {
    ...base, repository: 'sample/website', pullRequest: 412, taskId: 'pr-comments-batch-sample-website-412', phase: 'committed',
    status: 'awaiting_operator', statusReason: 'cancelled_by_user', branchName: 'checkout-copy', commitHash: '4f1c2a9be03d7e',
    nextAction: 'resume --authorize-cancelled to publish the cancelled work, or release to stop tracking it', updatedAt: Date.now() - 3 * hour,
  },
  {
    ...base, repository: 'sample/docs', pullRequest: 88, taskId: 'pr-comments-batch-sample-docs-88', phase: 'agent_exited',
    status: 'awaiting_operator', statusReason: 'fork_publication_unsupported', branchName: 'contributor/fix-links', commitHash: null,
    nextAction: 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it', updatedAt: Date.now() - 26 * hour,
  },
  ...['auto_released_stale_hold', 'released_by_operator_force', 'released_pr_closed'].map((statusReason, index) => ({
    ...base, repository: 'sample/website', pullRequest: 300 + index, taskId: `pr-comments-batch-sample-website-${300 + index}`, phase: 'agent_exited',
    status: 'released', statusReason, branchName: `topic-${index}`, commitHash: null, nextAction: 'none', updatedAt: Date.now() - (48 + index) * hour,
  })),
];

async function mockApi(page: Page) {
  const calls = { list: 0, resume: [] as unknown[], release: [] as unknown[] };
  let current = handoffs;
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/admin/followup-handoffs') { calls.list += 1; return route.fulfill({ json: { handoffs: current } }); }
    if (pathname.endsWith('/resume')) {
      calls.resume.push({ path: pathname, body: request.postDataJSON() });
      current = current.filter(handoff => handoff.pullRequest !== 412);
      return route.fulfill({ json: { summary: { inspected: 1, published: 1, noChanges: 0, settled: 0, cleanupPending: 0, skippedLiveAgent: 0, failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0 }, status: null } });
    }
    if (pathname.endsWith('/release')) { calls.release.push({ path: pathname, body: request.postDataJSON() }); return route.fulfill({ status: 409, json: { released: false, reason: 'worktree_holds_unpublished_work' } }); }
    const responses: Record<string, unknown> = {
      '/api/auth/demo-mode': { demoMode: false },
      '/api/auth/user': { id: 'preview-admin', username: 'preview-admin', login: 'preview-admin', displayName: 'Instance administrator', email: null, avatarUrl: null, role: 'admin', permissions: ['instance.manage_settings', 'instance.manage_agents', 'instance.manage_runtime'], authorizationSource: 'local' },
      '/api/config/settings': { worker_concurrency: 2, auto_followup_score_threshold: 4, ultrafix_rating_goal: 7, ultrafix_max_cycles: 5, ultrafix_pause_seconds: 60, model_reasoning_level: '', github_user_whitelist: [] },
      '/api/config/followup-keywords': { followup_keywords: [] },
      '/api/config/followup-ignore-keywords': { followup_ignore_keywords: [] },
      '/api/config/pr-label': { pr_label: 'propr' },
      '/api/config/primary-processing-labels': { primary_processing_labels: ['AI'] },
      '/api/config/agents': { agents: [] },
      '/api/config/summarization': { enabled: false, agent_alias: '', fallback_agent_alias: '' },
      '/api/config/agent-tank': { mode: 'disabled', enabled: false },
      '/api/instance/catalog': { agents: [], repositories: [] },
      '/api/notifications/config': { push: { configured: false, vapidPublicKey: null } },
      '/api/notifications/unread-count': { unreadCount: 0 },
    };
    return pathname in responses ? route.fulfill({ json: responses[pathname] }) : route.fulfill({ status: 503, json: { error: 'Unavailable in isolated UI fixture' } });
  });
  return calls;
}

const previews: Array<{ path: string; title: string; description: string }> = [];
test.afterAll(async () => {
  if (!process.env.PROPR_CAPTURE_PREVIEWS || previews.length === 0) return;
  const directory = path.resolve('../.propr/previews');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: [] }, null, 2));
});

test('held follow-ups are read only once Maintenance is open', async ({ page }) => {
  const calls = await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/settings?tab=workflow');
  await expect(page.getByRole('tab', { name: 'Maintenance' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls.list).toBe(0);
  await page.getByRole('tab', { name: 'Maintenance' }).click();
  await expect(page.getByRole('link', { name: 'sample/website#412' })).toBeVisible();
  expect(calls.list).toBe(1);
});

for (const { width, height, name } of [{ width: 1440, height: 1100, name: 'desktop' }, { width: 390, height: 844, name: 'mobile' }]) {
  test(`held follow-ups show what needs a decision at ${width}px`, async ({ page }) => {
    const calls = await mockApi(page);
    await page.setViewportSize({ width, height });
    await page.goto('/settings?tab=maintenance');
    const section = page.getByRole('region', { name: 'Held follow-ups', exact: true });
    const open = section.getByRole('list', { name: 'Held follow-ups' });
    await expect(open.getByRole('listitem')).toHaveCount(2);
    // Held follow-ups come before Instance data in the category.
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('#settings-panel-maintenance [data-settings-section]')).map(element => element.getAttribute('data-settings-section')));
    expect(order).toEqual(['maintenance', 'instance-storage']);
    await expect(section.getByText('Show released (3)')).toBeVisible();
    await expect(section.getByRole('list', { name: 'Released follow-ups' })).toBeHidden();
    await expect(section).not.toContainText('/tmp/git-processor');
    await expect(section).not.toContainText('--authorize-cancelled');
    await expect(section.getByRole('button', { name: 'Refresh' })).toHaveCount(0);

    const fits = await section.evaluate(element => {
      const viewport = window.innerWidth;
      return Array.from(element.querySelectorAll('button, input, label, a, code')).every(node => node.getBoundingClientRect().right <= viewport + 1);
    });
    expect(fits).toBe(true);

    const cancelled = open.getByRole('listitem').filter({ hasText: 'sample/website#412' });
    if (process.env.PROPR_CAPTURE_PREVIEWS) {
      const directory = path.resolve('../.propr/previews');
      await mkdir(directory, { recursive: true });
      await section.getByText('Show released (3)').click();
      await expect(section.getByRole('list', { name: 'Released follow-ups' })).toBeVisible();
      // Tall enough that the nested Settings scroller shows the whole section.
      await page.setViewportSize({ width, height: 1800 });
      await section.screenshot({ path: path.join(directory, `held-followups-${name}.png`) });
      await page.setViewportSize({ width, height });
      previews.push({ path: `.propr/previews/held-followups-${name}.png`, title: `Held follow-ups — ${width}px`, description: `Settings → Maintenance at ${width}px: two held follow-ups with plain reasons and next steps, the cancelled one offering “Publish the cancelled work”, and the released ones expanded read-only.` });
      await cancelled.getByRole('button', { name: 'Release' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.screenshot({ path: path.join(directory, `held-followups-release-${name}.png`) });
      previews.push({ path: `.propr/previews/held-followups-release-${name}.png`, title: `Release confirmation — ${width}px`, description: 'Release asks for confirmation before it unblocks the pull request.' });
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    }

    // Release asks first, then reports the refusal in plain words.
    await cancelled.getByRole('button', { name: 'Release' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click();
    await expect(section.getByRole('alert')).toHaveText('This follow-up still has unpublished work. Tick the box to release it anyway; the commits are kept.');
    expect(calls.release).toEqual([{ path: '/api/admin/followup-handoffs/sample/website/412/release', body: { force: false } }]);

    // Publishing cancelled work is an explicit choice beside Resume.
    await cancelled.getByRole('checkbox', { name: 'Publish the cancelled work' }).check();
    await cancelled.getByRole('button', { name: 'Resume' }).click();
    await expect(section.getByText('Resumed sample/website#412. Its work is published.')).toBeVisible();
    expect(calls.resume).toEqual([{ path: '/api/admin/followup-handoffs/sample/website/412/resume', body: { authorizeCancelled: true, taskId: 'pr-comments-batch-sample-website-412' } }]);
    await expect(open.getByRole('listitem')).toHaveCount(1);
  });
}
