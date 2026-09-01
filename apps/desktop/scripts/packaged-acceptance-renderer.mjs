const defaultSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
