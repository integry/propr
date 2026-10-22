import { expect, test, type Page } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';
import { installWindowActions } from './native-chrome.fixture';

const draftId = 'fresh-plan';
const prompt = 'Add a health endpoint to the API';
const task = { id: 'task-1', title: 'Add a GET /health endpoint with a readiness check', body: '## Context\nOne bounded task.', implementation: '' };

const layouts = [
  { name: 'phone-320', viewport: { width: 320, height: 640 } },
  { name: 'phone-390', viewport: { width: 390, height: 844 } },
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  // The installed app's minimum window, with the native shell's titlebar.
  { name: 'native-minimum', viewport: { width: 880, height: 620 }, native: true },
];

/** Installs the native bridge the packaged renderer sees, with a Linux frame. */
async function installNativeShell(page: Page) {
  await page.addInitScript(() => {
    const profile = { id: 'fresh-plan-profile', name: 'Preview workspace', kind: 'remote' as const, baseUrl: 'https://fixture.example.test' };
    window.__PROPR_DESKTOP__ = {
      isDesktop: true, platform: 'linux',
      app: { onDeepLink: () => () => undefined },
      profiles: { list: async () => [profile], getActiveId: async () => profile.id, setActiveId: async () => undefined, save: async () => undefined, remove: async () => undefined },
      connection: { probe: async () => ({ status: 'ready' }) },
      authentication: { authenticate: async () => undefined },
      discovery: { supported: false, discover: async () => [] },
      localSetup: { supported: false, setup: async () => profile },
      externalBrowser: { open: async () => undefined },
    } as unknown as typeof window.__PROPR_DESKTOP__;
  });
  await installWindowActions(page, { platform: 'linux' });
}

/**
 * A server for one fresh draft. Like the real one, POST /generate claims the run only after preparing the repository,
 * which takes longer than the page's own read of the new draft: that read answers with the pre-generation draft
 * before the acknowledgement arrives. Completion is up to the test.
 */
async function routeFreshDraft(page: Page) {
  const server = { creations: 0, generations: 0, reads: 0, complete: () => {} };
  const draft: Record<string, unknown> = {
    draft_id: draftId, repository: 'integry/propr', initial_prompt: '', status: 'draft', attachments: [], chat_history: [], plan_json: [],
    created_at: '2026-10-22T22:00:00Z', context_config: { baseBranch: 'main' },
  };
  let answerFirstRead!: () => void;
  const firstReadAnswered = new Promise<void>(resolve => { answerFirstRead = resolve; });
  server.complete = () => Object.assign(draft, { status: 'review', plan_json: [task], name: 'Health endpoint', generation_trace: { runId: 'run-1', steps: [] } });
  await page.route('**/api/planner/drafts', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    server.creations++;
    draft.initial_prompt = route.request().postDataJSON().prompt;
    return route.fulfill({ json: draft });
  });
  await page.route(`**/api/planner/drafts/${draftId}`, async route => {
    if (route.request().method() === 'PUT') {
      Object.assign(draft, route.request().postDataJSON());
      return route.fulfill({ json: draft });
    }
    await route.fulfill({ json: draft });
    if (++server.reads === 1) answerFirstRead();
  });
  await page.route(`**/api/planner/drafts/${draftId}/repository-info`, route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/github/repos/integry/propr/branches', route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/planner/preview', route => route.fulfill({ json: {
    success: true, stats: { totalTokens: 0, costEstimate: 0, contextLength: 0, fileCount: 0 }, smartSelection: [], warnings: [],
  } }));
  await page.route('**/api/planner/generate', async route => {
    server.generations++;
    expect(route.request().postDataJSON().draftId).toBe(draftId);
    await Promise.race([firstReadAnswered, new Promise(resolve => setTimeout(resolve, 5_000))]);
    Object.assign(draft, { status: 'generating', generation_trace: { runId: 'run-1', steps: [{ name: 'relevance', status: 'in_progress' }] } });
    await route.fulfill({ json: { success: true, runId: 'run-1', status: 'generating', message: 'started' } });
  });
  return server;
}

for (const layout of layouts) {
  test(`a fresh plan generated before autosave shows Generating, then its Review (${layout.name})`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    if (layout.native) await installNativeShell(page);
    await fixture(page);
    const server = await routeFreshDraft(page);
    await page.goto('/plans');
    await page.evaluate(() => { window.history.pushState(null, '', '/studio/new'); window.dispatchEvent(new PopStateEvent('popstate')); });

    const composer = page.getByPlaceholder(/Describe the feature/);
    await expect(page.getByTestId('branch-chip')).toHaveAttribute('data-status', 'resolved');
    await composer.fill(prompt);
    const generate = page.getByRole('button', { name: /Generate Plan/ });
    await expect(generate).toBeEnabled();
    // Inside the autosave debounce: Generate creates the draft itself.
    await generate.click();

    await expect(page.getByText('Generating', { exact: true })).toBeVisible();
    expect(server.reads).toBeGreaterThan(0);
    await expect(page).toHaveURL(new RegExp(`/studio/${draftId}$`));
    await expect(composer).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `fresh-plan-generating-${layout.name}`);

    server.complete();
    // With the socket unavailable, the generating view's HTTP fallback picks up completion.
    await expect(page.getByText(task.title).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Generate Plan/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await capture(page, `fresh-plan-review-${layout.name}`);
    expect(server.creations).toBe(1);
    expect(server.generations).toBe(1);

    // /studio/new was replaced: back returns to the plans list and forward reopens the finished plan.
    await page.goBack();
    await expect(page).toHaveURL(/\/plans$/);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/studio/${draftId}$`));
    await expect(page.getByText(task.title).first()).toBeVisible();
    expect(server.generations).toBe(1);
  });
}
