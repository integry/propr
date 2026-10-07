import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Renders the shipped SidebarNavigation in the Layout sidebar's classes with
// the shipped CSS. Permissions are synthetic; no identity or API is involved.
// Install: npx playwright install chromium
// Run: PROPR_DESKTOP_NAVIGATION_TEST=1 node --test apps/desktop/scripts/desktop-navigation-width.test.mjs
// Set PROPR_DESKTOP_NAVIGATION_PREVIEWS=1 to save focused evidence in .propr/previews.
const MEMBER = { canManageAgents: false, canManageMembers: false, canReadMcpLog: false };
const ADMINISTRATOR = { canManageAgents: true, canManageMembers: true, canReadMcpLog: true };

const cases = [
  { name: 'desktop administrator', desktop: true, viewport: { width: 1280, height: 900 }, permissions: ADMINISTRATOR },
  { name: 'desktop member', desktop: true, viewport: { width: 1280, height: 900 }, permissions: MEMBER },
  // Short windows scroll the navigation vertically with the shipped thin
  // scrollbar, which takes layout width from the scrollport.
  { name: 'desktop narrow, scrolling', desktop: true, viewport: { width: 1024, height: 380 }, permissions: ADMINISTRATOR, scrolls: true },
  // An OS-default classic scrollbar is wider than the shipped thin one. The
  // shipped non-auto scrollbar-color stays in effect, so Chromium ignores the
  // shipped 8px ::-webkit-scrollbar sizing and the native width applies.
  { name: 'desktop narrow, classic scrollbar', desktop: true, viewport: { width: 800, height: 380 }, permissions: ADMINISTRATOR, scrolls: true, classicScrollbar: true },
  { name: 'mobile 320 administrator', desktop: false, viewport: { width: 320, height: 640 }, permissions: ADMINISTRATOR },
  { name: 'mobile 390 member', desktop: false, viewport: { width: 390, height: 844 }, permissions: MEMBER },
];

