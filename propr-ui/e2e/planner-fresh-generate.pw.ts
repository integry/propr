import { expect, test, type Page } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';
import { installWindowActions } from './native-chrome.fixture';

const draftId = 'fresh-plan';
const prompt = 'Add a health endpoint to the API';
const serverName = 'Fresh draft named by the server';
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
 *
 * Reads carry a server-assigned name the create response lacks, so the document title shows when the page has applied
 * a read; the acknowledgement is held until then rather than for a fixed time.
 */
async function routeFreshDraft(page: Page, options: { holdAcknowledgement?: Promise<void> } = {}) {
  const server = { creations: 0, generations: 0, reads: 0, readAppliedBeforeAck: false, complete: () => {} };
  const draft: Record<string, unknown> = {
    draft_id: draftId, repository: 'integry/propr', initial_prompt: '', status: 'draft', attachments: [], chat_history: [], plan_json: [],
    created_at: '2026-10-22T22:00:00Z', context_config: { baseBranch: 'main' },
  };
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
    server.reads++;
    await route.fulfill({ json: { ...draft, name: draft.name ?? serverName } });
  });
  await page.route(`**/api/planner/drafts/${draftId}/repository-info`, route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/github/repos/integry/propr/branches', route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
  await page.route('**/api/planner/preview', route => route.fulfill({ json: {
    success: true, stats: { totalTokens: 0, costEstimate: 0, contextLength: 0, fileCount: 0 }, smartSelection: [], warnings: [],
  } }));
  await page.route('**/api/planner/generate', async route => {
    server.generations++;
    expect(route.request().postDataJSON().draftId).toBe(draftId);
    if (options.holdAcknowledgement) await options.holdAcknowledgement;
    // Barrier: the page has rendered the pre-generation read. On timeout the acknowledgement still goes out and the test's assertion fails.
    else server.readAppliedBeforeAck = await page.waitForFunction(name => document.title.includes(name), serverName, { timeout: 10_000 })
      .then(() => true, () => false);
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
    expect(server.generations).toBe(1);
    expect(server.readAppliedBeforeAck).toBe(true);
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

for (const layout of layouts) {
  test(`leaving a fresh plan before its generation is acknowledged keeps the user where they went (${layout.name})`, async ({ page }) => {
    await page.setViewportSize(layout.viewport);
    if (layout.native) await installNativeShell(page);
    await fixture(page);
    let acknowledge!: () => void;
    const server = await routeFreshDraft(page, { holdAcknowledgement: new Promise<void>(resolve => { acknowledge = resolve; }) });
    await page.goto('/plans');
    await page.evaluate(() => { window.history.pushState(null, '', '/studio/new'); window.dispatchEvent(new PopStateEvent('popstate')); });

    await expect(page.getByTestId('branch-chip')).toHaveAttribute('data-status', 'resolved');
    await page.getByPlaceholder(/Describe the feature/).fill(prompt);
    const generate = page.getByRole('button', { name: /Generate Plan/ });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect.poll(() => server.generations).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/studio/${draftId}$`));

    await page.goBack();
    await expect(page).toHaveURL(/\/plans$/);
    const acknowledged = page.waitForResponse('**/api/planner/generate');
    acknowledge();
    await acknowledged;
    // Give a late navigation every chance to run before asserting it did not.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
    await expect(page).toHaveURL(/\/plans$/);
    await expect(page.getByPlaceholder(/Describe the feature/)).toHaveCount(0);

    // The run was not cancelled: reopening the draft shows its progress and then its Review, without generating again.
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/studio/${draftId}$`));
    await expect(page.getByText('Generating', { exact: true })).toBeVisible();
    server.complete();
    await expect(page.getByText(task.title).first()).toBeVisible({ timeout: 15_000 });
    expect(server.creations).toBe(1);
    expect(server.generations).toBe(1);
  });
}
