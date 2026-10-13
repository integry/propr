/** Real preload IPC and document reloads; HTTP/browser approval remain owned fixtures. */
export const exercisePackagedCspReload = async ({ launch, pair, origin, observe, evidence }) => {
  let application = await launch();
  const name = 'CSP reload account';
  const policy = page => page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  const connected = page => page.getByRole('button', { name: `Connected: ${name}`, exact: true }).waitFor({ timeout: 15_000 });
  const countReloads = page => {
    let count = 0;
    const listener = frame => { if (frame === page.mainFrame()) count++; };
    page.on('framenavigated', listener);
    return { count: () => count, dispose: () => page.off('framenavigated', listener) };
  };
  try {
    const initial = countReloads(application.page);
    if ((await policy(application.page)).includes(origin)) throw new Error('CSP reload fixture started with a pinned origin');
    await pair(application.page, origin, name);
    await application.page.waitForFunction(endpoint => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')?.includes(endpoint), origin);
    await connected(application.page);
    if (initial.count() !== 1 || !(await policy(application.page)).includes(origin)) {
      throw new Error('First activation must install the loopback policy with exactly one native reload');
    }
    initial.dispose();
    await application.close({ preserveProfile: true });
    observe('restart');
    application = await launch(application.userData);
    const restarted = countReloads(application.page);
    await connected(application.page);
    if (!(await policy(application.page)).includes(origin) || restarted.count() !== 0) {
      throw new Error('Restart did not reconnect with its persisted account policy');
    }
    // Deliberate native deselection and a new document put the saved account on
    // the chooser. Clicking it runs the production deselect/save/probe/activate sequence.
    await application.page.evaluate(() => window.proprDesktop.profiles.setActive(null));
    await application.page.reload();
    await application.page.getByRole('heading', { name: 'Choose an account', exact: true }).waitFor();
    const beforeSelection = restarted.count();
    observe('saved-selection');
    await application.page.locator('.desktop-profile-connect').filter({ hasText: name }).click();
    await connected(application.page);
    if (restarted.count() !== beforeSelection) throw new Error('Saved-account selection entered a CSP reload loop');
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
    restarted.dispose();
    evidence({ firstActivationReloads: 1, savedSelectionReloads: 0, restartConnected: true, removalNarrowed: true,
      limitation: 'Owned HTTP/pairing fixture; does not provision Docker or complete external browser approval.' });
  } finally {
    await application.close();
  }
};
