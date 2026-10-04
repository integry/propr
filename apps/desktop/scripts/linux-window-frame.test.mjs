import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { build } from 'esbuild';
import { _electron } from 'playwright';
import { expect } from '@playwright/test';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import sharp from 'sharp';
import tailwindConfig from '../../../propr-ui/tailwind.config.js';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');
const fixture = join(desktop, 'scripts/fixtures/linux-window-frame');

// Opt in with PROPR_DESKTOP_FRAME_TEST=1 on an isolated X11 DISPLAY with a WM
// (e.g. Xvfb + Xfwm4/Openbox), xdotool, and a compositor (e.g. Picom) for
// native pixel assertions. PROPR_DESKTOP_FRAME_PREVIEWS=.propr/previews also
// saves those captures.
const exerciseLinuxFrame = async (context, managerOpen) => {
  if (process.env.PROPR_DESKTOP_FRAME_TEST !== '1' || process.platform !== 'linux' || !process.env.DISPLAY) {
    context.skip('Set PROPR_DESKTOP_FRAME_TEST=1 on an isolated Linux DISPLAY with a window manager and xdotool');
    return;
  }
  try { execFileSync('xdotool', ['getdisplaygeometry']); } catch {
    context.skip('Install xdotool for native Linux frame interactions');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'propr-linux-frame-'));
  let application;
  try {
    for (const entry of ['main', 'preload']) {
      await build({
        entryPoints: [join(fixture, `${entry}.ts`)], outfile: join(directory, `${entry}.cjs`),
        bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
      });
    }
    await build({
      entryPoints: [join(fixture, 'renderer.tsx')], outfile: join(directory, 'renderer.js'),
      bundle: true, platform: 'browser', format: 'iife',
      // Match Vite's TypeScript resolution (TaskList has both utils.ts/.tsx).
      resolveExtensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
      define: { 'import.meta.env': '{}', __APP_VERSION__: '"frame-test"', __PROPR_DESKTOP__: 'true' },
    });
    const baseCss = await readFile(join(root, 'propr-ui/src/index.css'), 'utf8');
    const compiled = await postcss([tailwind({ ...tailwindConfig, content: [join(root, 'propr-ui/src/**/*.{ts,tsx}')] })])
      .process(baseCss, { from: join(root, 'propr-ui/src/index.css') });
    await writeFile(join(directory, 'base.css'), compiled.css);
    await writeFile(join(directory, 'renderer.html'), '<!doctype html><html><head><title>ProPR Desktop</title><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    application = await _electron.launch({
      args: ['--no-sandbox', join(directory, 'main.cjs')],
      env: { ...process.env, PROPR_FRAME_ICON: join(desktop, 'assets/icons/propr-desktop.png'), PROPR_FRAME_LOGO: join(root, 'propr-ui/public/logo.png') },
    });
    await expect.poll(() => application.windows().length).toBe(2);
    const page = application.windows().find(window => window.url().startsWith('frame-fixture:'));
    assert.ok(page);
    // Production Layout/Dashboard, but never contact a developer's local API.
    await page.route('http://127.0.0.1:3000/**', route => route.fulfill({ status: 503, json: { error: 'Isolated frame fixture' } }));
    await expect(page.getByRole('heading', { name: 'Choose an instance' })).toBeVisible();
    const html = page.locator('html');
    const native = action => application.evaluate(({ BrowserWindow }, operation) => {
      const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().startsWith('frame-fixture:'));
      if (operation === 'restore') { window.restore(); window.show(); window.focus(); }
      if (operation === 'fullscreen') window.setFullScreen(true);
      if (operation === 'leave-fullscreen') window.setFullScreen(false);
      if (operation === 'focus') window.focus();
      return { bounds: window.getBounds(), maximized: window.isMaximized(), minimized: window.isMinimized(), nativeId: window.getNativeWindowHandle().readUInt32LE(0).toString() };
    }, action);
    const pointerClick = async name => {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      assert.ok(box);
      const { bounds, nativeId } = await native('focus');
      // XTest input enters through the WM's native drag hit test. Playwright
      // mouse/DOM clicks bypass that test and missed the connected regression.
      await expect(html).toHaveAttribute('data-window-focused', 'true');
      execFileSync('xdotool', ['windowraise', nativeId, 'mousemove', String(Math.round(bounds.x + box.x + box.width / 2)), String(Math.round(bounds.y + box.y + box.height / 2)), 'click', '1'], { timeout: 5_000 });
    };
    const focusBackground = async () => {
      await application.evaluate(async ({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        // An invisible one-pixel focus target avoids raising the white backdrop
        // over the app. Focus still comes from a real native window transition.
        let target = windows.find(window => window.getTitle() === 'Focus target');
        if (!target) {
          target = new BrowserWindow({ x: 0, y: 0, width: 1, height: 1, frame: false, transparent: true, show: false });
          await target.loadURL('data:text/html,<title>Focus target</title>');
          target.setOpacity(0);
        }
        target.show();
        target.focus();
      });
      await expect(html).toHaveAttribute('data-window-focused', 'false');
    };
    const frameStyle = () => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement, '::after');
      return { width: style.borderTopWidth, color: style.borderTopColor, display: style.display, pointerEvents: style.pointerEvents };
    });
    const previews = [];
    const capture = async (name, title, stripX = 200) => {
      if (managerOpen) return;
      const output = process.env.PROPR_DESKTOP_FRAME_PREVIEWS
        ? resolve(root, process.env.PROPR_DESKTOP_FRAME_PREVIEWS)
        : null;
      if (output) await mkdir(output, { recursive: true });
      // Native configure/focus events precede the compositor's painted frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await new Promise(resolve => setTimeout(resolve, 250));
      const png = await application.evaluate(async ({ desktopCapturer, screen }) => {
        const { width, height } = screen.getPrimaryDisplay().size;
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
        return sources[0].thumbnail.toPNG().toString('base64');
      });
      const bytes = Buffer.from(png, 'base64');
      const { bounds } = await native();
      const pixelAt = async (x, y) => [...await sharp(bytes).extract({ left: bounds.x + x, top: bounds.y + y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
      const inactive = name.endsWith('-inactive');
      const tint = inactive ? [240, 245, 244] : [233, 241, 240];
      const chromeX = stripX < 0 ? bounds.width + stripX : stripX;
      assert.deepEqual(await pixelAt(chromeX, 12), tint, 'Capture must show the actual focused/unfocused strip, not an occluding window or an earlier frame');
      if (!name.includes('-maximized-')) {
        assert.deepEqual(await pixelAt(3, 100), inactive ? [180, 194, 192] : [147, 166, 164], 'A visible one-pixel edge must separate the app from white');
        assert.ok((await pixelAt(2, 100)).every(channel => channel > 220), 'The adjacent shadow must not be a solid gray rim');
      } else {
        assert.deepEqual(await pixelAt(0, 0), tint, 'Maximized chrome must reach the screen corner without a rounded gap or border');
      }
      if (output) {
        await writeFile(join(output, `${name}.png`), bytes);
        previews.push({ path: `.propr/previews/${name}.png`, title, description: name.includes('-normal-')
          ? 'Production desktop chooser on X11/Openbox over white: one-pixel boundary, subtle upper corners and short shadow blended by Picom.'
          : name.includes('-connected-')
            ? 'Production connected desktop on X11/Openbox over white: compact workspace selector, neutral source-list sidebar and integrated window chrome.'
            : 'Production desktop chooser maximized on X11/Openbox: compact tinted strip flush with the display, with no frame inset, shadow or corner gaps.' });
        await writeFile(join(output, 'manifest.json'), JSON.stringify({ previews, toolSuggestions: [] }, null, 2));
      }
    };

    await expect(html).toHaveAttribute('data-window-focused', 'true');
    await expect(html).toHaveAttribute('data-window-expanded', 'false');
    assert.deepEqual(await frameStyle(), { width: '1px', color: 'rgb(147, 166, 164)', display: 'block', pointerEvents: 'none' });
    assert.equal(await page.locator('.desktop-entry-drag-region').evaluate(element => element.getBoundingClientRect().height), 44);
    const artwork = page.locator('.desktop-brand img');
    await expect(artwork).toHaveAttribute('src', '/logo.png');
    assert.equal(await artwork.evaluate(img => img.currentSrc), 'frame-fixture://app/logo.png');
    await expect.poll(() => artwork.evaluate(img => img.complete && img.naturalWidth === 30 && img.naturalHeight === 32)).toBe(true);
    const artworkBox = await artwork.boundingBox();
    assert.ok(artworkBox);
    assert.equal(artworkBox.width, 32);
    assert.equal(artworkBox.height, 32);
    const sourceArtworkPixels = await artwork.evaluate(img => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      return {
        corner: [...context.getImageData(0, 0, 1, 1).data],
        center: [...context.getImageData(15, 16, 1, 1).data],
      };
    });
    assert.ok(sourceArtworkPixels.corner[3] <= 2, 'Displayed chooser artwork must retain its transparent corner');
    assert.ok(sourceArtworkPixels.center[3] >= 190, 'Displayed chooser artwork must retain its visible center');
    const { data: renderedArtwork, info: renderedArtworkInfo } = await sharp(await artwork.screenshot())
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const renderedCorner = [...renderedArtwork.subarray(0, renderedArtworkInfo.channels)];
    const renderedCenterOffset = (Math.floor(renderedArtworkInfo.height / 2) * renderedArtworkInfo.width
      + Math.floor(renderedArtworkInfo.width / 2)) * renderedArtworkInfo.channels;
    const renderedCenter = [...renderedArtwork.subarray(renderedCenterOffset, renderedCenterOffset + renderedArtworkInfo.channels)];
    assert.ok(renderedCorner.every(channel => channel >= 245), 'Transparent artwork corner must reveal the light production card');
    assert.ok(Math.max(...renderedCenter) - Math.min(...renderedCenter) >= 60, 'Rendered artwork center must remain visibly colored');
    await capture('linux-normal-active', 'Linux: normal, active');
    await focusBackground();
    assert.equal((await frameStyle()).color, 'rgb(180, 194, 192)');
    await capture('linux-normal-inactive', 'Linux: normal, inactive');
    await native('focus');
    await expect(html).toHaveAttribute('data-window-focused', 'true');

    const beforeDrag = (await native()).bounds;
    execFileSync('xdotool', ['mousemove', '--sync', String(beforeDrag.x + 250), String(beforeDrag.y + 20), 'mousedown', '1', 'sleep', '.1', 'mousemove', '--sync', String(beforeDrag.x + 260), String(beforeDrag.y + 30), 'sleep', '.1', 'mousemove', '--sync', String(beforeDrag.x + 270), String(beforeDrag.y + 40), 'sleep', '.1', 'mouseup', '1']);
    await expect.poll(async () => (await native()).bounds.x).toBeGreaterThan(beforeDrag.x);
    const beforeResize = (await native()).bounds;
    execFileSync('xdotool', ['mousemove', '--sync', String(beforeResize.x + beforeResize.width - 1), String(beforeResize.y + 300), 'mousedown', '1', 'sleep', '.1', 'mousemove', '--sync', String(beforeResize.x + beforeResize.width - 21), String(beforeResize.y + 300), 'sleep', '.1', 'mousemove', '--sync', String(beforeResize.x + beforeResize.width - 41), String(beforeResize.y + 300), 'sleep', '.1', 'mouseup', '1']);
    await expect.poll(async () => (await native()).bounds.width).toBeLessThan(beforeResize.width);

    const resizedWidth = (await native()).bounds.width;
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    const workArea = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
    await expect.poll(async () => (await native()).bounds).toEqual(workArea);
    assert.equal((await frameStyle()).display, 'none');
    assert.deepEqual(await page.locator('.desktop-entry').boundingBox(), { x: 0, y: 0, width: workArea.width, height: workArea.height });
    await capture('linux-maximized-active', 'Linux: maximized, active');
    await focusBackground();
    await capture('linux-maximized-inactive', 'Linux: maximized, inactive');
    await native('focus');
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'false');
    assert.equal((await native()).bounds.width, resizedWidth);

    // A native double-click and fullscreen bypass the renderer control IPC.
    const restored = (await native()).bounds;
    execFileSync('xdotool', ['mousemove', '--sync', String(restored.x + 250), String(restored.y + 20), 'click', '--repeat', '2', '--delay', '100', '1']);
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    await pointerClick('Maximize or restore window');
    await native('fullscreen');
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    await native('leave-fullscreen');
    await expect(html).toHaveAttribute('data-window-expanded', 'false');
    await page.reload();
    await expect(html).toHaveAttribute('data-window-expanded', 'false');

    await pointerClick('This computer Local instance');
    await expect(page.getByTestId('happening-now-section')).toBeVisible();
    // Reload with a saved active profile so the connected shell is also tested
    // on startup, not only after the chooser-to-Dashboard transition.
    await page.reload();
    await expect(page.getByTestId('happening-now-section')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connected: This computer' })).toBeVisible();
    await expect(page.locator('.desktop-sidebar-header')).toHaveCount(0);
    await expect(page.locator('.desktop-sidebar img[alt="ProPR"]')).toHaveCount(0);
    await expect(page.locator('.desktop-sidebar')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.4)');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCSS('border-radius', '6px');
    await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCSS('height', '32px');
    const sidebarDrag = page.locator('.desktop-sidebar-drag-region');
    assert.equal(await sidebarDrag.locator('*').count(), 0, 'Connected sidebar drag strip must remain non-interactive');
    const sidebarDragBox = await sidebarDrag.boundingBox();
    assert.ok(sidebarDragBox);
    assert.equal(sidebarDragBox.height, 44);
    const selectorBox = await page.locator('.desktop-instance-selector-button').boundingBox();
    const sidebarBox = await page.locator('.desktop-sidebar').boundingBox();
    assert.ok(selectorBox && sidebarBox);
    assert.equal(selectorBox.x, sidebarBox.x + 8, 'Workspace selector keeps the current eight-pixel sidebar inset');
    assert.equal(selectorBox.y, sidebarDragBox.y + 44, 'Workspace selector sits directly below the empty drag strip');
    assert.equal(selectorBox.height, 32);
    for (const focused of [true, false]) {
      if (focused) await native('focus');
      else await focusBackground();
      await expect(html).toHaveAttribute('data-window-focused', String(focused));
      // Sample ten pixels inside the controls: the redesigned toolbar's left
      // side can legitimately contain amber unavailable-resource badges.
      await capture(`linux-connected-${focused ? 'active' : 'inactive'}`, `Linux connected: ${focused ? 'active' : 'inactive'}`, -128);
    }
    await native('focus');
    await expect(page.getByRole('status', { name: 'Plans unavailable' })).toBeVisible();
    await expect(page.getByRole('button', { name: '0 Plans' })).toHaveCount(0);
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    await expect.poll(async () => (await native()).bounds).toEqual(workArea);
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'false');
    assert.equal((await native()).bounds.width, resizedWidth);
    if (managerOpen) {
      await pointerClick('Connected: This computer');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
      await pointerClick('Close instance manager');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).not.toBeVisible();
      await pointerClick('Connected: This computer');
      await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
    }
    assert.equal(await page.getByRole('group', { name: 'Window controls' }).evaluate(element => !!element.closest('[inert]')), false);
    await pointerClick('Minimize window');
    await expect.poll(async () => (await native()).minimized).toBe(true);
    await native('restore');
    await expect(html).toHaveAttribute('data-window-focused', 'true');
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    await expect.poll(async () => (await native()).bounds).toEqual(workArea);
    await pointerClick('Minimize window');
    await expect.poll(async () => (await native()).minimized).toBe(true);
    await native('restore');
    await expect(html).toHaveAttribute('data-window-focused', 'true');
    await pointerClick('Maximize or restore window');
    await expect(html).toHaveAttribute('data-window-expanded', 'false');
    assert.equal((await native()).bounds.width, resizedWidth);
    if (managerOpen) await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
    // Keep keyboard coverage in addition to (never instead of) native clicks.
    const maximize = page.getByRole('button', { name: 'Maximize or restore window' });
    await maximize.focus();
    await page.keyboard.press('Enter');
    await expect(html).toHaveAttribute('data-window-expanded', 'true');
    if (managerOpen) await expect(page.getByRole('dialog', { name: 'Manage instances' })).toBeVisible();
    else {
      await pointerClick('Maximize or restore window');
      await expect(html).toHaveAttribute('data-window-expanded', 'false');
    }
    await pointerClick('Close window');
    await expect.poll(() => page.isClosed()).toBe(true);
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
};

for (const managerOpen of [false, true]) {
  it(`Linux frame supports native pointer controls on Dashboard${managerOpen ? ' with a modal' : ''}`,
    { timeout: 120_000 }, context => exerciseLinuxFrame(context, managerOpen));
}
