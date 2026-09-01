import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { ACCEPTANCE_VARIANTS } from './acceptance-artifacts.mjs';
import { analyzeExistingElectronRenderer } from './packaged-acceptance-axe.mjs';
import {
  captureElectronRendererScreenshot,
  configureElectronRendererVariant,
  forEachElectronRendererVariant,
  waitForUsableElectronRenderer,
} from './packaged-acceptance-renderer.mjs';

const processFixture = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
const browserFixture = context => Object.assign(new EventEmitter(), {
  contexts: () => [context],
  isConnected: () => true,
});
const REAL_CHROMIUM_BOUNDARY_ENVIRONMENT = 'PROPR_DESKTOP_REAL_CHROMIUM_BOUNDARY';
const REAL_CHROMIUM_BOUNDARY_OPT_IN = '1';
const realChromiumBoundaryEnabled = value => {
  if (value === undefined) return false;
  if (value !== REAL_CHROMIUM_BOUNDARY_OPT_IN) {
    throw new Error(`${REAL_CHROMIUM_BOUNDARY_ENVIRONMENT} must be unset or exactly "${REAL_CHROMIUM_BOUNDARY_OPT_IN}"`);
  }
  return true;
};
const runRealChromiumBoundary = realChromiumBoundaryEnabled(
  process.env[REAL_CHROMIUM_BOUNDARY_ENVIRONMENT],
);
const installedChromium = () => [
  chromium.executablePath(),
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find(candidate => existsSync(candidate));

const rendererVariantFixture = ({
  acknowledgement,
  appliedFactor,
  rendererSpan = 'effective',
  unstable = false,
} = {}) => {
  let viewport;
  let metrics;
  let reducedMotion = false;
  let measurement = 0;
  const commands = [];
  const dimensionsFor = span => {
    if (span === 'invalid') return { width: viewport.width - 17, height: viewport.height - 11 };
    if (unstable) measurement += 1;
    const adjustment = unstable ? measurement % 2 : 0;
    return { width: viewport.width / metrics.zoom + adjustment, height: viewport.height / metrics.zoom };
  };
  const page = {
    emulateMedia: async media => { reducedMotion = media.reducedMotion === 'reduce'; },
    setViewportSize: async value => { viewport = { ...value }; },
    viewportSize: () => ({ ...viewport }),
    evaluate: async (_fn, argument) => {
      if (typeof argument === 'number') {
        metrics.zoom = appliedFactor ?? argument;
        return acknowledgement ?? {
          requestedFactor: argument,
          resetFactor: 1,
          appliedFactor: metrics.zoom,
          mechanism: 'electron-web-frame',
        };
      }
      const dimensions = dimensionsFor(rendererSpan);
      return {
        ...dimensions,
        devicePixelRatio: metrics.deviceScaleFactor * metrics.zoom + (unstable ? measurement / 1_000 : 0),
        reducedMotion,
        visualViewport: { ...dimensions, scale: 1 },
      };
    },
  };
  const cdp = {
    send: async (method, params) => {
      commands.push({ method, params });
      if (method === 'Browser.getWindowForTarget') throw new Error('Browser.getWindowForTarget is unavailable');
      if (method === 'Emulation.setDeviceMetricsOverride') {
        metrics = { deviceScaleFactor: params.deviceScaleFactor, zoom: metrics?.zoom || 1 };
        return {};
      }
      if (method === 'Page.getLayoutMetrics') {
        const rawVisualViewport = dimensionsFor('effective');
        return {
          cssLayoutViewport: { clientWidth: rawVisualViewport.width, clientHeight: rawVisualViewport.height },
          cssVisualViewport: {
            clientWidth: rawVisualViewport.width,
            clientHeight: rawVisualViewport.height,
            scale: 1,
          },
        };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: Buffer.from(`${viewport.width}x${viewport.height}@${metrics.deviceScaleFactor}/${metrics.zoom}/${reducedMotion}`).toString('base64') };
      }
      throw new Error(`Unexpected CDP command: ${method}`);
    },
  };
  return { commands, cdp, page };
};

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
  it('fails closed unless the real Chromium boundary has its exact explicit opt-in', () => {
    assert.equal(realChromiumBoundaryEnabled(undefined), false);
    assert.equal(realChromiumBoundaryEnabled(REAL_CHROMIUM_BOUNDARY_OPT_IN), true);
    for (const malformed of ['', '0', 'true', ' 1', '1 ']) {
      assert.throws(
        () => realChromiumBoundaryEnabled(malformed),
        new RegExp(`${REAL_CHROMIUM_BOUNDARY_ENVIRONMENT} must be unset or exactly`),
      );
    }
  });

  it('configures and captures all five variants when Browser.getWindowForTarget is unavailable', async () => {
    const { commands, cdp, page } = rendererVariantFixture();
    const captures = [];

    await forEachElectronRendererVariant(page, cdp, ACCEPTANCE_VARIANTS, async ({ variant, config, metrics: actual }) => {
      captures.push({ variant, bytes: await captureElectronRendererScreenshot(cdp), actual });
      const effective = { width: config.viewport.width / config.zoom, height: config.viewport.height / config.zoom };
      assert.deepEqual(actual.requestedViewport, config.viewport);
      assert.deepEqual(actual.playwrightViewport, config.viewport);
      assert.deepEqual(actual.rendererViewport, effective);
      assert.deepEqual(actual.layoutViewport, effective);
      assert.deepEqual(actual.cdpVisualViewport, {
        width: config.viewport.width / config.zoom,
        height: config.viewport.height / config.zoom,
        scale: 1,
      });
      assert.deepEqual(actual.rendererVisualViewport, actual.cdpVisualViewport);
      assert.deepEqual(actual.effectiveVisibleCssSpan, effective);
      assert.deepEqual(actual.geometryZoom, { width: config.zoom, height: config.zoom });
      assert.equal(actual.requestedDeviceScaleFactor, config.deviceScaleFactor);
      assert.equal(actual.rendererDevicePixelRatio, config.deviceScaleFactor * config.zoom);
      assert.equal(actual.requestedZoomFactor, config.zoom);
      assert.equal(actual.appliedZoomFactor, config.zoom);
      assert.equal(actual.zoomResetFactor, 1);
      assert.equal(actual.zoomMechanism, 'electron-web-frame');
      assert.equal(actual.reducedMotion, config.reducedMotion);
    }, { settle: async () => undefined });

    assert.deepEqual(captures.map(capture => capture.variant), Object.keys(ACCEPTANCE_VARIANTS));
    assert.equal(captures.length, 5);
    assert.equal(new Set(captures.map(capture => capture.bytes.toString())).size, 5);
    assert.equal(commands.some(command => command.method.startsWith('Browser.')), false);
    assert.equal(commands.filter(command => command.method === 'Emulation.setDeviceMetricsOverride').length, 5);
    assert.equal(commands.filter(command => command.method === 'Emulation.setPageScaleFactor').length, 0);
    assert.equal(commands.filter(command => command.method === 'Page.getLayoutMetrics').length, 15);
    assert.equal(commands.filter(command => command.method === 'Page.captureScreenshot').length, 5);
  });

  it('proves packaged Electron zoom-200 from webFrame acknowledgement and independent renderer geometry', async () => {
    const { commands, cdp, page } = rendererVariantFixture();
    const config = ACCEPTANCE_VARIANTS['zoom-200'];

    const actual = await configureElectronRendererVariant(page, cdp, config, { settle: async () => undefined });

    assert.deepEqual(actual.requestedViewport, { width: 1280, height: 820 });
    assert.deepEqual(actual.rendererViewport, { width: 640, height: 410 });
    assert.deepEqual(actual.layoutViewport, { width: 640, height: 410 });
    assert.deepEqual(actual.cdpVisualViewport, { width: 640, height: 410, scale: 1 });
    assert.deepEqual(actual.rendererVisualViewport, { width: 640, height: 410, scale: 1 });
    assert.deepEqual(actual.effectiveVisibleCssSpan, { width: 640, height: 410 });
    assert.deepEqual(actual.geometryZoom, { width: 2, height: 2 });
    assert.equal(actual.rendererDevicePixelRatio, 2);
    assert.equal(actual.appliedZoomFactor, 2);
    assert.equal(actual.zoomMechanism, 'electron-web-frame');
    assert.equal(commands.some(command => command.method === 'Emulation.setPageScaleFactor'), false);
  });

  it('fails closed on a wrong or malformed Electron zoom acknowledgement', async () => {
    const unavailable = rendererVariantFixture();
    unavailable.page.evaluate = async () => { throw new Error('Packaged acceptance Electron zoom bridge is unavailable'); };
    await assert.rejects(
      configureElectronRendererVariant(unavailable.page, unavailable.cdp, ACCEPTANCE_VARIANTS.standard, { settle: async () => undefined }),
      /zoom bridge is unavailable/,
    );
    const wrong = rendererVariantFixture({ appliedFactor: 1 });
    await assert.rejects(
      configureElectronRendererVariant(wrong.page, wrong.cdp, ACCEPTANCE_VARIANTS['zoom-200'], { settle: async () => undefined }),
      /zoom bridge acknowledgement changed/,
    );
    const malformed = rendererVariantFixture({ acknowledgement: { appliedFactor: 2 } });
    await assert.rejects(
      configureElectronRendererVariant(malformed.page, malformed.cdp, ACCEPTANCE_VARIANTS['zoom-200'], { settle: async () => undefined }),
      /acknowledgement is malformed/,
    );
  });

  it('fails closed on renderer geometry mismatch and an unstable measurement timeout', async () => {
    const mismatch = rendererVariantFixture({ rendererSpan: 'invalid' });
    await assert.rejects(
      configureElectronRendererVariant(mismatch.page, mismatch.cdp, ACCEPTANCE_VARIANTS['zoom-200'], { settle: async () => undefined }),
      /renderer viewport width changed/,
    );
    const unstable = rendererVariantFixture({ unstable: true });
    await assert.rejects(
      configureElectronRendererVariant(unstable.page, unstable.cdp, ACCEPTANCE_VARIANTS['zoom-200'], {
        settle: async () => undefined, measurementTimeoutMs: 1,
      }),
      /did not stabilize within 1ms/,
    );
  });

  describe('real Chromium existing-target axe boundary', {
    skip: !runRealChromiumBoundary
      ? `Real Chromium is owned by the required predecessor (${REAL_CHROMIUM_BOUNDARY_ENVIRONMENT}=1)`
      : process.platform !== 'linux' || process.arch !== 'x64'
        ? 'Linux x64 packaged acceptance boundary'
        : false,
  }, () => {
    let browser;
    let cdp;
    let context;
    let createTargetAttempts = 0;
    let evaluateRenderer;
    let injectionMode = 'success';
    let newPageAttempts = 0;
    let page;
    let session;

    before(async () => {
      const executablePath = installedChromium();
      assert.ok(executablePath, 'A Chromium executable is required for the in-renderer axe boundary regression');
      browser = await chromium.launch({ executablePath, headless: true });
      context = await browser.newContext();
      page = await context.newPage();
      await page.setContent(`<!doctype html>
        <html lang="en"><head><title>Acceptance boundary</title></head>
        <body><main><h1>Acceptance boundary</h1><div id="shadow-host"></div></main>
        <script>
          document.querySelector('#shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<button></button>';
        </script></body></html>`);

      Object.defineProperty(context, 'newPage', {
        configurable: true,
        value: async () => {
          newPageAttempts += 1;
          throw new Error('Target.createTarget is unsupported');
        },
      });
      session = await context.newCDPSession(page);
      cdp = {
        send: async (method, params) => {
          if (method === 'Target.createTarget') {
            createTargetAttempts += 1;
            throw new Error('Target.createTarget is unsupported');
          }
          return session.send(method, params);
        },
      };

      evaluateRenderer = page.evaluate.bind(page);
      await evaluateRenderer(() => {
        globalThis.__acceptanceAxeCleanup = { completed: 0, started: 0, callbackBased: 0 };
      });
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
    }, { timeout: 30_000 });

    after(async () => {
      try {
        if (session) await session.detach();
      } finally {
        if (browser) await browser.close();
      }
    }, { timeout: 15_000 });

    it('proves five-variant axe success and reinjection without claiming stock Chromium proves Electron zoom', {
      timeout: 45_000,
    }, async () => {
      await assert.rejects(context.newPage(), /Target\.createTarget is unsupported/);
      await assert.rejects(cdp.send('Target.createTarget', { url: 'about:blank' }), /Target\.createTarget is unsupported/);

      const checks = [];
      assert.equal(await page.evaluate(() => typeof globalThis.__PROPR_PACKAGED_ACCEPTANCE__), 'undefined');
      for (const [variant, config] of Object.entries(ACCEPTANCE_VARIANTS)) {
        await page.setViewportSize(config.viewport);
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: config.viewport.width,
          height: config.viewport.height,
          deviceScaleFactor: config.deviceScaleFactor,
          mobile: false,
          screenWidth: config.viewport.width,
          screenHeight: config.viewport.height,
        });
        const violations = await analyzeExistingElectronRenderer(page);
        const cleanupState = await evaluateRenderer(() => ({ ...globalThis.__acceptanceAxeCleanup }));
        checks.push({ variant, violations, cleanupState });
        assert.equal(cleanupState.started, checks.length);
        assert.equal(cleanupState.callbackBased, checks.length);
        assert.equal(cleanupState.completed, checks.length);
        assert.equal(await page.evaluate(() => typeof globalThis.axe), 'undefined');
      }

      assert.deepEqual(checks.map(check => check.variant), Object.keys(ACCEPTANCE_VARIANTS));
      assert.equal(checks.length, 5);
      for (const check of checks) {
        assert.ok(check.violations.some(violation => violation.id === 'button-name'
          && violation.impact === 'critical' && violation.nodes === 1));
      }
      assert.equal(newPageAttempts, 1);
      assert.equal(createTargetAttempts, 1);
      assert.equal(page.isClosed(), false);
    });

    it('fails closed at the production axe cleanup timeout', {
      timeout: 10_000,
    }, async () => {
      injectionMode = 'timeout';
      await assert.rejects(
        analyzeExistingElectronRenderer(page),
        error => error?.message === 'Packaged accessibility axe-core cleanup failed'
          && /cleanup timed out after 5000ms/.test(error.cause?.message),
      );
      assert.equal(await evaluateRenderer(() => typeof globalThis.axe), 'object');
      await evaluateRenderer(() => Reflect.deleteProperty(globalThis, 'axe'));
      assert.equal(page.isClosed(), false);
    });

    it('preserves the primary axe error alongside asynchronous cleanup failure', {
      timeout: 10_000,
    }, async () => {
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
    });
  });
});
