import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import axe from 'axe-core';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Uses the shipped component and CSS with synthetic public identities only.
// Install: npx playwright install chromium
// Run: PROPR_DESKTOP_SIDEBAR_TEST=1 node --test apps/desktop/scripts/desktop-sidebar-layout.test.mjs
// Set PROPR_DESKTOP_SIDEBAR_PREVIEWS=1 to save focused evidence in .propr/previews.
it('keeps desktop selector identities, status and keyboard actions usable at narrow widths', {
  // Like the native frame suite, keep browser installation out of unit-only jobs.
  skip: process.env.PROPR_DESKTOP_SIDEBAR_TEST !== '1' && process.env.PROPR_DESKTOP_SIDEBAR_PREVIEWS !== '1'
    ? 'Set PROPR_DESKTOP_SIDEBAR_TEST=1 with Playwright Chromium installed'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-sidebar-'));
  let browser;
  try {
    await build({
      stdin: {
        resolveDir: root, loader: 'tsx', contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { DesktopContext } from './propr-ui/src/desktop/DesktopContext';
          import { DesktopInstanceSelector } from './propr-ui/src/desktop/DesktopInstanceSelector';
          import './propr-ui/src/desktop/desktop.css';
          const root = createRoot(document.getElementById('root'));
          window.renderSelector = ({ platform, width, name, kind = 'remote', username, status, transportReady }) => {
            document.documentElement.dataset.desktopWindow = platform;
            window.selectorActions = [];
            const desktop = {
              isDesktop: true, platform: platform === 'darwin' ? 'macos' : platform,
              profile: { id: 'preview', name, baseUrl: 'https://preview.example', kind,
                account: username ? { id: '101', username, avatarUrl: null } : undefined },
              connection: { status },
              openProfileManager: () => window.selectorActions.push('switch'),
              retry: () => window.selectorActions.push('retry'),
            };
            root.render(<div className={'desktop-app desktop-platform-' + (platform === 'darwin' ? 'macos' : platform)}>
              <div className="desktop-shell-content"><aside style={{ width }}>
                <div className="desktop-sidebar-drag-region" />
                <DesktopContext.Provider value={desktop}>
                  <DesktopInstanceSelector transportReady={transportReady} />
                </DesktopContext.Provider>
              </aside></div>
            </div>);
          };
        `,
      },
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    });
    const base = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#d4e8e4"/></svg>' }));
    await page.setContent('<!doctype html><html lang="en"><head><title>Sidebar layout test</title></head><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: base.css });
    await page.addStyleTag({ path: join(directory, 'renderer.css') });
    await page.addScriptTag({ path: join(directory, 'renderer.js') });
    const previews = [];
    const cases = [
      { platform: 'darwin', width: 240, viewport: 1280, name: 'This computer', kind: 'local', username: 'preview-developer', status: 'ready', transportReady: true },
      { platform: 'linux', width: 240, viewport: 1024, name: 'Shared engineering development instance', username: 'preview-engineering-automation-account', status: 'ready', transportReady: true },
      { platform: 'darwin', width: 200, viewport: 800, name: 'LongUnbrokenDevelopmentInstanceNameForPreview', username: 'preview-engineering-automation-account', status: 'ready', transportReady: false },
      { platform: 'linux', width: 176, viewport: 640, name: 'LongUnbrokenDevelopmentInstanceNameForPreview', username: 'preview-engineering-automation-account', status: 'incompatible', transportReady: false },
      { platform: 'linux', width: 200, viewport: 640, name: 'Team development', username: null, status: 'offline', transportReady: false },
    ];
    for (const [index, state] of cases.entries()) {
      await page.setViewportSize({ width: state.viewport, height: 600 });
      await page.evaluate(state => window.renderSelector(state), state);
      const selector = page.locator('.desktop-instance-selector');
      const button = selector.getByRole('button');
      const label = state.status === 'incompatible' ? 'Update required' : state.status === 'offline' ? 'Offline' : state.transportReady ? 'Connected' : 'Reconnecting';
      await expect(button).toHaveAccessibleName(`${label}: ${state.name}`);
      await expect(button).toHaveAccessibleDescription(new RegExp(state.username || 'Switch instance or GitHub account'));
      await expect(selector.locator('.desktop-connection-dot')).toHaveAttribute('title', label);
      await expect(selector.getByText('Switch', { exact: true })).toHaveCount(0);
      await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(selector.locator('.desktop-instance-icon .lucide-' + (state.kind === 'local' ? 'computer' : 'cloud'))).toHaveCount(1);
      await expect(selector.locator('.desktop-instance-icon .desktop-connection-dot')).toHaveCount(0);
      await expect(selector.locator('.desktop-instance-switch > svg.lucide-chevrons-up-down')).toHaveCount(1);
      await expect(selector.locator('.desktop-instance-switch .desktop-connection-dot')).toHaveCount(1);
      await expect(selector.locator('.desktop-instance-action')).toHaveCSS('color', 'rgb(100, 116, 139)');
      await expect(button).toHaveCSS('border-color', 'rgba(0, 0, 0, 0)');
      await button.hover();
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.05)');
      const geometry = await selector.evaluate(element => {
        const box = element.getBoundingClientRect();
        const selectors = ['button', '.desktop-instance-copy', '.desktop-instance-switch'];
        const button = element.querySelector('button').getBoundingClientRect();
        const icon = element.querySelector('.desktop-instance-icon').getBoundingClientRect();
        const copy = element.querySelector('.desktop-instance-copy').getBoundingClientRect();
        const action = element.querySelector('.desktop-instance-switch').getBoundingClientRect();
        const entity = element.querySelector('.desktop-instance-icon svg').getBoundingClientRect();
        const dot = element.querySelector('.desktop-connection-dot').getBoundingClientRect();
        return {
          rowCentered: [icon, entity, copy, action].every(bounds => Math.abs((bounds.top + bounds.bottom - button.top - button.bottom) / 2) < 1),
          actionRightInset: button.right - action.right,
          copyWidth: copy.width,
          copyActionGap: action.left - copy.right,
          statusBeforeChevron: dot.left >= action.left && dot.right < element.querySelector('.desktop-instance-action').getBoundingClientRect().left,
          buttonHeight: button.height,
          top: box.top, headerBottom: document.querySelector('.desktop-sidebar-drag-region').getBoundingClientRect().bottom,
          fits: selectors.every(selector => [...element.querySelectorAll(selector)].every(child => {
            const bounds = child.getBoundingClientRect();
            return bounds.left >= box.left && bounds.right <= box.right && child.scrollWidth <= child.clientWidth + 1;
          })),
          nameHeight: element.querySelector('strong').getBoundingClientRect().height,
        };
      });
      assert.ok(geometry.fits, `No horizontal overflow for ${JSON.stringify(state)}`);
      assert.ok(geometry.top >= geometry.headerBottom, 'Selector stays below platform titlebar');
      assert.ok(geometry.nameHeight <= 20, 'Long instance names stay on one line');
      assert.equal(geometry.buttonHeight, 32, 'Selector is one compact popup row');
      assert.ok(geometry.rowCentered, 'Icon, copy and status/action share the row center');
      assert.equal(geometry.actionRightInset, 8, 'Chevron sits at the compact right padding boundary');
      assert.equal(geometry.copyActionGap, 10, 'Text stretches to the chevron with a compact gap');
      assert.ok(geometry.statusBeforeChevron, 'Status stays beside the disclosure at the right edge');
      assert.ok(geometry.copyWidth >= state.width - 97, `Text uses the available width: ${JSON.stringify({ state, geometry })}`);
      // Start from the document so Tab, not programmatic focus, enters the control.
      await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS('outline-style', 'solid');
      await expect(button).toHaveCSS('outline-width', '2px');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.deepEqual(await page.evaluate(() => window.selectorActions), Array(2).fill('switch'));
      await page.addScriptTag({ content: axe.source });
      const accessibility = await page.evaluate(() => window.axe.run('.desktop-instance-selector', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } }));
      assert.deepEqual(accessibility.violations.map(({ id }) => id), [], 'Selector passes focused accessibility checks');
      if (process.env.PROPR_DESKTOP_SIDEBAR_PREVIEWS === '1') {
        const name = `desktop-sidebar-${state.platform}-${state.width}-${index}.png`;
        await mkdir(join(root, '.propr/previews'), { recursive: true });
        await selector.screenshot({ path: join(root, '.propr/previews', name) });
        previews.push({ path: `.propr/previews/${name}`, title: `Desktop selector: ${state.platform === 'darwin' ? 'macOS' : 'Linux'}, ${state.width}px`, description: `Production selector rendered in Chromium with ${label.toLowerCase()} status and synthetic identity; keyboard focus visible. Platform CSS only, not a native OS capture.` });
      }
    }
    if (previews.length) await writeFile(join(root, '.propr/previews/manifest.json'), JSON.stringify({ previews, toolSuggestions: [] }, null, 2));
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
