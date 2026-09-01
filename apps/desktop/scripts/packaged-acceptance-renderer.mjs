const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const closeEnough = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) < 0.01;

const assertRendererMetrics = (actual, expected, description) => {
  if (!closeEnough(actual, expected)) {
    throw new Error(`Packaged Electron ${description} changed: expected ${expected}, received ${actual}`);
  }
};

const measureEffectiveVisibleCssSpan = (rawViewport, layoutViewport, scale, description) => {
  const effective = {
    width: layoutViewport.width / scale,
    height: layoutViewport.height / scale,
  };
  const reportsLayoutSpan = closeEnough(rawViewport?.width, layoutViewport.width)
    && closeEnough(rawViewport?.height, layoutViewport.height);
  const reportsEffectiveSpan = closeEnough(rawViewport?.width, effective.width)
    && closeEnough(rawViewport?.height, effective.height);
  if (!reportsLayoutSpan && !reportsEffectiveSpan) {
    throw new Error(
      `Packaged Electron ${description} changed: expected raw layout span ${layoutViewport.width}x${layoutViewport.height}`
      + ` or raw effective span ${effective.width}x${effective.height}, received ${rawViewport?.width}x${rawViewport?.height}`,
    );
  }

  const derived = reportsLayoutSpan
    ? { width: rawViewport.width / scale, height: rawViewport.height / scale }
    : { width: rawViewport.width, height: rawViewport.height };
  assertRendererMetrics(derived.width, effective.width, `${description} effective width`);
  assertRendererMetrics(derived.height, effective.height, `${description} effective height`);
  return derived;
};

/**
 * Configure the visible Electron renderer without relying on Browser-domain
 * commands on a target-scoped CDP session. Playwright owns the viewport/window
 * resize, while CDP Emulation owns the target's DPR and page scale.
 */
export const configureElectronRendererVariant = async (
  page,
  cdp,
  config,
  {
    colorScheme = 'light',
    settle = defaultSleep,
    settleMs = 75,
  } = {},
) => {
  const { viewport, deviceScaleFactor, zoom, reducedMotion } = config || {};
  if (!Number.isInteger(viewport?.width) || viewport.width <= 0
    || !Number.isInteger(viewport?.height) || viewport.height <= 0
    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0
    || !Number.isFinite(zoom) || zoom <= 0 || typeof reducedMotion !== 'boolean') {
    throw new Error('Packaged Electron renderer variant configuration is invalid');
  }

  await page.emulateMedia({
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    colorScheme,
  });
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
  });
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: zoom });
  await settle(settleMs);

  const playwrightViewport = page.viewportSize();
  const layout = await cdp.send('Page.getLayoutMetrics');
  const renderer = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    deviceScaleFactor: window.devicePixelRatio,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    visualViewport: window.visualViewport && {
      width: window.visualViewport.width,
      height: window.visualViewport.height,
      scale: window.visualViewport.scale,
    },
  }));

  assertRendererMetrics(playwrightViewport?.width, viewport.width, 'Playwright viewport width');
  assertRendererMetrics(playwrightViewport?.height, viewport.height, 'Playwright viewport height');
  assertRendererMetrics(layout?.cssLayoutViewport?.clientWidth, viewport.width, 'layout viewport width');
  assertRendererMetrics(layout?.cssLayoutViewport?.clientHeight, viewport.height, 'layout viewport height');
  assertRendererMetrics(layout?.cssVisualViewport?.scale, zoom, 'page scale');
  assertRendererMetrics(renderer?.width, viewport.width, 'renderer viewport width');
  assertRendererMetrics(renderer?.height, viewport.height, 'renderer viewport height');
  assertRendererMetrics(renderer?.deviceScaleFactor, deviceScaleFactor, 'device scale factor');
  assertRendererMetrics(renderer?.screenWidth, viewport.width, 'renderer screen width');
  assertRendererMetrics(renderer?.screenHeight, viewport.height, 'renderer screen height');
  assertRendererMetrics(renderer?.visualViewport?.scale, zoom, 'renderer page scale');
  const layoutViewport = {
    width: layout.cssLayoutViewport.clientWidth,
    height: layout.cssLayoutViewport.clientHeight,
  };
  const cdpVisualViewport = {
    width: layout.cssVisualViewport.clientWidth,
    height: layout.cssVisualViewport.clientHeight,
    scale: layout.cssVisualViewport.scale,
  };
  const rendererVisualViewport = {
    width: renderer.visualViewport.width,
    height: renderer.visualViewport.height,
    scale: renderer.visualViewport.scale,
  };
  const effectiveVisibleCssSpan = measureEffectiveVisibleCssSpan(
    cdpVisualViewport,
    layoutViewport,
    cdpVisualViewport.scale,
    'CDP visual viewport',
  );
  const rendererEffectiveVisibleCssSpan = measureEffectiveVisibleCssSpan(
    rendererVisualViewport,
    layoutViewport,
    rendererVisualViewport.scale,
    'renderer visual viewport',
  );
  assertRendererMetrics(rendererEffectiveVisibleCssSpan.width, effectiveVisibleCssSpan.width, 'effective visible CSS width');
  assertRendererMetrics(rendererEffectiveVisibleCssSpan.height, effectiveVisibleCssSpan.height, 'effective visible CSS height');
  if (renderer?.reducedMotion !== reducedMotion) {
    throw new Error(`Packaged Electron reduced-motion emulation changed: expected ${reducedMotion}, received ${renderer?.reducedMotion}`);
  }

  return {
    viewport: { width: renderer.width, height: renderer.height },
    layoutViewport,
    cdpVisualViewport,
    rendererVisualViewport,
    effectiveVisibleCssSpan,
    deviceScaleFactor: renderer.deviceScaleFactor,
    zoom: renderer.visualViewport.scale,
    reducedMotion: renderer.reducedMotion,
  };
};

