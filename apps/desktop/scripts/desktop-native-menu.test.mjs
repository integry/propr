import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
it('Linux/macOS menu dispatch reaches actual search, sidebar, task creation, connection editor and diagnostics', async context => {
  const executablePath = [chromium.executablePath(), '/usr/bin/chromium'].find(existsSync);
  if (!executablePath) { context.skip('Install Playwright Chromium to exercise actual renderer commands'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'propr-native-menu-'));
  let browser, server;
  const previews = [];
  try {
    await build({
      entryPoints: [join(desktop, 'scripts/fixtures/desktop-native-menu/renderer.tsx')],
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
      define: { 'process.platform': 'window.__FIXTURE_PLATFORM__', 'import.meta.env': '{}', __APP_VERSION__: '"0.8.15"', __PROPR_DESKTOP__: 'true' },
    });
    await mkdir(join(directory, 'media'));
    await copyFile(join(root, 'propr-ui/public/media/logo-and-name-transparent.png'), join(directory, 'media/logo-and-name-transparent.png'));
    const compiled = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    await writeFile(join(directory, 'base.css'), compiled.css);
    await writeFile(join(directory, 'renderer.html'), '<!doctype html><html><head><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    server = createServer(async (request, response) => {
      const asset = new URL(request.url, 'http://fixture').pathname.slice(1);
      if (!['renderer.html', 'renderer.js', 'renderer.css', 'base.css', 'media/logo-and-name-transparent.png'].includes(asset)) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.png') ? 'image/png' : 'text/html');
      response.end(await readFile(join(directory, asset)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
    for (const platform of ['darwin', 'linux']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript(platform => { window.__FIXTURE_PLATFORM__ = platform; Object.defineProperty(navigator, 'platform', { value: platform === 'darwin' ? 'MacIntel' : 'Linux x86_64' }); }, platform);
      await page.route('http://127.0.0.1:3000/**', route => route.fulfill({ status: 503, json: { error: 'Isolated renderer fixture' } }));
      page.on('pageerror', error => context.diagnostic(error.stack));
      await page.goto(`http://127.0.0.1:${server.address().port}/renderer.html`);
      const click = label => page.evaluate(({ label, platform }) => window.nativeMenu.click(label, platform), { label, platform });
      const capture = async (name, locator, title) => {
        if (!process.env.PROPR_DESKTOP_MENU_PREVIEWS) return;
        const output = resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS);
        await mkdir(output, { recursive: true });
        const filename = `${platform}-${name}.png`;
        await locator.screenshot({ path: join(output, filename) });
        previews.push({ path: `.propr/previews/${filename}`, title, description: 'Production renderer reached through the application menu template, dispatcher and preload bridge. Isolated fixture account; Chromium does not render native OS menus.' });
      };
      await expect(page.getByRole('heading', { name: 'Choose an instance' })).toBeVisible();
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'This computer Local instance' }).click();
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await expect(page.locator('.desktop-sidebar footer')).toHaveCount(0);
      await expect(page.locator('.desktop-sidebar')).not.toContainText('v0.8.15');
      const iconRails = await page.locator('.desktop-sidebar').evaluate(sidebar => {
        const selectors = ['.desktop-instance-icon svg', 'a[href="#/"] svg', 'a[href="#/inbox"] svg'];
        return selectors.map(selector => {
          const box = sidebar.querySelector(selector).getBoundingClientRect();
          return box.x + box.width / 2;
        });
      });
      expect(new Set(iconRails).size).toBe(1);
      await capture('sidebar', page.locator('.desktop-sidebar'), 'Desktop sidebar without version metadata');
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toHaveCount(0);
      await capture('sidebar-hidden', page.locator('.desktop-shell'), 'View → Toggle Sidebar: content expands');
      await click('Toggle Sidebar');
      await expect(page.locator('.desktop-sidebar')).toBeVisible();
      await click('Switch Account / Instance…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
      await click('Search / Go To…');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Search', exact: true })).toBeFocused();
      await click('Connect Instance…');
      await expect(page.getByRole('heading', { name: 'Connect to an instance' })).toBeVisible();
      await capture('connect', page.getByRole('dialog', { name: 'Manage instances' }), 'File → Connect Instance opens the connection editor');
      await page.getByRole('button', { name: 'Close instance manager' }).click();
      await click('Connection Diagnostics…');
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Connection Diagnostics' })).toContainText('connected');
      await capture('diagnostics', page.getByRole('dialog', { name: 'Connection Diagnostics' }), 'Help → Connection Diagnostics');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await click('New Task…');
      await expect(page.getByRole('heading', { name: 'New task', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Run task', exact: true })).toBeVisible();
      await capture('new-task', page.getByRole('form', { name: 'New task' }), 'File → New Task opens the direct task launcher');
      await page.close();
    }
    if (process.env.PROPR_DESKTOP_MENU_PREVIEWS) await writeFile(resolve(root, process.env.PROPR_DESKTOP_MENU_PREVIEWS, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: [{ name: 'macOS Electron runner', reason: 'Verify native menu appearance, accelerator handling and About copy action using the next signed Mac build; retain the existing test login.' }] }, null, 2));
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
