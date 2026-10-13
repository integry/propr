import { test, expect } from '@playwright/test';
import { fixture, screenshot } from './new-task.fixture';

const longRepository = `${'o'.repeat(39)}/${'repository'.repeat(8)}`;
const longAgent = `codex-${'routing-agent-'.repeat(8)}`;
const longModel = `gpt-6.1-sol-${'extended-model-'.repeat(8)}`;
const longPrompt = `Keep the complete request readable. Check routing and attachments. Preserve this token: ${'unbroken'.repeat(60)}. Then verify the result.`;

for (const size of [
  { name: '320', width: 320, height: 568 },
  { name: '375', width: 375, height: 812 },
  { name: '390', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 1100 },
  // A 780×1000 window at 200% browser zoom has a 390×500 CSS viewport.
  // Match both its layout viewport and pixel density, including media queries and dvh.
  { name: '200-percent-short', width: 780, height: 1000, zoom: 2 },
]) {
  test.describe(`long choices ${size.name}`, () => {
    test.use({ deviceScaleFactor: size.zoom || 1 });
    test(`long task choices fit at ${size.name}`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: size.width / (size.zoom || 1), height: size.height / (size.zoom || 1) });
      await fixture(page, true);
      await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
        repositories: [{ name: longRepository, enabled: true }],
        agents: [{ alias: longAgent, enabled: true, supportedModels: [longModel], defaultModel: longModel }],
      } }));
      await page.route('**/api/config/repos', route => route.fulfill({ json: {
        success: true, repos_to_monitor: [{ name: longRepository, enabled: true }],
      } }));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/task-submissions', async route => {
        for (const value of [longPrompt, longRepository, longAgent, longModel]) expect(route.request().postData()).toContain(value);
        await gate;
        return route.fulfill({ json: { id: 'submission', state: 'failed', issueNumber: 42,
          issueUrl: 'https://github.com/fixture/repository/issues/42', taskId: null,
          error: `Queue unavailable: ${'diagnostic'.repeat(60)}` } });
      });
      await page.goto('/tasks/new');
      const dialog = page.getByRole('dialog', { name: 'New task' });
      const prompt = dialog.getByLabel('Prompt', { exact: true });
      const summary = dialog.locator('summary');
      await expect(prompt).toBeFocused();
      await dialog.getByText('Select a repository', { exact: true }).click();
      await page.getByPlaceholder('Filter repositories...').fill(longRepository);
      await page.keyboard.press('Enter');
      await prompt.fill(longPrompt);
      const filename = `${'long-attachment-'.repeat(12)}.txt`;
      await dialog.getByLabel('Attach files', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from('Owned fixture data') });
      await summary.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      await expect(dialog.getByLabel('Agent', { exact: true })).toBeFocused();
      await dialog.getByLabel('Agent', { exact: true }).selectOption(longAgent);
      await page.keyboard.press('Tab');
      await expect(dialog.getByLabel('Model', { exact: true })).toBeFocused();
      await dialog.getByLabel('Model', { exact: true }).selectOption(longModel);
      const assertLayout = async (actions: string[]) => {
        const geometry = await dialog.evaluate(el => {
          const elements = [document.documentElement, el, el.querySelector('form > div:first-child')!, ...el.querySelectorAll('fieldset, textarea, select')];
          return elements.map(element => {
            const rect = element.getBoundingClientRect();
            const parent = (element.parentElement || element).getBoundingClientRect();
            return { tag: element.tagName, width: element.clientWidth, scroll: element.scrollWidth,
              contained: !['TEXTAREA', 'SELECT'].includes(element.tagName) || (rect.left >= parent.left && rect.right <= parent.right) };
          });
        });
        for (const item of geometry) {
          // WebKit rounds native select scroll metrics one pixel above clientWidth.
          // All other scroll metrics and every control's parent containment stay strict.
          const rounding = browserName === 'webkit' && item.tag === 'SELECT' ? 1 : 0;
          expect(item.scroll, `${item.tag} horizontal overflow`).toBeLessThanOrEqual(item.width + rounding);
          expect(item.contained, `${item.tag} fits its parent`).toBe(true);
        }
        for (const name of actions) {
          const action = dialog.getByRole('button', { name, exact: true });
          await expect(action).toBeInViewport({ ratio: 1 });
          const box = (await action.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
        await expect(prompt).toHaveValue(longPrompt);
        await expect(dialog.getByLabel('Agent', { exact: true })).toHaveValue(longAgent);
        await expect(dialog.getByLabel('Model', { exact: true })).toHaveValue(longModel);
      };
      await assertLayout(['Cancel', 'Plan first', 'Run task']);
      await expect(dialog.locator('#task-agent-selection')).toHaveText(longAgent);
      await expect(dialog.locator('#task-model-selection')).toHaveText(longModel);
      await dialog.locator('form > div:first-child').evaluate(el => { el.scrollTop = 0; });
      await screenshot(page, `new-task-long-repository-${size.name}`);
      await dialog.getByLabel('Model', { exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, `new-task-long-choices-${size.name}`);
      await prompt.scrollIntoViewIfNeeded();
      await screenshot(page, `new-task-long-prompt-${size.name}`);
      await summary.click();
      await assertLayout(['Cancel', 'Plan first', 'Run task']);
      await summary.click();
      const run = dialog.getByRole('button', { name: 'Run task', exact: true });
      await run.focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close task creation' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(run).toBeFocused();
      try {
        await page.keyboard.press('Enter');
        await expect(dialog.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
        await assertLayout(['Cancel', 'Submitting…']);
      } finally { release(); }
      await expect(dialog.getByRole('alert')).toContainText('Issue #42 created, but agent failed to queue');
      await assertLayout(['Close', 'Retry agent']);
      await dialog.getByRole('alert').scrollIntoViewIfNeeded();
      await screenshot(page, `new-task-long-error-${size.name}`);
      await page.reload();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await summary.click();
      await assertLayout(['Close', 'Retry agent']);
      await expect(dialog.getByText(filename, { exact: true })).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page).toHaveURL(/\/tasks$/);
    });
  });
}
