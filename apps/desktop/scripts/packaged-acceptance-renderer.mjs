const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const closeEnough = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) < 0.01;
const ELECTRON_ZOOM_MECHANISM = 'electron-web-frame';
const MAX_VIEWPORT_INSET_CSS_PIXELS = 64;

const diagnosticSuffix = diagnostics => `; measurements=${JSON.stringify(diagnostics)}`;

const assertRendererMetrics = (actual, expected, description, diagnostics) => {
  if (!closeEnough(actual, expected)) {
    throw new Error(`Packaged Electron ${description} changed: expected ${expected}, received ${actual}${diagnosticSuffix(diagnostics)}`);
  }
};

const assertExactRendererMetric = (actual, expected, description, diagnostics) => {
  if (actual !== expected) {
    throw new Error(`Packaged Electron ${description} changed: expected exactly ${expected}, received ${actual}${diagnosticSuffix(diagnostics)}`);
  }
};

const assertExactKeys = (value, keys, description) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n')) {
    throw new Error(`Packaged Electron ${description} acknowledgement is malformed`);
  }
};

const measureRenderer = async (page, cdp) => {
  const [layout, renderer] = await Promise.all([
    cdp.send('Page.getLayoutMetrics'),
    page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      documentClientViewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      devicePixelRatio: window.devicePixelRatio,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      visualViewport: window.visualViewport && {
        width: window.visualViewport.width,
        height: window.visualViewport.height,
        scale: window.visualViewport.scale,
      },
    })),
  ]);
  return { layout, renderer };
};

const waitForStableRendererMeasurement = async (
  page,
  cdp,
  { settle, settleMs, measurementTimeoutMs, stableMeasurements },
) => {
  const deadline = Date.now() + measurementTimeoutMs;
  let previous;
  let stable = 0;
  let measurement;
  do {
    measurement = await measureRenderer(page, cdp);
    const serialized = JSON.stringify(measurement);
    stable = serialized === previous ? stable + 1 : 1;
    previous = serialized;
    if (stable >= stableMeasurements) return measurement;
    await settle(settleMs);
  } while (Date.now() <= deadline);
  throw new Error(`Packaged Electron renderer zoom metrics did not stabilize within ${measurementTimeoutMs}ms`);
};

/**
 * Configure the visible Electron renderer without relying on Browser-domain
 * commands on a target-scoped CDP session. Playwright owns the viewport/window
 * resize and target DPR. The authenticated context-isolated preload bridge is
 * the sole zoom authority; CDP page scale is intentionally not used.
 */
