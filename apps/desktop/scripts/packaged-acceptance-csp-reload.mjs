/** Real preload IPC and document reloads; HTTP/browser approval remain owned fixtures. */
export const exercisePackagedCspReload = async ({ launch, pair, origin, observe, evidence,
  diagnostic = record => console.info('Packaged CSP reload diagnostics:', JSON.stringify(record)),
}) => {
  let application = await launch();
  const name = 'CSP reload account';
  const policy = page => page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  const connected = page => page.getByRole('button', { name: `Connected: ${name}`, exact: true }).waitFor({ timeout: 15_000 });
  const countReloads = async page => {
    const session = await page.context().newCDPSession(page);
    let count = 0;
    const sequence = [];
    // Event types alone explain routing versus reloads without exposing URLs.
    const record = type => { if (sequence.length < 32) sequence.push(type); };
    // Playwright framenavigated also fires for the Desktop HashRouter. CDP
    // frameNavigated reports new documents; hash/history changes use the
    // separate navigatedWithinDocument event and must not spend reload budgets.
    const listener = ({ frame }) => {
      if (!frame.parentId) { count++; record('document'); }
    };
    const { frameTree } = await session.send('Page.getFrameTree');
    const routeListener = ({ frameId }) => {
      if (frameId === frameTree.frame.id) record('same-document');
    };
    session.on('Page.frameNavigated', listener);
    session.on('Page.navigatedWithinDocument', routeListener);
    await session.send('Page.enable');
    return { count: () => count, sequence: () => [...sequence], dispose: async () => {
      session.off('Page.frameNavigated', listener);
      session.off('Page.navigatedWithinDocument', routeListener);
      await session.detach();
    } };
  };
  // Connected alone can be a transient state before a queued native reload.
  // Observe a bounded window, requiring both connection and policy to remain
  // present. Diagnostics contain only booleans, counts and event types.
  const stableConnection = async (page, reloads, phase, baseline, maximumReloads, prepare = async () => {}) => {
    let state;
    try {
      await prepare();
      await connected(page);
      for (let sample = 0; sample <= 20; sample++) {
        // A permitted startup reload may briefly recreate the connected view.
        // Saved selection has no reload budget and must stay connected throughout.
        if (phase !== 'saved-selection' && sample > 0) await connected(page);
        state = {
          phase,
          policyPresent: Boolean((await policy(page))?.includes(origin)),
          reloadCount: reloads.count() - baseline,
          connected: await page.getByRole('button', { name: `Connected: ${name}`, exact: true }).isVisible(),
        };
        if (!state.policyPresent) throw new Error('Connected account is missing its CSP policy');
        if (state.reloadCount > maximumReloads) {
          throw new Error(phase === 'saved-selection'
            ? 'Saved-account selection entered a CSP reload loop'
            : phase === 'restart' ? 'Restart exceeded its single startup policy reload'
              : 'First activation exceeded its single policy reload');
        }
        if (!state.connected) throw new Error('Account did not remain Connected');
        if (sample < 20) await page.waitForTimeout(100);
      }
      if (phase === 'first-activation' && state.reloadCount !== 1) {
        throw new Error('First activation must install the loopback policy with exactly one native reload');
      }
      return state;
    } finally {
      diagnostic({ phase,
        policyPresent: await policy(page).then(value => Boolean(value?.includes(origin))).catch(() => false),
        reloadCount: reloads.count() - baseline,
        connected: await page.getByRole('button', { name: `Connected: ${name}`, exact: true }).isVisible().catch(() => false),
        ...(phase === 'first-activation' ? { navigationSequence: reloads.sequence() } : {}),
      });
    }
  };
  try {
    const initial = await countReloads(application.page);
    if ((await policy(application.page)).includes(origin)) throw new Error('CSP reload fixture started with a pinned origin');
    const activation = await stableConnection(application.page, initial, 'first-activation', 0, 1, async () => {
      await pair(application.page, origin, name);
      await application.page.waitForFunction(endpoint => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')?.includes(endpoint), origin, { timeout: 15_000 });
    });
    await initial.dispose();
    await application.close({ preserveProfile: true });
    observe('restart');
    application = await launch(application.userData);
    const restarted = await countReloads(application.page);
    // Restoring the active profile can replace the empty startup policy once.
    // It must converge before testing saved selection with a separate budget.
    const restart = await stableConnection(application.page, restarted, 'restart', 0, 1);
    // Deliberate native deselection and a new document put the saved account on
    // the chooser. Clicking it runs the production deselect/save/probe/activate sequence.
    await application.page.evaluate(() => window.proprDesktop.profiles.setActive(null));
    await application.page.reload();
    await application.page.getByRole('heading', { name: 'Choose an account', exact: true }).waitFor();
    const beforeSelection = restarted.count();
    observe('saved-selection');
    await application.page.locator('.desktop-profile-connect').filter({ hasText: name }).click();
    const selection = await stableConnection(application.page, restarted, 'saved-selection', beforeSelection, 0);
    observe('removal');
    // Scope-free profile removal goes through the same authenticated preload
    // and main-process handler as the profile manager.
    await application.page.evaluate(async () => {
      const current = await window.proprDesktop.profiles.list();
      await window.proprDesktop.profiles.remove(current.activeProfileId);
    }).catch(error => {
      // Electron can destroy the invocation context after the durable removal.
      if (!/Execution context was destroyed/.test(error.message)) throw error;
    });
    await application.page.waitForFunction(endpoint => {
      const content = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
      return content && !content.includes(endpoint);
    }, origin);
    await restarted.dispose();
    evidence({ firstActivationReloads: activation.reloadCount, firstActivationPolicyPresent: activation.policyPresent,
      firstActivationNavigationSequence: initial.sequence(), restartReloads: restart.reloadCount,
      restartPolicyPresent: restart.policyPresent, savedSelectionReloads: selection.reloadCount,
      savedSelectionPolicyPresent: selection.policyPresent, restartConnected: restart.connected, removalNarrowed: true,
      limitation: 'Owned HTTP/pairing fixture; does not provision Docker or complete external browser approval.' });
  } finally {
    await application.close();
  }
};
