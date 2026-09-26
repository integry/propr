import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { chromium, _electron } from 'playwright';
import { expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import sharp from 'sharp';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');

// Native verification: PROPR_DESKTOP_MAC_CHROME_TEST=1 node --test
// apps/desktop/scripts/macos-window-chrome.test.mjs on a logged-in Mac with
// Screen Recording permission for Electron. Uses a new temporary userData path;
// it never launches, closes, or modifies the installed app or its login session.
// Optional focused previews: PROPR_DESKTOP_MAC_CHROME_PREVIEWS=.propr/previews
async function exerciseChrome(context, native) {
  if (native && (process.platform !== 'darwin' || process.env.PROPR_DESKTOP_MAC_CHROME_TEST !== '1')) {
    context.skip('Requires macOS and PROPR_DESKTOP_MAC_CHROME_TEST=1 (native window capture)');
    return;
  }
  const executablePath = [chromium.executablePath(), '/usr/bin/chromium'].find(existsSync);
  if (!native && !executablePath) {
    context.skip('Install Playwright Chromium for the renderer geometry regression');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'propr-macos-chrome-'));
  let application, browser, server;
  try {
    await build({
      entryPoints: [join(desktop, 'scripts/fixtures/macos-window-chrome/renderer.tsx')],
      outfile: join(directory, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
      resolveExtensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
      define: { 'process.platform': '"darwin"', 'import.meta.env': '{}', __APP_VERSION__: '"chrome-test"', __PROPR_DESKTOP__: 'true' },
    });
    await mkdir(join(directory, 'media'));
    await copyFile(join(root, 'propr-ui/public/media/logo-and-name-transparent.png'), join(directory, 'media/logo-and-name-transparent.png'));
    await copyFile(join(root, 'propr-ui/public/logo.png'), join(directory, 'logo.png'));
    const baseCss = await readFile(join(root, 'propr-ui/src/index.css'), 'utf8');
    const compiled = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(baseCss, { from: join(root, 'propr-ui/src/index.css') });
    await writeFile(join(directory, 'base.css'), compiled.css);
    await writeFile(join(directory, 'renderer.html'), '<!doctype html><html><head><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    server = createServer(async (request, response) => {
      const asset = new URL(request.url, 'http://fixture').pathname.slice(1);
      if (!['renderer.html', 'renderer.js', 'renderer.css', 'base.css', 'logo.png', 'media/logo-and-name-transparent.png'].includes(asset)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.png') ? 'image/png' : 'text/html');
      response.end(await readFile(join(directory, asset)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/renderer.html`;
    let page;
    if (native) {
      await mkdir(join(directory, 'user-data'));
      await build({
        stdin: { contents: `
          import { app, BrowserWindow, screen } from 'electron';
          import { createBrowserWindowOptions } from './src/window-options';
          app.setPath('userData', process.env.PROPR_CHROME_USER_DATA);
          app.whenReady().then(async () => {
            const win = new BrowserWindow(createBrowserWindowOptions(undefined, true, screen.getPrimaryDisplay().workArea, 'darwin'));
            await win.loadURL(process.env.PROPR_CHROME_URL);
            win.show(); win.focus();
          });`, resolveDir: desktop },
        outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      });
      application = await _electron.launch({ args: [join(directory, 'main.cjs')], env: {
        ...process.env, PROPR_CHROME_USER_DATA: join(directory, 'user-data'), PROPR_CHROME_URL: url,
      } });
      page = await application.firstWindow();
    } else {
      browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
      page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
    }
    await page.route('http://127.0.0.1:3000/**', route => route.fulfill({ status: 503, json: { error: 'Isolated chrome fixture' } }));
    page.on('pageerror', error => context.diagnostic(error.message));
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Choose an instance' })).toBeVisible();
    await expect(page.locator('.desktop-entry')).toHaveClass(/desktop-platform-macos/);
    const drag = page.locator('.desktop-entry-drag-region');
    await expect(drag).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(drag).toHaveCSS('border-bottom-width', '0px');
    await expect(drag).toHaveCSS('-webkit-app-region', 'drag');

    const previews = [];
    const capture = async (name, title) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const renderer = await page.screenshot({ scale: 'css' });
      let pixels = renderer;
      if (native) {
        // BrowserWindow.capturePage / page.screenshot omit native titlebar
        // painting. Capture this window through the OS and compare the strip.
        const png = await application.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const { width, height } = win.getBounds();
          const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width, height } });
          const source = sources.find(item => item.id === win.getMediaSourceId());
          if (!source || source.thumbnail.isEmpty()) throw new Error('Enable Screen Recording for Electron to verify native chrome');
          return source.thumbnail.toPNG().toString('base64');
        });
        pixels = Buffer.from(png, 'base64');
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const metadata = await sharp(pixels).metadata();
        assert.equal(metadata.width / metadata.height, size.width / size.height, 'Native capture must cover the window without cropping');
        pixels = await sharp(pixels).resize(size.width, size.height).png().toBuffer();
        const controls = await sharp(pixels).extract({ left: 0, top: 0, width: 80, height: 56 }).removeAlpha().raw().toBuffer();
        const colors = new Set();
        let controlsBottom = 0;
        for (let y = 0; y < 56; y += 1) {
          for (let x = 0; x < 80; x += 1) {
            const offset = (y * 80 + x) * 3;
            const [r, g, b] = controls.subarray(offset, offset + 3);
            const color = r > 180 && g < 140 && b < 140 ? 'red'
              : r > 180 && g > 140 && b < 100 ? 'yellow'
                : g > 140 && r < 100 && b < 140 ? 'green' : null;
            if (color) { colors.add(color); controlsBottom = Math.max(controlsBottom, y + 1); }
          }
        }
        assert.equal(colors.size, 3, 'OS capture must include all three native traffic lights');
        if (name === 'connected') {
          const selector = await page.locator('.desktop-instance-selector').boundingBox();
          assert.ok(selector.y >= controlsBottom + 8, 'Workspace must clear the native controls');
        }
        const rgb = async (bytes, x, y) => [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
        // Native vibrancy intentionally differs from Chromium's transparent pixels.
        for (const x of name === 'connected' ? [400, 700] : [110, 220, 400, 700]) {
          for (const y of [5, 20, 40]) {
            const expected = await rgb(renderer, x, y);
            const actual = await rgb(pixels, x, y);
            assert.ok(actual.every((channel, i) => Math.abs(channel - expected[i]) <= 8), `Native strip differs from renderer at ${x},${y}: ${actual} vs ${expected}`);
          }
        }
      }
      if (process.env.PROPR_DESKTOP_MAC_CHROME_PREVIEWS && name === 'connected') {
        const output = resolve(root, process.env.PROPR_DESKTOP_MAC_CHROME_PREVIEWS);
        await mkdir(output, { recursive: true });
        const filename = `${native ? 'native' : 'renderer'}-macos-${name}.png`;
        const sidebar = await page.locator('.desktop-sidebar').boundingBox();
        assert.ok(sidebar);
        await sharp(pixels).extract({ left: Math.round(sidebar.x), top: Math.round(sidebar.y), width: Math.round(sidebar.width), height: Math.round(sidebar.height) }).toFile(join(output, filename));
        previews.push({ path: `.propr/previews/${filename}`, title, description: `${native ? 'Native macOS window capture' : 'Chromium renderer only; native controls are not rendered'}: production desktop components using the Electron adapter's macos platform. Isolated fixture account.` });
        await writeFile(join(output, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: native ? [] : [{ name: 'macOS Electron with Screen Recording permission', reason: 'Run PROPR_DESKTOP_MAC_CHROME_TEST=1 node --test apps/desktop/scripts/macos-window-chrome.test.mjs to verify native titlebar pixels before merge.' }] }, null, 2));
      }
    };
    await capture('entry', 'macOS entry: continuous gradient through the drag region');
    await page.getByRole('button', { name: 'This computer Local instance' }).click();
    await expect(page.getByTestId('happening-now-section')).toBeVisible();
    await expect(page.locator('.desktop-sidebar-header')).toHaveCount(0);
    await expect(page.locator('.desktop-sidebar img[alt="ProPR"]')).toHaveCount(0);
    await expect(page.locator('.desktop-sidebar')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.4)');
    await expect(page.locator('.desktop-content-toolbar')).toHaveCSS('background-color', 'rgb(252, 253, 253)');
    for (const selector of ['html', 'body', '#root', '.desktop-app', '.desktop-shell', '.desktop-connected-drag-region']) {
      await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    }
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCSS('border-radius', '6px');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCSS('height', '32px');
    await capture('connected', 'macOS sidebar: compact workspace and neutral source list');
    for (const width of [1280, 880]) {
      if (native) await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 820), width);
      else await page.setViewportSize({ width, height: 820 });
      if (width === 880) await page.getByRole('button', { name: 'Open menu' }).click();
      await expect.poll(async () => (await page.locator('.desktop-sidebar').boundingBox()).x).toBe(0);
      // Cover absent, zero and larger-than-minimum safe areas using the
      // shipped CSS and real browser layout, including the actual workspace control.
      for (const inset of [undefined, 0, 120]) {
        // Evaluate the shipped declaration with env() replaced only by a test
        // value: Chromium has no public CDP setter for titlebar-area-x.
        const css = await readFile(join(root, 'propr-ui/src/desktop/desktop.css'), 'utf8');
        const style = await page.addStyleTag({ content: inset === undefined ? '/* native env value */' : css.replace(/env\(titlebar-area-x,\s*[^)]+\)/g, `${inset}px`) });
        const box = await page.locator('.desktop-instance-selector-button').boundingBox();
        const sidebar = await page.locator('.desktop-sidebar').boundingBox();
        assert.ok(box && sidebar);
        const drag = page.locator('.desktop-sidebar-drag-region');
        const dragBox = await drag.boundingBox();
        assert.ok(dragBox.height >= 40 && dragBox.height <= 52, 'Empty drag strip reserves native control clearance');
        assert.equal(await drag.locator('*').count(), 0, 'Drag strip contains no interactive content');
        assert.equal(box.y, dragBox.y + dragBox.height, 'Workspace sits directly below the drag strip');
        assert.equal(box.x, sidebar.x + 8, 'Workspace has an eight-pixel inset');
        assert.equal(box.height, 32);
        assert.ok(box.x + box.width <= sidebar.x + sidebar.width, 'Workspace fits inside the sidebar');
        await style.evaluate(element => element.remove());
      }
    }
  } finally {
    await application?.close();
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

it('macOS renderer uses the real platform selectors and keeps the workspace clear of traffic lights', { timeout: 120_000 }, context => exerciseChrome(context, false));
it('macOS native composed titlebar matches the renderer background', { timeout: 120_000 }, context => exerciseChrome(context, true));
