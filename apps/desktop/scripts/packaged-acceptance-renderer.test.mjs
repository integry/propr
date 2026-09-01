import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { chromium } from 'playwright';
import { ACCEPTANCE_VARIANTS } from './acceptance-artifacts.mjs';
import { analyzeExistingElectronRenderer } from './packaged-acceptance-axe.mjs';
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
const installedChromium = () => [
  chromium.executablePath(),
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(candidate => existsSync(candidate));

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

  it('runs injected axe in the existing renderer for all five variants when new targets are unsupported', {
    timeout: 30_000,
    skip: process.platform !== 'linux' || process.arch !== 'x64' ? 'Linux x64 packaged acceptance boundary' : false,
  }, async () => {
    const executablePath = installedChromium();
    assert.ok(executablePath, 'A Chromium executable is required for the in-renderer axe boundary regression');
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(`<!doctype html>
        <html lang="en"><head><title>Acceptance boundary</title></head>
        <body><main><h1>Acceptance boundary</h1><div id="shadow-host"></div></main>
        <script>
          document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button></button>';
        </script></body></html>`);

      let newPageAttempts = 0;
      Object.defineProperty(context, 'newPage', {
        configurable: true,
        value: async () => {
          newPageAttempts += 1;
          throw new Error('Target.createTarget is unsupported');
        },
      });
      const session = await context.newCDPSession(page);
      let createTargetAttempts = 0;
      const cdp = {
        send: async (method, params) => {
          if (method === 'Target.createTarget') {
            createTargetAttempts += 1;
            throw new Error('Target.createTarget is unsupported');
          }
          return session.send(method, params);
        },
      };

      await assert.rejects(context.newPage(), /Target\.createTarget is unsupported/);
      await assert.rejects(cdp.send('Target.createTarget', { url: 'about:blank' }), /Target\.createTarget is unsupported/);

      const evaluateRenderer = page.evaluate.bind(page);
      await evaluateRenderer(() => {
        globalThis.__acceptanceAxeCleanup = { completed: 0, started: 0, callbackBased: 0 };
      });
      let injectionMode = 'success';
      page.evaluate = async (pageFunction, argument) => {
        const result = await evaluateRenderer(pageFunction, argument);
        if (typeof pageFunction === 'string') {
          await evaluateRenderer(mode => {
            if (mode === 'timeout') {
              globalThis.axe.cleanup = () => undefined;
              return;
            }
            if (mode === 'combined-failure') {
              globalThis.axe.run = async () => { throw new Error('specific axe execution failure'); };
              globalThis.axe.cleanup = (_resolve, reject) => {
                setTimeout(() => reject(new Error('asynchronous axe cleanup failure')), 25);
              };
              return;
            }
            const cleanupState = globalThis.__acceptanceAxeCleanup;
            const cleanup = globalThis.axe.cleanup.bind(globalThis.axe);
            globalThis.axe.cleanup = (resolve, reject) => {
              cleanupState.started += 1;
              if (typeof resolve === 'function' && typeof reject === 'function') {
                cleanupState.callbackBased += 1;
              }
              cleanup(
                value => setTimeout(() => {
                  cleanupState.completed += 1;
                  if (typeof resolve === 'function') resolve(value);
                }, 25),
                error => setTimeout(() => {
                  cleanupState.completed += 1;
                  if (typeof reject === 'function') reject(error);
                }, 25),
              );
            };
          }, injectionMode);
        }
        return result;
      };

      const checks = [];
      await forEachElectronRendererVariant(page, cdp, ACCEPTANCE_VARIANTS, async ({ variant }) => {
        const violations = await analyzeExistingElectronRenderer(page);
        const cleanupState = await evaluateRenderer(() => ({ ...globalThis.__acceptanceAxeCleanup }));
        checks.push({ variant, violations, cleanupState });
        assert.equal(cleanupState.started, checks.length);
        assert.equal(cleanupState.callbackBased, checks.length);
        assert.equal(cleanupState.completed, checks.length);
        assert.equal(await page.evaluate(() => typeof globalThis.axe), 'undefined');
      }, { settle: async () => undefined });

      assert.deepEqual(checks.map(check => check.variant), Object.keys(ACCEPTANCE_VARIANTS));
      assert.equal(checks.length, 5);
      for (const check of checks) {
        assert.ok(check.violations.some(violation => violation.id === 'button-name'
          && violation.impact === 'critical' && violation.nodes === 1));
      }
      injectionMode = 'timeout';
      await assert.rejects(
        analyzeExistingElectronRenderer(page),
        error => error?.message === 'Packaged accessibility axe-core cleanup failed'
          && /cleanup timed out after 5000ms/.test(error.cause?.message),
      );
      assert.equal(await evaluateRenderer(() => typeof globalThis.axe), 'object');
      await evaluateRenderer(() => Reflect.deleteProperty(globalThis, 'axe'));

      injectionMode = 'combined-failure';
      let combinedFailure;
      try {
        await analyzeExistingElectronRenderer(page);
      } catch (error) {
        combinedFailure = error;
      }
      assert.ok(combinedFailure instanceof AggregateError);
      assert.equal(combinedFailure.message, 'Packaged accessibility axe-core execution or result validation failed');
      assert.equal(combinedFailure.errors.length, 2);
      assert.match(combinedFailure.errors[0].message, /execution or result validation failed/);
      assert.match(combinedFailure.errors[1].message, /axe-core cleanup failed/);
      assert.match(combinedFailure.errors[1].cause?.message, /asynchronous axe cleanup failure/);
      assert.equal(await evaluateRenderer(() => typeof globalThis.axe), 'object');
      assert.equal(newPageAttempts, 1);
      assert.equal(createTargetAttempts, 1);
      assert.equal(page.isClosed(), false);
      await session.detach();
    } finally {
      await browser.close();
    }
  });
});
