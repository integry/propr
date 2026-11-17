import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { installSettingsFixture } from './settings-layout.fixture';

/**
 * The Add server and Add skill forms of Skills & MCP servers: inline
 * validation, the commit confirmation, the repository filter, Escape and the
 * discard prompt, the standard Settings field size and the phone footer.
 */

const instanceId = 'c63a25da-fd5e-4a46-8fe1-566136e12289';
const library = { version: 1, instanceId, revision: 0, servers: [], skills: [], secrets: {}, skillBundles: [], createdAt: 0, updatedAt: 0, auditActor: '' };
const repositories = Array.from({ length: 26 }, (_, i) => ({ name: `example/service-${String(i + 1).padStart(2, '0')}`, enabled: true }));
const commit = '3f786850e387550fdab836ed7e6dc881de23001b';
const previews = process.env.PROPR_CAPTURE_PREVIEWS ? path.resolve('../.propr/previews') : null;

async function open(page: Page, width: number) {
  await installSettingsFixture(page);
  await page.route('**/api/instance/catalog', route => route.fulfill({ json: {
    agents: [{ alias: 'claude-main', kind: 'direct', type: 'claude', enabled: true, supportedModels: [] }], repositories,
  } }));
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/instance/extensions/v1**', route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/skills/github-source')) {
        if (!body.ref) return route.fulfill({ json: { refs: [{ name: 'main', ref: 'refs/heads/main', kind: 'branch' }] } });
        return body.ref === commit || body.ref === 'refs/heads/main' ? route.fulfill({ json: { commit } }) : route.fulfill({ status: 404, json: { error: 'Git source commit unavailable' } });
      }
      return route.fulfill({ status: 500, json: {} });
    }
    return route.fulfill({ json: { instanceId, library, bundles: [], catalog: [] } });
  });
  await page.setViewportSize({ width, height: width > 600 ? 1000 : 844 });
  await page.goto('/settings?tab=agent-extensions');
  const section = page.getByRole('region', { name: 'Skills & MCP servers', exact: true });
  await expect(section.getByTestId('extension-library-status')).toHaveText('Changes apply to new runs.');
  return { section, requests };
}

/** Screenshots `target`; on desktop the viewport grows first so the Settings pane does not clip a tall form. */
async function capture(page: Page, testInfo: TestInfo, name: string, target = page.locator('body')) {
  const viewport = page.viewportSize()!;
  const tall = viewport.width > 600 && name.includes('form');
  if (tall) await page.setViewportSize({ width: viewport.width, height: 2400 });
  const file = testInfo.outputPath(`${name}.png`);
  await target.screenshot({ path: file, animations: 'disabled' });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  if (previews) { await mkdir(previews, { recursive: true }); await target.screenshot({ path: path.join(previews, `${name}.png`), animations: 'disabled' }); }
  if (tall) await page.setViewportSize(viewport);
}