export const forEachElectronRendererVariant = async (
  page,
  cdp,
  variants,
  capture,
  options,
) => {
  if (!variants || typeof variants !== 'object' || typeof capture !== 'function') {
    throw new Error('Packaged Electron renderer variant capture configuration is invalid');
  }
  for (const [variant, config] of Object.entries(variants)) {
    const metrics = await configureElectronRendererVariant(page, cdp, config, options);
    await capture({ variant, config, metrics });
  }
};

export const captureElectronRendererScreenshot = async cdp => {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof result?.data !== 'string' || result.data.length === 0) {
    throw new Error('Packaged Electron renderer screenshot capture returned invalid data');
  }
  return Buffer.from(result.data, 'base64');
};

const processExitError = (code, signal) => new Error(
  `Packaged Electron exited before its renderer target was usable (${code ?? signal ?? 'unknown'})`,
);

/**
 * CDP can become reachable before Electron publishes its renderer target.
 * Keep this wait bounded independently from later renderer initialization and
 * reject immediately if either side of the CDP connection goes away.
 */
export const waitForUsableElectronRenderer = async (
  browser,
  child,
  {
    expectedUrlPrefix,
    timeoutMs = 15_000,
    pollIntervalMs = 25,
    sleep = defaultSleep,
  } = {},
) => {
  if (!expectedUrlPrefix || timeoutMs < 0 || pollIntervalMs < 0) {
    throw new Error('Packaged Electron renderer wait configuration is invalid');
  }

  let resolveTermination;
  const termination = new Promise(resolve => { resolveTermination = resolve; });
  let terminated = false;
  let terminationError;
  const terminate = error => {
    if (terminated) return;
    terminated = true;
    terminationError = error;
    resolveTermination(error);
  };
  const onClose = (code, signal) => terminate(processExitError(code, signal));
  const onError = error => terminate(new Error('Packaged Electron failed before its renderer target was usable', { cause: error }));
  const onDisconnected = () => terminate(new Error('Packaged Electron CDP disconnected before its renderer target was usable'));

  child.once('close', onClose);
  child.once('error', onError);
  browser.once('disconnected', onDisconnected);
  const timeout = setTimeout(
    () => terminate(new Error(`Packaged Electron renderer target did not become usable within ${timeoutMs}ms`)),
    timeoutMs,
  );

  if (child.exitCode !== null || child.signalCode !== null) onClose(child.exitCode, child.signalCode);
  else if (!browser.isConnected()) onDisconnected();

  const bounded = async promise => {
    if (terminationError) throw terminationError;
    const result = await Promise.race([
      Promise.resolve(promise).then(
        value => ({ value }),
        error => ({ probeError: error }),
      ),
      termination.then(error => ({ terminationError: error })),
    ]);
    if (terminationError) throw terminationError;
    if (result.terminationError) throw result.terminationError;
    return result;
  };

  try {
    while (true) {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const pageUrl = page.url();
          if (page.isClosed() || (pageUrl !== expectedUrlPrefix && !pageUrl.startsWith(`${expectedUrlPrefix}/`))) continue;
          const probe = await bounded(page.evaluate(() => ({ rendererTargetUsable: true })));
          if (probe.probeError || probe.value?.rendererTargetUsable !== true || page.isClosed()) continue;
          return { context, page };
        }
      }
      await bounded(sleep(pollIntervalMs));
    }
  } finally {
    clearTimeout(timeout);
    child.off('close', onClose);
    child.off('error', onError);
    browser.off('disconnected', onDisconnected);
  }
};