it('fits desktop and mobile navigation rows, including group headers, inside the scrollport', {
  // Like the other rendered sidebar suites, keep browser installation out of unit-only jobs.
  skip: process.env.PROPR_DESKTOP_NAVIGATION_TEST !== '1' && process.env.PROPR_DESKTOP_NAVIGATION_PREVIEWS !== '1'
    ? 'Set PROPR_DESKTOP_NAVIGATION_TEST=1 with Playwright Chromium installed'
    : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-navigation-'));
  let browser;
  try {
    await build({
      stdin: {
        resolveDir: root, loader: 'tsx', contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { MemoryRouter, useLocation } from 'react-router-dom';
          import { SidebarNavigation } from './propr-ui/src/components/SidebarNavigation';
          import './propr-ui/src/desktop/desktop.css';
          const root = createRoot(document.getElementById('root'));
          function Navigation({ desktop, permissions }) {
            const location = useLocation();
            window.currentPath = location.pathname;
            return <SidebarNavigation permissions={permissions} state={{
              currentPath: location.pathname, desktop, hasAgents: true, hasRepos: false, hasTasks: true,
              taskCount: 3, goalCount: 0, generatingPlansCount: 1, unreadCount: 120,
            }} />;
          }
          window.renderNavigation = ({ desktop, permissions, classicScrollbar }) => {
            window.sessionStorage.clear();
            // Same classes as Layout's open sidebar and its navigation column.
            const sidebar = <div className="desktop-shell flex h-full min-h-0 flex-col overflow-hidden bg-light-100 relative">
              <div className="desktop-shell-content relative flex min-h-0 flex-1 overflow-hidden">
                <aside className="fixed lg:static inset-y-0 left-0 z-30 desktop-sidebar flex flex-col w-60 bg-white border-r border-gray-200 shadow-sm translate-x-0">
                  {desktop && <div className="desktop-sidebar-drag-region" aria-hidden="true" />}
                  {desktop && <div style={{ height: 48, flex: 'none' }} />}
                  {!desktop && <div className="desktop-sidebar-header flex flex-none h-12 sm:h-16" />}
                  <div className="flex min-h-0 flex-1 flex-col">
                    <MemoryRouter key={Math.random()} initialEntries={['/']}>
                      <Navigation desktop={desktop} permissions={permissions} />
                    </MemoryRouter>
                    <div className="mt-auto h-24 flex-none" />
                  </div>
                </aside>
              </div>
            </div>;
            root.render(desktop
              ? <div className={'desktop-app desktop-platform-linux' + (classicScrollbar ? ' classic-scrollbar' : '')}>{sidebar}</div>
              : <div style={{ height: '100vh' }}>{sidebar}</div>);
          };
        `,
      },
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
    });
    const base = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), { from: join(root, 'propr-ui/src/index.css') });
    // Headless Chromium hides scrollbars by default; keep classic ones in layout.
    browser = await chromium.launch({ args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
    const page = await browser.newPage();
    // An intercepted origin gives the group preference real session storage.
    await page.route('http://navigation.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><title>Navigation width test</title></head><body style="margin:0"><div id="root"></div></body></html>' }));
    await page.goto('http://navigation.test/');
    await page.addStyleTag({ content: base.css });
    await page.addStyleTag({ path: join(directory, 'renderer.css') });
    // Only scrollbar-width is reset; the native classic width is what is measured.
    await page.addStyleTag({ content: '.desktop-app.classic-scrollbar nav { scrollbar-width: auto; }' });
    await page.addScriptTag({ path: join(directory, 'renderer.js') });

    const measure = () => page.evaluate(() => {
      const nav = document.querySelector('nav');
      const box = nav.getBoundingClientRect();
      const left = box.left + nav.clientLeft;
      const right = left + nav.clientWidth;
      const style = getComputedStyle(nav);
      const rows = [...nav.querySelectorAll('a, button')].map(row => {
        const bounds = row.getBoundingClientRect();
        const rowStyle = getComputedStyle(row);
        const chevron = row.tagName === 'BUTTON' ? row.querySelector(':scope > svg').getBoundingClientRect() : null;
        return {
          name: row.textContent, tag: row.tagName, leftInset: bounds.left - left, rightInset: right - bounds.right,
          width: bounds.width, height: bounds.height, radius: rowStyle.borderTopLeftRadius,
          chevron: chevron && { rightInset: bounds.right - chevron.right, inside: chevron.left > bounds.left && chevron.top >= bounds.top && chevron.bottom <= bounds.bottom },
          contentFits: [...row.querySelectorAll('span')].every(span => {
            const inner = span.getBoundingClientRect();
            return inner.left >= bounds.left - 0.5 && inner.right <= bounds.right + 0.5;
          }),
        };
      });
      return {
        scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth, scrollHeight: nav.scrollHeight, clientHeight: nav.clientHeight,
        scrollbarWidth: nav.offsetWidth - nav.clientWidth - nav.clientLeft * 2,
        overflowX: style.overflowX, overflowY: style.overflowY,
        // A too-wide row also widens any wrapper between it and the nav.
        wrappersFit: [...nav.querySelectorAll('div')].every(wrapper => wrapper.scrollWidth <= wrapper.clientWidth),
        sidebarWidth: document.querySelector('aside').getBoundingClientRect().width,
        rows,
      };
    });

    const assertFits = (state, geometry, label) => {
      const context = `${state.name} (${label}): ${JSON.stringify(geometry)}`;
      assert.equal(geometry.sidebarWidth, 240, context);
      assert.ok(geometry.scrollWidth <= geometry.clientWidth, `No horizontal navigation overflow for ${context}`);
      assert.ok(geometry.wrappersFit, `No horizontal group overflow for ${context}`);
      // The rows are bounded, not clipped: horizontal overflow stays scrollable.
      assert.equal(geometry.overflowX, 'auto', context);
      assert.equal(geometry.overflowY, 'auto', context);
      const inset = state.desktop ? 8 : 0;
      for (const row of geometry.rows) {
        assert.ok(Math.abs(row.leftInset - inset) < 0.5 && Math.abs(row.rightInset - inset) < 0.5,
          `${row.name} keeps the ${inset}px inset on both sides for ${context}`);
        assert.equal(row.height, state.desktop ? 32 : 36, `${row.name} keeps the row height for ${context}`);
        assert.ok(row.contentFits, `${row.name} keeps its label, badges and indicators inside the row for ${context}`);
        if (state.desktop) assert.equal(row.radius, '6px', `${row.name} keeps the rounded desktop row for ${context}`);
        if (row.chevron) {
          assert.ok(row.chevron.inside, `Chevron stays inside the group header for ${context}`);
          assert.equal(row.chevron.rightInset, state.desktop ? 8 : 16, `Chevron sits on the trailing rail for ${context}`);
        }
      }
      // The header is one of the rows, so it shares their exact width.
      assert.equal(new Set(geometry.rows.map(row => row.width)).size, 1, `Every row has the same width for ${context}`);
    };

    const previews = [];
    const preview = async (name, title, description) => {
      if (process.env.PROPR_DESKTOP_NAVIGATION_PREVIEWS !== '1') return;
      await mkdir(join(root, '.propr/previews'), { recursive: true });
      // Leave the pointer outside the sidebar so no row shows a stray hover.
      await page.mouse.move(page.viewportSize().width - 1, page.viewportSize().height - 1);
      await page.locator('aside').screenshot({ path: join(root, '.propr/previews', `${name}.png`) });
      previews.push({ path: `.propr/previews/${name}.png`, title, description });
    };

    for (const state of cases) {
      await page.setViewportSize(state.viewport);
      await page.evaluate(state => window.renderNavigation(state), state);
      const nav = page.getByRole('navigation');
      const logs = nav.getByRole('button', { name: 'Logs' });
      const llmLog = nav.getByRole('link', { name: 'LLM Log' });
      const mcpLog = nav.getByRole('link', { name: 'MCP Log' });
      await expect(logs).toHaveAttribute('aria-expanded', 'false');
      await expect(llmLog).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Coding Agents' })).toHaveCount(state.permissions.canManageAgents ? 1 : 0);
      await expect(nav.getByRole('link', { name: 'Access' })).toHaveCount(state.permissions.canManageMembers ? 1 : 0);
      await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('99+');
      await expect(nav.getByRole('link', { name: /Repositories/ }).locator('[title="No repositories configured"]')).toHaveCount(1);
      const collapsed = await measure();
      assertFits(state, collapsed, 'collapsed');
      if (state.scrolls) {
        assert.ok(collapsed.scrollHeight > collapsed.clientHeight, `${state.name} scrolls vertically`);
        assert.ok(collapsed.scrollbarWidth > (state.classicScrollbar ? 8 : 0), `${state.name} has a classic scrollbar taking layout width: ${collapsed.scrollbarWidth}`);
      }

      // Keyboard: Tab from the preceding link reaches the header, which shows
      // a focus ring that fits inside the scrollport.
      await nav.getByRole('link', { name: 'Analytics' }).focus();
      await page.keyboard.press('Tab');
      await expect(logs).toBeFocused();
      if (state.desktop) {
        await expect(logs).toHaveCSS('outline-style', 'solid');
        const ring = await logs.evaluate(button => {
          const nav = button.closest('nav');
          const bounds = button.getBoundingClientRect();
          const navBounds = nav.getBoundingClientRect();
          const style = getComputedStyle(button);
          const outset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
          return { left: bounds.left - outset - navBounds.left - nav.clientLeft, right: navBounds.left + nav.clientLeft + nav.clientWidth - bounds.right - outset };
        });
        assert.ok(ring.left >= 0 && ring.right >= 0, `${state.name} focus ring fits the scrollport: ${JSON.stringify(ring)}`);
      }
      await page.keyboard.press('Enter');
      await expect(logs).toHaveAttribute('aria-expanded', 'true');
      await expect(llmLog).toBeVisible();
      await expect(mcpLog).toHaveCount(state.permissions.canReadMcpLog ? 1 : 0);
      assertFits(state, await measure(), 'expanded by keyboard');
      if (state.desktop && state.viewport.height > 400 && state.permissions === ADMINISTRATOR) {
        await preview('desktop-navigation-expanded-focused', 'Desktop navigation: Logs expanded, keyboard focus',
          'Production SidebarNavigation in the 240px desktop sidebar (Chromium, shipped CSS, synthetic administrator permissions). The Logs header, its chevron and focus ring keep the 8px inset; no horizontal scrollbar.');
      }
      await page.keyboard.press('Space');
      await expect(logs).toHaveAttribute('aria-expanded', 'false');
      await expect(llmLog).toHaveCount(0);

      // Pointer: open the group and navigate into it; the header then carries
      // the active treatment and the group stays inside the scrollport.
      await logs.click();
      await expect(logs).toHaveAttribute('aria-expanded', 'true');
      await llmLog.click();
      await expect.poll(() => page.evaluate(() => window.currentPath)).toBe('/llm-logs');
      if (state.desktop) {
        await expect(logs).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.05)');
        await expect(llmLog).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.05)');
      }
      const active = await measure();
      assertFits(state, active, 'expanded and active');
      if (state.scrolls) {
        await nav.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(nav.getByRole('link', { name: 'Settings' })).toBeInViewport();
        assert.equal(await nav.evaluate(element => element.scrollLeft), 0);
        if (state.classicScrollbar) {
          await preview('desktop-navigation-classic-scrollbar', 'Desktop navigation: short window with a classic scrollbar',
            'Production SidebarNavigation scrolled to the end with Logs expanded and LLM Log active; rows fit beside the classic vertical scrollbar with no horizontal scrollbar.');
        }
      } else if (!state.desktop && state.viewport.width === 320) {
        await preview('mobile-navigation-320', 'Mobile navigation at 320px',
          'Production web SidebarNavigation in the open mobile sidebar at a 320px viewport with Logs expanded and LLM Log active; no horizontal overflow.');
      }
    }
    if (previews.length) {
      await writeFile(join(root, '.propr/previews/manifest.json'), JSON.stringify({ previews, toolSuggestions: [] }, null, 2));
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
