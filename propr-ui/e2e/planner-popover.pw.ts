import { expect, test } from '@playwright/test';
import { capture, fixture } from './planner-studio.fixture';

test.beforeEach(async ({ page }) => { await fixture(page); });

for (const width of [390, 880, 1390]) {
  test(`pending issue override stays reachable at ${width}px through resize and selection changes`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    // A single pending row matches the native acceptance reproduction.
    let issue = {
      id: 3, draft_id: 'plan-mcp-exec', repository: 'integry/propr', issue_number: 2799,
      status: 'pending', agent_alias: 'claude', model_name: 'claude-opus-5-5',
      pr_number: null, task_id: null, followup_count: 0,
    };
    await page.route('**/api/planner/drafts/plan-mcp-exec/issues', route => route.fulfill({ json: [issue] }));
    await page.route('**/api/planner/drafts/plan-mcp-exec/issues/2799', route => {
      issue = { ...issue, ...route.request().postDataJSON() };
      return route.fulfill({ json: issue });
    });
    await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
      agents: [
        { alias: 'claude', enabled: true, supportedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'], defaultModel: 'claude-opus-5-5' },
        { alias: 'codex', enabled: true, supportedModels: ['gpt-6-astra', 'gpt-6-sol'], defaultModel: 'gpt-6-astra' },
      ],
      repositories: [{ name: 'integry/propr', enabled: true, baseBranch: 'main' }], defaultAgentAlias: 'claude',
    } }));
    await page.goto('/studio/plan-mcp-exec');
    const chip = page.getByTestId('agent-override-chip');
    await expect(chip).toHaveCount(1);
    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Agent override for #2799' });
    const assertReachable = async () => {
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return rect.left >= 7.5 && rect.right <= innerWidth - 7.5 && rect.top >= 0 && rect.bottom <= innerHeight;
      })).toBe(true);
      // Hit test the heading and controls: visibility alone misses clipping or overlays.
      for (const control of await dialog.locator('select, button, span').filter({ visible: true }).all()) {
        await control.scrollIntoViewIfNeeded();
        expect(await control.evaluate(el => {
          const rect = el.getBoundingClientRect();
          return [0.1, 0.5, 0.9].every(fraction => {
            const hit = document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2);
            return hit === el || el.contains(hit);
          });
        })).toBe(true);
      }
    };
    await assertReachable();
    await capture(page, `planner-override-${width}`);
    await dialog.getByTitle('Select AI agent', { exact: true }).selectOption('codex');
    await dialog.getByTitle('Select model', { exact: true }).selectOption('gpt-6-sol');
    await expect(chip).toHaveText('GPT-6 Sol');
    await assertReachable();
    await dialog.getByTitle('Select AI agent', { exact: true }).selectOption('__multi__');
    await assertReachable();
    await dialog.getByTitle('Select multiple agent/model combinations').click();
    await assertReachable();
    await dialog.getByText('codex / GPT-6 Sol', { exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: 'codex / GPT-6 Sol' })).toBeChecked();
    await assertReachable();
    await capture(page, `planner-override-multi-${width}`);
    await dialog.getByRole('button', { name: 'Back to single agent' }).click();
    await expect(dialog.getByTitle('Select AI agent', { exact: true })).toHaveValue('codex');
    await expect(dialog.getByTitle('Select model', { exact: true })).toHaveValue('gpt-6-sol');
    await assertReachable();
    // Resize the same open dialog, including across the mobile breakpoint.
    await page.setViewportSize({ width: width === 390 ? 880 : 390, height: 620 });
    await assertReachable();
    await expect(dialog.getByTitle('Select model', { exact: true })).toHaveValue('gpt-6-sol');
    await page.setViewportSize({ width, height: 620 });
    await assertReachable();
    for (const edge of ['left', 'right']) {
      await chip.locator('..').evaluate((el, edge) => {
        Object.assign((el as HTMLElement).style, { position: 'fixed', top: '200px', left: '', right: '', [edge]: '8px' });
        window.dispatchEvent(new Event('resize'));
      }, edge);
      await assertReachable();
      await capture(page, `planner-override-${edge}-${width}`);
    }
    await chip.locator('..').evaluate(el => {
      el.removeAttribute('style');
      window.dispatchEvent(new Event('resize'));
    });
    await assertReachable();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(chip).toBeFocused();
    await chip.click();
    await expect(dialog.getByTitle('Select model', { exact: true })).toHaveValue('gpt-6-sol');
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
  });
}

test('open override follows its row when the execution matrix scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1390, height: 620 });
  await page.goto('/studio/plan-agents-exec');
  const chip = page.getByTestId('agent-override-chip').nth(3);
  await chip.click();
  const dialog = page.getByRole('dialog', { name: /Agent override for #/ });
  const before = (await dialog.boundingBox())!;
  const distance = await chip.evaluate(el => {
    let parent = el.parentElement;
    while (parent) {
      if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) {
        const previous = parent.scrollTop;
        parent.scrollTop += 24;
        return parent.scrollTop - previous;
      }
      parent = parent.parentElement;
    }
    return 0;
  });
  expect(distance).toBeGreaterThan(0);
  await expect.poll(async () => Math.round((await dialog.boundingBox())!.y)).toBe(Math.round(before.y - distance));
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await page.keyboard.press('Escape');
  await expect(chip).toBeFocused();
});
