import { expect, test } from '@playwright/test';
import { fixture } from './planner-studio.fixture';

for (const [device, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
  test(`automatic draft preserves the composer and can generate once on ${device}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await fixture(page);
    let creations = 0;
    let generations = 0;
    const draft = {
      draft_id: 'draft-in-place', repository: 'integry/propr', initial_prompt: '', status: 'draft',
      attachments: [], created_at: '2026-10-14T00:00:00Z', plan_json: [], chat_history: [],
      context_config: { baseBranch: 'main' },
    };
    await page.route('**/api/planner/drafts', route => {
      if (route.request().method() !== 'POST') return route.fallback();
      creations++;
      draft.initial_prompt = route.request().postDataJSON().prompt;
      return route.fulfill({ json: draft });
    });
    await page.route('**/api/planner/drafts/draft-in-place', route => {
      if (route.request().method() === 'PUT') Object.assign(draft, route.request().postDataJSON());
      return route.fulfill({ json: draft });
    });
    await page.route('**/api/planner/drafts/draft-in-place/repository-info', route => route.fulfill({ json: { defaultBranch: 'main', branches: ['main'] } }));
    await page.route('**/api/planner/preview', route => route.fulfill({ json: {
      success: true, stats: { totalTokens: 0, costEstimate: 0, contextLength: 0, fileCount: 0 }, smartSelection: [], warnings: [],
    } }));
    await page.route('**/api/planner/generate', route => {
      generations++;
      expect(route.request().postDataJSON().draftId).toBe(draft.draft_id);
      return route.fulfill({ json: { runId: 'generation-1', status: 'generating' } });
    });
    await page.goto('/studio/new');
    const prompt = page.getByPlaceholder('Describe the feature, bug fix, or improvement you want to implement...');
    await prompt.fill('Document local setup');
    await expect(page).toHaveURL(/\/studio\/draft-in-place$/);
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue('Document local setup');
    await prompt.press('End');
    await prompt.pressSequentially(' and troubleshooting');
    await expect(prompt).toHaveValue('Document local setup and troubleshooting');
    const generate = page.getByRole('button', { name: /Generate Plan/ });
    await generate.scrollIntoViewIfNeeded();
    await expect(generate).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await generate.click();
    await expect.poll(() => generations).toBe(1);
    expect(creations).toBe(1);
    await expect(page.getByRole('heading', { name: 'Something went wrong on this page' })).toHaveCount(0);
    expect(draft.initial_prompt).toBe('Document local setup and troubleshooting');
  });
}