export const configureElectronRendererVariant = async (
  page,
  cdp,
  config,
  {
    colorScheme = 'light',
    settle = defaultSleep,
    settleMs = 25,
    measurementTimeoutMs = 3_000,
    stableMeasurements = 3,
  } = {},
) => {
  const { viewport, deviceScaleFactor, zoom, reducedMotion } = config || {};
  if (!Number.isInteger(viewport?.width) || viewport.width <= 0
    || !Number.isInteger(viewport?.height) || viewport.height <= 0
    || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0
    || (zoom !== 1 && zoom !== 2) || typeof reducedMotion !== 'boolean'
    || !Number.isInteger(measurementTimeoutMs) || measurementTimeoutMs <= 0
    || !Number.isInteger(stableMeasurements) || stableMeasurements < 2) {
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
  const zoomAcknowledgement = await page.evaluate(async requestedFactor => {
    const bridge = globalThis.__PROPR_PACKAGED_ACCEPTANCE__;
    if (!bridge || typeof bridge !== 'object' || typeof bridge.setZoomFactor !== 'function') {
      throw new Error('Packaged acceptance Electron zoom bridge is unavailable');
    }
    return bridge.setZoomFactor(requestedFactor);
  }, zoom);
  assertExactKeys(
    zoomAcknowledgement,
    ['requestedFactor', 'resetFactor', 'appliedFactor', 'mechanism'],
    'zoom bridge',
  );
  if (zoomAcknowledgement.requestedFactor !== zoom || zoomAcknowledgement.resetFactor !== 1
    || zoomAcknowledgement.appliedFactor !== zoom || zoomAcknowledgement.mechanism !== ELECTRON_ZOOM_MECHANISM) {
    throw new Error(`Packaged Electron zoom bridge acknowledgement changed: ${JSON.stringify(zoomAcknowledgement)}`);
  }

  const playwrightViewport = page.viewportSize();
  const { layout, renderer } = await waitForStableRendererMeasurement(page, cdp, {
    settle, settleMs, measurementTimeoutMs, stableMeasurements,
  });
  const effectiveVisibleCssSpan = {
    width: renderer?.width,
    height: renderer?.height,
  };
  const geometryZoom = {
    width: playwrightViewport?.width / effectiveVisibleCssSpan.width,
    height: playwrightViewport?.height / effectiveVisibleCssSpan.height,
  };
  const expectedEffective = {
    width: viewport.width / zoom,
    height: viewport.height / zoom,
  };
  const layoutViewport = {
    width: layout?.cssLayoutViewport?.clientWidth,
    height: layout?.cssLayoutViewport?.clientHeight,
  };
  const cdpVisualViewport = {
    width: layout?.cssVisualViewport?.clientWidth,
    height: layout?.cssVisualViewport?.clientHeight,
    scale: layout?.cssVisualViewport?.scale,
  };
  const rendererVisualViewport = {
    width: renderer?.visualViewport?.width,
    height: renderer?.visualViewport?.height,
    scale: renderer?.visualViewport?.scale,
  };
  const documentClientViewport = {
    width: renderer?.documentClientViewport?.width,
    height: renderer?.documentClientViewport?.height,
  };
  const scrollbarInsets = {
    width: renderer?.width - documentClientViewport.width,
    height: renderer?.height - documentClientViewport.height,
  };
  const visualViewportInsets = {
    width: renderer?.width - rendererVisualViewport.width,
    height: renderer?.height - rendererVisualViewport.height,
  };
  // Keep failure output limited to explicitly selected numeric geometry. This
  // makes a native CDP mismatch actionable without serializing page content.
  const measurementDiagnostics = {
    requestedViewport: viewport,
    playwrightViewport,
    rendererViewport: effectiveVisibleCssSpan,
    documentClientViewport,
    layoutViewport,
    cdpVisualViewport,
    rendererVisualViewport,
    scrollbarInsets,
    visualViewportInsets,
    geometryZoom,
  };

  assertExactRendererMetric(playwrightViewport?.width, viewport.width, 'Playwright viewport width', measurementDiagnostics);
  assertExactRendererMetric(playwrightViewport?.height, viewport.height, 'Playwright viewport height', measurementDiagnostics);
  assertExactRendererMetric(renderer?.width, expectedEffective.width, 'renderer viewport width', measurementDiagnostics);
  assertExactRendererMetric(renderer?.height, expectedEffective.height, 'renderer viewport height', measurementDiagnostics);
  assertRendererMetrics(renderer?.devicePixelRatio, deviceScaleFactor * zoom, 'renderer device pixel ratio', measurementDiagnostics);
  assertRendererMetrics(geometryZoom.width, zoom, 'measured renderer geometry width ratio', measurementDiagnostics);
  assertRendererMetrics(geometryZoom.height, zoom, 'measured renderer geometry height ratio', measurementDiagnostics);
  for (const [kind, insets] of Object.entries({ scrollbar: scrollbarInsets, 'visual viewport': visualViewportInsets })) {
    for (const [axis, inset] of Object.entries(insets)) {
      if (!Number.isFinite(inset) || inset < 0 || inset > MAX_VIEWPORT_INSET_CSS_PIXELS) {
        throw new Error(`Packaged Electron ${axis} ${kind} inset is invalid: expected 0-${MAX_VIEWPORT_INSET_CSS_PIXELS}, received ${inset}${diagnosticSuffix(measurementDiagnostics)}`);
      }
    }
  }
  assertExactRendererMetric(layoutViewport.width, documentClientViewport.width, 'layout viewport width versus document client width', measurementDiagnostics);
  assertExactRendererMetric(layoutViewport.height, documentClientViewport.height, 'layout viewport height versus document client height', measurementDiagnostics);
  assertExactRendererMetric(rendererVisualViewport.width, cdpVisualViewport.width, 'renderer visual viewport width versus raw CDP visual width', measurementDiagnostics);
  assertExactRendererMetric(rendererVisualViewport.height, cdpVisualViewport.height, 'renderer visual viewport height versus raw CDP visual height', measurementDiagnostics);
  assertExactRendererMetric(rendererVisualViewport.scale, cdpVisualViewport.scale, 'renderer visual viewport scale versus raw CDP visual scale', measurementDiagnostics);
  assertExactRendererMetric(rendererVisualViewport.scale, 1, 'raw renderer page scale', measurementDiagnostics);
  if (renderer?.reducedMotion !== reducedMotion) {
    throw new Error(`Packaged Electron reduced-motion emulation changed: expected ${reducedMotion}, received ${renderer?.reducedMotion}${diagnosticSuffix(measurementDiagnostics)}`);
  }

  return {
    requestedViewport: { ...viewport },
    playwrightViewport: { ...playwrightViewport },
    rendererViewport: { width: renderer.width, height: renderer.height },
    documentClientViewport,
    scrollbarInsets,
    visualViewportInsets,
    layoutViewport,
    cdpVisualViewport,
    rendererVisualViewport,
    effectiveVisibleCssSpan,
    geometryZoom,
    requestedDeviceScaleFactor: deviceScaleFactor,
    rendererDevicePixelRatio: renderer.devicePixelRatio,
    requestedZoomFactor: zoom,
    appliedZoomFactor: zoomAcknowledgement.appliedFactor,
    zoomResetFactor: zoomAcknowledgement.resetFactor,
    zoomMechanism: zoomAcknowledgement.mechanism,
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