for (const width of [1440, 390]) {
  test(`Add server validates each field and stays usable at ${width}px`, async ({ page }, testInfo) => {
    const { section, requests } = await open(page, width);
    await section.getByRole('button', { name: 'Add server' }).click();
    const form = section.getByTestId('extension-server-form');
    const name = form.getByLabel(/^Server name/);
    const url = form.getByLabel('HTTPS endpoint', { exact: true });
    const add = form.getByRole('button', { name: 'Add server' });
    const discover = form.getByRole('button', { name: 'Discover tools' });
    await expect(add).toBeDisabled();
    await expect(discover).toBeDisabled();

    // Each problem appears once the field is left; nothing is sent.
    await name.fill(`docs search ${'x'.repeat(2000)}`);
    await url.click();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByText('Use at most 48 characters.')).toBeVisible();
    await name.fill('Docs search');
    await expect(form.getByText('Start with a lowercase letter.')).toBeVisible();
    await url.fill('http://tools.example.com/mcp');
    await name.click();
    await expect(form.getByText('Use an https:// address.')).toBeVisible();
    await expect(discover).toBeDisabled();
    await expect(add).toBeDisabled();
    await capture(page, testInfo, `extension-server-form-invalid-${width}`, form);

    await name.fill('docs');
    await url.fill('https://tools.example.com/mcp');
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(discover).toBeEnabled();
    await expect(add).toBeEnabled();
    expect(requests).toEqual([]);

    // The standard Settings control: the same height as the other Settings fields.
    const box = await url.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(36);

    // The long repository list has a filter and shows whole rows.
    const limit = form.getByRole('group', { name: 'Limit to repositories' });
    const list = limit.getByTestId('extension-item-picker-list');
    const listBox = await list.evaluate(element => ({ inner: element.clientHeight, row: element.querySelector('label')!.getBoundingClientRect().height }));
    expect(listBox.inner % listBox.row).toBe(0);
    await limit.getByLabel('Filter limit to repositories').fill('service-2');
    await expect(limit.getByRole('checkbox')).toHaveCount(7);

    if (width < 600) {
      // The actions stay on screen while the long form scrolls.
      await name.scrollIntoViewIfNeeded();
      const actions = form.getByTestId('extension-form-actions');
      const footer = await actions.boundingBox();
      const viewport = page.viewportSize()!;
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(viewport.height + 1);
      expect(footer!.y).toBeGreaterThan(viewport.height / 2);
      // The category title wraps instead of being cut off.
      const title = page.locator('[data-settings-mobile-title]');
      await expect(title).toHaveText('Agent Extensions & Packages');
      expect(await title.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await capture(page, testInfo, `extension-server-form-${width}`, width < 600 ? page.locator('body') : form);

    // Escape asks before discarding typed content.
    await url.press('Escape');
    const dialog = page.getByRole('dialog', { name: 'Discard changes?' });
    await expect(dialog).toBeVisible();
    await capture(page, testInfo, `extension-discard-dialog-${width}`);
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(url).toHaveValue('https://tools.example.com/mcp');
    await url.press('Escape');
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(form).toHaveCount(0);

    // An untouched form closes on Escape without asking.
    await section.getByRole('button', { name: 'Add server' }).click();
    await section.getByTestId('extension-server-form').getByLabel(/^Server name/).press('Escape');
    await expect(section.getByTestId('extension-server-form')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
  });

  test(`Add skill confirms only a verified commit at ${width}px`, async ({ page }, testInfo) => {
    const { section, requests } = await open(page, width);
    await section.getByRole('button', { name: 'Add skill' }).click();
    const form = section.getByTestId('extension-skill-form');
    await form.getByText('Import from an authorized GitHub repository', { exact: true }).click();
    const github = form.locator('details', { has: page.getByText('Import from an authorized GitHub repository', { exact: true }) }).first();
    const select = github.getByLabel('Repository', { exact: true });

    // A typed repository is shown as the selection only once it is a valid owner/name.
    await github.getByText('Other repository (owner/name)', { exact: true }).click();
    const other = github.getByLabel('Other repository (owner/name)');
    await other.fill('team');
    await expect(select).toHaveValue('');
    await expect(github.getByText('Use owner/name, for example acme/website.')).toBeVisible();
    await other.fill('example/service-01');
    await expect(select).toHaveValue('example/service-01');

    // Free text is never called confirmed.
    await github.getByText('Use an exact commit', { exact: true }).click();
    const exact = github.getByLabel('Exact 40-character commit');
    await exact.fill('not-a-commit');
    await expect(github.getByTestId('extension-skill-commit')).toHaveText('Enter the full 40-character commit (0–9, a–f).');
    await expect(form.getByText(/Confirmed/)).toHaveCount(0);
    await exact.fill('a'.repeat(40));
    await expect(github.getByTestId('extension-skill-commit')).toHaveText('This commit was not found in the repository.');
    await expect(form.getByText(/Confirmed/)).toHaveCount(0);
    await capture(page, testInfo, `extension-skill-commit-unverified-${width}`, form);

    // A commit the lookup verified is confirmed.
    await exact.fill(commit);
    await expect(github.getByTestId('extension-skill-commit')).toHaveText(`Confirmed import commit: ${commit}`);
    expect(requests.some(request => request.body.ref === commit)).toBe(true);
    await github.getByLabel('Relative skill directory').fill('skills/review');
    await expect(github.getByRole('button', { name: 'Import pinned skill' })).toBeEnabled();
    await capture(page, testInfo, `extension-skill-form-${width}`, width < 600 ? page.locator('body') : form);

    // Escape, and leaving through a category tab or the phone back button, ask first.
    const dialog = page.getByRole('dialog', { name: 'Discard changes?' });
    await exact.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(form).toBeVisible();
    const leave = width < 600 ? page.getByRole('button', { name: 'Back to Settings' }) : page.getByRole('tab', { name: /Notifications/ });
    await leave.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(form).toBeVisible();
    await leave.click();
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(form).toHaveCount(0);
    // The click is replayed: the desktop opens the other category, the phone returns to the category list.
    if (width < 600) await expect(page.getByRole('button', { name: 'Back to Settings' })).toHaveCount(0);
    else await expect(page).not.toHaveURL(/tab=agent-extensions/);
  });
}
