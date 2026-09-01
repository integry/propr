import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { ACCEPTANCE_VARIANTS } from './acceptance-artifacts.mjs';
import {
  captureElectronRendererScreenshot,
  forEachElectronRendererVariant,
  waitForUsableElectronRenderer,
} from './packaged-acceptance-renderer.mjs';

const processFixture = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const browserFixture = context => Object.assign(new EventEmitter(), {
  contexts: () => [context],
  isConnected: () => true,
});

describe('packaged acceptance renderer discovery', () => {
  it('waits deterministically when CDP precedes the first Electron renderer page', async () => {
    const pages = [];
    const context = { pages: () => pages };
    const child = processFixture();
    const browser = browserFixture(context);
    let polls = 0;
    const page = {
      evaluate: async () => ({ rendererTargetUsable: true }),
      isClosed: () => false,
      url: () => 'propr-app://renderer/index.html',
    };

    const renderer = await waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1_000,
      sleep: async () => {
        polls += 1;
        pages.push(page);
      },
    });

    assert.equal(polls, 1);
    assert.deepEqual(renderer, { context, page });
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });

  it('rejects process exit while waiting and removes its listeners', async () => {
    const context = { pages: () => [] };
    const child = processFixture();
    const browser = browserFixture(context);
    await assert.rejects(waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1_000,
      sleep: async () => child.emit('close', 17, null),
    }), /exited.*17/);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });

  it('rejects a strictly bounded timeout when no renderer target appears', async () => {
    const context = { pages: () => [] };
    const child = processFixture();
    const browser = browserFixture(context);
    await assert.rejects(waitForUsableElectronRenderer(browser, child, {
      expectedUrlPrefix: 'propr-app://renderer',
      timeoutMs: 1,
      sleep: async () => new Promise(() => undefined),
    }), /within 1ms/);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(browser.listenerCount('disconnected'), 0);
  });
});

describe('packaged acceptance renderer variants', () => {
  it('configures and captures all five variants when Browser.getWindowForTarget is unavailable', async () => {
    let viewport;
    let metrics;
    let reducedMotion = false;
    const commands = [];
    const captures = [];
    const page = {
      emulateMedia: async media => { reducedMotion = media.reducedMotion === 'reduce'; },
      setViewportSize: async value => { viewport = { ...value }; },
      viewportSize: () => ({ ...viewport }),
      evaluate: async () => ({
        ...viewport,
        deviceScaleFactor: metrics.deviceScaleFactor,
        reducedMotion,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
        visualViewport: {
          width: viewport.width / metrics.zoom,
          height: viewport.height / metrics.zoom,
          scale: metrics.zoom,
        },
      }),
    };
    const cdp = {
      send: async (method, params) => {
        commands.push({ method, params });
        if (method === 'Browser.getWindowForTarget') throw new Error('Browser.getWindowForTarget is unavailable');
        if (method === 'Emulation.setDeviceMetricsOverride') {
          metrics = { deviceScaleFactor: params.deviceScaleFactor, zoom: metrics?.zoom || 1 };
          return {};
        }
        if (method === 'Emulation.setPageScaleFactor') {
          metrics.zoom = params.pageScaleFactor;
          return {};
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height },
            cssVisualViewport: {
              clientWidth: viewport.width / metrics.zoom,
              clientHeight: viewport.height / metrics.zoom,
              scale: metrics.zoom,
            },
          };
        }
        if (method === 'Page.captureScreenshot') {
          return { data: Buffer.from(`${viewport.width}x${viewport.height}@${metrics.deviceScaleFactor}/${metrics.zoom}/${reducedMotion}`).toString('base64') };
        }
        throw new Error(`Unexpected CDP command: ${method}`);
      },
    };

    await forEachElectronRendererVariant(page, cdp, ACCEPTANCE_VARIANTS, async ({ variant, config, metrics: actual }) => {
      captures.push({ variant, bytes: await captureElectronRendererScreenshot(cdp), actual });
      assert.deepEqual(actual.viewport, config.viewport);
      assert.equal(actual.deviceScaleFactor, config.deviceScaleFactor);
      assert.equal(actual.zoom, config.zoom);
      assert.equal(actual.reducedMotion, config.reducedMotion);
    }, { settle: async () => undefined });

    assert.deepEqual(captures.map(capture => capture.variant), Object.keys(ACCEPTANCE_VARIANTS));
    assert.equal(captures.length, 5);
    assert.equal(new Set(captures.map(capture => capture.bytes.toString())).size, 5);
    assert.equal(commands.some(command => command.method.startsWith('Browser.')), false);
    assert.equal(commands.filter(command => command.method === 'Emulation.setDeviceMetricsOverride').length, 5);
    assert.equal(commands.filter(command => command.method === 'Emulation.setPageScaleFactor').length, 5);
    assert.equal(commands.filter(command => command.method === 'Page.getLayoutMetrics').length, 5);
    assert.equal(commands.filter(command => command.method === 'Page.captureScreenshot').length, 5);
  });
});
