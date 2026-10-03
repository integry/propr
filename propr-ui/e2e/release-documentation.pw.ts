import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from './dashboard-sections.fixture';

// Documentation evidence uses the production routes and components. All API
// data is local and deterministic; no GitHub or coding-agent mutation is sent.
async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  await mkdir('../.propr/previews', { recursive: true });
  await page.screenshot({ path: `../.propr/previews/${name}.png` });
}

test('captures the work navigation and a real dashboard image in task previews', async ({ page }) => {
  await fixture(page, { width: 1440, height: 1080 });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.goto('/');
  await expect(page.getByTestId('happening-now-list')).toBeVisible();
  await expect(page.locator('.recharts-surface').first()).toBeVisible();
  await capture(page, 'release-dashboard');
  const dashboard = await page.screenshot({ animations: 'disabled' });
  const timestamp = '2026-09-23T12:00:00Z';
  await page.route('**/api/task/docs-preview/**', route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    const responses: Record<string, unknown> = {
      history: {
        history: [
          { state: 'PENDING', timestamp },
          { state: 'COMPLETED', timestamp, metadata: { pr: { url: 'https://github.com/example/workspace/pull/42', number: 42 } } },
        ],
        taskInfo: { title: 'Refresh the operations dashboard', type: 'issue', number: 41, issueNumber: 41, repoOwner: 'example', repoName: 'workspace', modelName: 'gpt-6-astra' },
        previewMedia: [{ type: 'image', title: 'Dashboard and work navigation', description: 'Current UI with deterministic example work.', url: '/api/preview-media/pulls/example/workspace/42/dashboard' }],
        usageMetricRecords: [],
      },
      'live-details': { events: [], todos: [], currentTask: null },
      'file-changes': { taskId: 'docs-preview', lastUpdated: timestamp, files: [{ path: 'src/Dashboard.tsx', status: 'modified', linesAdded: 18, linesRemoved: 7, diff: '' }] },
      analysis: { analysis: { analysis: JSON.stringify({ summary_of_changes: 'Updated navigation and dashboard activity. Layout checks pass.' }) } },
    };
    return route.fulfill({ json: responses[endpoint!] ?? {} });
  });
  await page.route('**/api/preview-media/pulls/example/workspace/42/dashboard', route => route.fulfill({ contentType: 'image/png', body: dashboard }));
  await page.goto('/tasks/docs-preview');
  await expect(page.getByAltText('Dashboard and work navigation')).toBeVisible();
  const changedFile = page.getByRole('button', { name: 'View diff for src/Dashboard.tsx', exact: true });
  await expect(changedFile).toBeVisible();
  await expect(changedFile).toContainText('Dashboard.tsx');
  await expect(changedFile).toContainText('+18');
  await expect(changedFile).toContainText('-7');
  await capture(page, 'release-previews');
});

test('captures plan refinement and persistent revision history', async ({ page }) => {
  await fixture(page, { width: 1440, height: 1000 });
  await page.routeWebSocket('**/socket.io/**', socket => socket.close());
  await page.route('**/api/auth/demo-mode', route => route.fulfill({ json: { demoMode: false } }));
  const plan = [
    { id: 'task-1', title: 'Respect the account locale in invoices', body: 'Use the account locale on invoice pages and PDF exports. Keep stored dates unchanged.', implementation: 'Share a date-formatting helper between both renderers and cover locale-specific output.' },
    { id: 'task-2', title: 'Document invoice date preferences', body: 'Explain where administrators select the account locale.', implementation: 'Update the billing guide and add a screenshot of the locale setting.' },
  ];
  const revision = { revision_id: 1, draft_revision: 1, status_before: 'refining', status_after: 'review', replaced_at: '2026-09-23T11:30:00Z', issue_count: 2, titles: plan.map(task => task.title), plan };
  await page.route('**/api/planner/drafts/docs-plan**', route => {
    const path = new URL(route.request().url()).pathname;
    const response = path.endsWith('/revisions/1') ? revision
      : path.endsWith('/revisions') ? { revisions: [revision] }
      : { draft_id: 'docs-plan', name: 'Consistent invoice dates', repository: 'example/workspace', initial_prompt: 'Use account locale preferences consistently for invoice dates.', status: 'review', attachments: [], created_at: '2026-09-23T10:00:00Z', plan_json: plan, context_config: { useEpic: false, autoMerge: false }, chat_history: [{ role: 'user', content: 'Keep stored dates unchanged; only change display formatting.' }, { role: 'assistant', content: 'The complete plan keeps storage unchanged and covers both invoice renderers.' }] };
    return route.fulfill({ json: response });
  });
  await page.goto('/studio/docs-plan');
  await expect(page.getByTitle('Plan history')).toBeVisible();
  await expect(page.getByText(plan[0].title, { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.getByText(plan[0].title, { exact: true }).first().evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  })).toBe(true);
  await capture(page, 'release-plan');
  await page.getByTitle('Plan history').click();
  const history = page.getByRole('dialog', { name: 'Plan history' });
  await history.getByRole('button', { name: /Before refinement/ }).click();
  await expect(history.getByText(plan[0].title, { exact: false })).toBeVisible();
  await expect(history).toHaveCSS('opacity', '1');
  await expect(history.locator('..')).toHaveCSS('opacity', '1');
  await capture(page, 'release-plan-history');
});
