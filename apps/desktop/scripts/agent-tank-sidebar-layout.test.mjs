import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { expect } from '@playwright/test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const enabled = process.env.PROPR_AGENT_TANK_SIDEBAR_TEST === '1'
  || process.env.PROPR_AGENT_TANK_SIDEBAR_PREVIEWS === '1';

// Render the shipped component and utility CSS in Chromium. scrollbar-gutter
// reserves the same layout space as a non-overlay Linux scrollbar, even when
// the headless browser itself uses overlay scrollbars.
// Run: PROPR_AGENT_TANK_SIDEBAR_TEST=1 node --test apps/desktop/scripts/agent-tank-sidebar-layout.test.mjs
// Preview: PROPR_AGENT_TANK_SIDEBAR_PREVIEWS=1 node --test apps/desktop/scripts/agent-tank-sidebar-layout.test.mjs
it('keeps collapsed and expanded desktop usage rows inside a classic-scrollbar scrollport', {
  skip: enabled ? false : 'Set PROPR_AGENT_TANK_SIDEBAR_TEST=1 with Playwright Chromium installed',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-agent-tank-sidebar-'));
  let browser;

  try {
    await build({
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import AgentTankSidebar from './propr-ui/src/components/AgentTankSidebar';

          const usage = {
            enabled: true,
            agents: {
              claude: { name: 'claude', usage: {
                session: { percent: 17, resetsIn: '2h 14m' },
                weeklyAll: { percent: 58, resetsIn: '3d 4h' },
                weeklySonnet: { percent: 82, resetsIn: '3d 4h' },
                weeklyFable: { percent: 41, resetsIn: '3d 4h' },
              } },
              codex: { name: 'codex', usage: {
                fiveHour: { percentUsed: 12, resetsIn: '3h 41m' },
                weekly: { percentUsed: 64, resetsIn: '5d 2h' },
              } },
              antigravity: { name: 'antigravity', usage: { models: [
                { model: 'antigravity-gemini-3.8-flash-medium', percentUsed: 8, resetsIn: '1h' },
                { model: 'antigravity-gemini-3.8-flash-high', percentUsed: 17, resetsIn: '1h' },
                { model: 'antigravity-gemini-3.7-flash-low', percentUsed: 31, resetsIn: '1h' },
                { model: 'antigravity-gemini-3.5-pro-high', percentUsed: 52, resetsIn: '1h' },
                { model: 'antigravity-claude-sonnet-4.6-thinking', percentUsed: 68, resetsIn: '1h' },
                { model: 'antigravity-claude-opus-4.6-thinking', percentUsed: 84, resetsIn: '1h' },
                { model: 'antigravity-gpt-oss-120b-medium', percentUsed: 96, resetsIn: '1h' },
              ] } },
            },
          };

          const root = createRoot(document.getElementById('root'));
          let renderKey = 0;
          window.agentTankRefreshes = 0;
          window.agentTankUsage = usage;
          window.renderUsage = ({ width, zoom }) => {
            renderKey += 1;
            // Expansion state persists to localStorage, so each synthetic layout
            // run starts from the collapsed default instead of inheriting the
            // rows the previous case left open.
            try { window.localStorage.clear(); } catch { /* storage may be unavailable */ }
            root.render(
              <div className="desktop-app desktop-platform-linux" style={{ zoom }}>
                <aside className="desktop-sidebar bg-white" style={{ width }}>
                  <AgentTankSidebar key={renderKey} scrollable />
                </aside>
              </div>
            );
          };
        `,
      },
      outfile: join(directory, 'renderer.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      plugins: [{
        name: 'agent-tank-api-fixture',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /\.\.\/api\/revertApi$/ }, () => ({
            path: 'agent-tank-api-fixture',
            namespace: 'agent-tank-test',
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: 'agent-tank-test' }, () => ({
            loader: 'js',
            contents: `
              export const getAgentTankUsage = async () => window.agentTankUsage;
              export const refreshAgentTank = async () => {
                window.agentTankRefreshes += 1;
                return { success: true };
              };
            `,
          }));
        },
      }],
    });

    const compiledCss = await postcss([
      tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] }),
    ]).process(await readFile(join(root, 'propr-ui/src/index.css'), 'utf8'), {
      from: join(root, 'propr-ui/src/index.css'),
    });

    browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
    await page.setContent('<!doctype html><html lang="en"><head><title>Usage sidebar layout</title></head><body><div id="root"></div></body></html>');
    await page.addStyleTag({ content: compiledCss.css });
    await page.addStyleTag({ path: join(root, 'propr-ui/src/desktop/desktop.css') });
    await page.addStyleTag({ content: `
      body { margin: 0; }
      .agent-tank-scrollport { scrollbar-gutter: stable; }
    ` });
    await page.addScriptTag({ path: join(directory, 'renderer.js') });

    const previewEntries = [];
    const layoutCases = [
      { width: 240, zoom: 1, label: 'default' },
      { width: 240, zoom: 1.25, label: '125-percent-zoom' },
    ];

    for (const layoutCase of layoutCases) {
      await page.evaluate(state => window.renderUsage(state), layoutCase);
      const widget = page.getByText('Usage', { exact: true }).locator('..').locator('..');
      const scrollport = widget.locator('.agent-tank-scrollport');
      const providerRows = scrollport.locator('[role="button"][aria-expanded]');
      await expect(providerRows).toHaveCount(3);
      await expect(providerRows.nth(0)).toContainText('Claude');
      await expect(providerRows.nth(1)).toContainText('Codex');
      await expect(providerRows.nth(2)).toContainText('Antigravity');

      const assertHorizontalFit = async state => {
        const geometry = await scrollport.evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const renderedScale = bounds.width / element.offsetWidth;
          const contentRight = bounds.left + (element.clientWidth * renderedScale);
          const providerRows = [...element.querySelectorAll('[role="button"][aria-expanded]')];
          const percentages = [...element.querySelectorAll('span')]
            .filter(node => /^\d+%$/.test(node.textContent?.trim() || ''));
          const bars = percentages.map(node => node.previousElementSibling);
          const essential = [
            ...providerRows.flatMap(row => [...row.children]),
            ...percentages,
            ...bars,
          ];
          const providerLabels = providerRows.map(row => row.firstElementChild?.lastElementChild);
          element.scrollLeft = 100;
          return {
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            scrollLeft: element.scrollLeft,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            essentialFits: essential.every(node => {
              if (!(node instanceof Element)) return false;
              const box = node.getBoundingClientRect();
              return box.left >= bounds.left - 0.5 && box.right <= contentRight + 0.5;
            }),
            providerLabels: providerLabels.map(node => node instanceof HTMLElement ? ({
              text: node.textContent,
              title: node.title,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
            }) : null),
          };
        });
        assert.ok(
          geometry.scrollWidth <= geometry.clientWidth,
          `${state}: ${JSON.stringify(geometry)}`,
        );
        assert.equal(geometry.scrollLeft, 0, `${state}: horizontal scrolling is impossible`);
        assert.ok(geometry.essentialFits, `${state}: controls, bars and percentages remain inside the scrollport`);
        assert.ok(geometry.providerLabels.every(label => (
          label && label.scrollWidth <= label.clientWidth && label.title === label.text
        )), `${state}: provider labels remain unclipped and retain full-name tooltips: ${JSON.stringify(geometry.providerLabels)}`);
        return geometry;
      };

      const collapsed = await assertHorizontalFit(`${layoutCase.label}, collapsed`);
      assert.equal(collapsed.scrollHeight, collapsed.clientHeight, 'Collapsed providers do not need vertical scrolling');

      const antigravityRow = providerRows.nth(2);
      await antigravityRow.hover();
      await expect(antigravityRow).toHaveCSS('background-color', 'rgba(15, 23, 42, 0.05)');
      await providerRows.nth(1).focus();
      await page.keyboard.press('Tab');
      await expect(antigravityRow).toBeFocused();
      await expect(antigravityRow).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Enter');
      await expect(antigravityRow).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Space');
      await expect(antigravityRow).toHaveAttribute('aria-expanded', 'false');

      for (let index = 0; index < await providerRows.count(); index += 1) {
        await providerRows.nth(index).click();
      }
      await expect(providerRows.nth(2)).toHaveAttribute('aria-expanded', 'true');
      const expanded = await assertHorizontalFit(`${layoutCase.label}, expanded`);
      assert.ok(expanded.scrollHeight > expanded.clientHeight, 'Expanded metrics retain vertical scrolling');
      assert.ok(await scrollport.locator('span').filter({ hasText: /^\d+%$/ }).count() >= 12, 'Representative metrics render');

      await scrollport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await scrollport.evaluate(element => element.scrollTop), 'The metrics scrollport can reach lower providers');

      const refresh = widget.getByRole('button', { name: 'Refresh usage' });
      await expect(refresh).toBeVisible();
      const refreshFits = await widget.evaluate(element => {
        const widgetBounds = element.getBoundingClientRect();
        const refreshBounds = element.querySelector('[aria-label="Refresh usage"]')?.getBoundingClientRect();
        return Boolean(refreshBounds
          && refreshBounds.left >= widgetBounds.left
          && refreshBounds.right <= widgetBounds.right);
      });
      assert.ok(refreshFits, 'The refresh control stays inside the Usage widget');
      const refreshesBeforeClick = await page.evaluate(() => window.agentTankRefreshes);
      await refresh.click();
      await expect.poll(() => page.evaluate(() => window.agentTankRefreshes)).toBe(refreshesBeforeClick + 1);

      if (process.env.PROPR_AGENT_TANK_SIDEBAR_PREVIEWS === '1') {
        const previewDirectory = join(root, '.propr/previews');
        await mkdir(previewDirectory, { recursive: true });
        const filename = `agent-tank-sidebar-linux-${layoutCase.label}.png`;
        await widget.screenshot({ path: join(previewDirectory, filename) });
        previewEntries.push({
          path: `.propr/previews/${filename}`,
          title: `Linux Usage sidebar (${layoutCase.label})`,
          description: 'Production Usage component in Chromium with synthetic Claude, Codex, and Antigravity data, expanded rows, a reserved classic scrollbar gutter, and no horizontal scrollbar.',
        });
      }
    }

    if (process.env.PROPR_AGENT_TANK_SIDEBAR_PREVIEWS === '1') {
      await writeFile(join(root, '.propr/previews/manifest.json'), JSON.stringify({
        previews: previewEntries,
        toolSuggestions: [],
      }, null, 2));
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
