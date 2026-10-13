// Parse only Chromium's exact connect-src diagnostics. URLs stay in memory;
// exported diagnostics reduce them to fixed request labels and booleans.
const cspDenial = text => {
  const policy = text.match(/^Connecting to '([^']+)' violates the following Content Security Policy directive: "connect-src 'self' https: wss:"\. The action has been blocked\.$/);
  const fetch = text.match(/^Fetch API cannot load (\S+)\. Refused to connect because it violates the document's Content Security Policy\.$/);
  return policy ? { url: policy[1], kind: 'csp-connect-policy' }
    : fetch ? { url: fetch[1], kind: 'csp-fetch-denied' } : undefined;
};

const fixtureRequest = (url, origin) => {
  if (!origin || !url?.startsWith(`${origin}/`)) return 'other';
  const path = url.slice(origin.length);
  if (/^\/api\/auth\/user\?proprDesktopScopeGeneration=[1-9]\d*$/.test(path)) return 'current-user';
  return path === '/api/auth/demo-mode' ? 'demo-mode' : 'other';
};

export const sanitizedCspReloadError = (record, origin) => {
  const text = record.text ?? '';
  // A different CSP directive is useful failure evidence, never an exemption.
  const diagnosticPolicy = text.match(/^Connecting to '([^']+)' violates the following Content Security Policy directive: /);
  const denial = cspDenial(text) ?? (diagnosticPolicy
    ? { url: diagnosticPolicy[1], kind: 'csp-other-policy' } : undefined);
  return {
    errorClass: denial?.kind ?? (/Content Security Policy/.test(record.text ?? '') ? 'csp-other'
      : /^(?:Uncaught )?TypeError\b/.test(record.text ?? '') ? 'type-error'
        : /^(?:Uncaught )?ReferenceError\b/.test(record.text ?? '') ? 'reference-error'
          : (record.text ?? '').startsWith('Failed to load resource:') ? 'network-resource' : 'other'),
    request: fixtureRequest(denial?.url, origin),
    ownedFixtureOrigin: Boolean(origin && denial?.url.startsWith(`${origin}/`)),
  };
};

export const sanitizedCspReloadRequestFailure = (record, origin) => ({
  request: fixtureRequest(record.url, origin),
  ownedFixtureOrigin: Boolean(origin && record.url?.startsWith(`${origin}/`)),
  failureClass: record.errorText === 'net::ERR_BLOCKED_BY_CSP' ? 'csp-blocked'
    : record.errorText === 'net::ERR_ABORTED' ? 'aborted'
      : record.errorText === 'net::ERR_FAILED' ? 'network-failed' : 'other',
});

// A converged activation can deny bootstrap requests in its old document.
// Require the owned scenario's actual GET/fetch request to fail with CSP in the
// same phase, at the exact URL. Removal or unrelated violations remain failures.
export const correlateExpectedCspReloadConsoleRecords = ({ records, origin, evidence, deniedRequests = [] }) => {
  if (!origin || evidence?.firstActivationReloads !== 1 || !evidence.firstActivationPolicyPresent
    || !evidence.restartPolicyPresent || !evidence.restartConnected || evidence.restartReloads > 1
    || evidence.savedSelectionReloads !== 0 || !evidence.savedSelectionPolicyPresent
    || !evidence.removalNarrowed) return [];
  const accepted = [];
  const counts = new Map();
  let generation;
  for (const record of records) {
    if (record.type !== 'error' || record.journey !== 'csp-reload-pairing') continue;
    const denial = cspDenial(record.text);
    const request = fixtureRequest(denial?.url, origin);
    if (request === 'other') continue;
    const matchingRequests = deniedRequests.filter(item => item.scenario === 'csp-reload'
      && item.journey === record.journey && item.failureJourney === record.journey
      && item.url === denial.url && item.method === 'GET' && item.resourceType === 'fetch'
      && item.mainFrame === true && Number.isSafeInteger(record.pageId) && record.pageId > 0
      && item.pageId === record.pageId
      && item.errorText === 'net::ERR_BLOCKED_BY_CSP');
    if (matchingRequests.length !== 1) return [];
    if (request === 'current-user') {
      const value = new URL(denial.url).searchParams.get('proprDesktopScopeGeneration');
      if (generation && generation !== value) return [];
      generation = value;
    }
    const key = `${request}:${denial.kind}`;
    const count = (counts.get(key) ?? 0) + 1;
    if (count > (denial.kind === 'csp-connect-policy' ? 2 : 1)) return [];
    counts.set(key, count);
    accepted.push(record);
  }
  return accepted;
};

// CSP can reject fetch before Chromium creates a Network request. Observe the
// native Audits violation and correlate it with a top-frame fetch invocation;
// console diagnostics alone never establish a denied request.
export const observeCspReloadRequestFailures = async ({ page, origin, pageId, journey, records }) => {
  const marker = '[propr-acceptance-csp-fetch]';
  const attempts = new Map();
  const session = await page.context().newCDPSession(page);
  const contexts = new Map();
  const scripts = new Map();
  const { frameTree } = await session.send('Page.getFrameTree');
  session.on('Runtime.executionContextCreated', ({ context }) => {
    // uniqueId survives numeric context-ID reuse across document replacements.
    contexts.set(context.id, { id: context.uniqueId,
      mainFrame: context.auxData?.isDefault === true && context.auxData.frameId === frameTree.frame.id });
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  session.on('Runtime.executionContextsCleared', () => contexts.clear());
  session.on('Debugger.scriptParsed', ({ scriptId, executionContextId }) => {
    // Retain the originating context for delayed old-document native issues.
    scripts.set(scriptId, contexts.get(executionContextId));
  });
  const attemptKey = (contextId, phase, url) => JSON.stringify([contextId, phase, url]);
  session.on('Runtime.consoleAPICalled', message => {
    const text = message.args?.[0]?.value;
    const context = contexts.get(message.executionContextId);
    if (message.type !== 'debug' || typeof text !== 'string' || !text.startsWith(marker)
      || !context?.id || !context.mainFrame) return;
    let attempt;
    try { attempt = JSON.parse(text.slice(marker.length)); } catch { return; }
    if (attempt?.method !== 'GET' || typeof attempt.url !== 'string'
      || fixtureRequest(attempt.url, origin) === 'other') return;
    const phase = journey();
    const key = attemptKey(context.id, phase, attempt.url);
    const previous = attempts.get(key);
    // Only a repeated fetch in this document and phase makes its URL ambiguous.
    for (const record of previous?.denials.values() ?? []) {
      record.mainFrame = false;
      record.method = 'unknown';
      record.resourceType = 'unknown';
    }
    attempts.set(key, { journey: phase, count: (previous?.count ?? 0) + 1,
      denials: new Map() });
  });
  session.on('Audits.issueAdded', ({ issue }) => {
    const denial = issue?.details?.contentSecurityPolicyIssueDetails;
    if (issue?.code !== 'ContentSecurityPolicyIssue' || denial?.isReportOnly !== false
      || denial.violatedDirective !== 'connect-src'
      || denial.contentSecurityPolicyViolationType !== 'kURLViolation'
      || fixtureRequest(denial.blockedURL, origin) === 'other') return;
    const failureJourney = journey();
    const context = scripts.get(denial.sourceCodeLocation?.scriptId);
    const attempt = context?.id && context.mainFrame
      ? attempts.get(attemptKey(context.id, failureJourney, denial.blockedURL)) : undefined;
    // The response header and meta policy produce identical Audits issues for
    // one fetch. Deduplicate only within that invocation and failure phase,
    // retaining distinct native details and every renderer console error.
    const key = JSON.stringify({ contextId: context?.id, failureJourney, denial });
    if (attempt?.denials.has(key)) return;
    const record = { scenario: 'csp-reload', pageId, mainFrame: attempt?.count === 1,
      journey: attempt?.journey, failureJourney, url: denial.blockedURL,
      method: attempt?.count === 1 ? 'GET' : 'unknown',
      resourceType: attempt?.count === 1 ? 'fetch' : 'unknown',
      errorText: 'net::ERR_BLOCKED_BY_CSP' };
    records.push(record);
    attempt?.denials.set(key, record);
  });
  await session.send('Runtime.enable');
  await session.send('Debugger.enable');
  await session.send('Audits.enable');
  const install = ({ marker, origin }) => {
    if (window !== window.top) return;
    const fetch = window.fetch;
    const debug = console.debug.bind(console);
    window.fetch = function (...args) {
      // Delegate the original arguments unchanged. Unknown inputs and methods
      // cannot supply evidence for the exemption.
      const input = args[0];
      const url = typeof input === 'string' ? input
        : input instanceof Request ? input.url : input instanceof URL ? input.href : undefined;
      const method = args[1]?.method ?? (input instanceof Request ? input.method : 'GET');
      if (method === 'GET' && typeof url === 'string' && url.startsWith(`${origin}/`)) {
        const path = url.slice(origin.length);
        if (path === '/api/auth/demo-mode' || /^\/api\/auth\/user\?proprDesktopScopeGeneration=[1-9]\d*$/.test(path)) {
          debug(`${marker}${JSON.stringify({ url, method })}`);
        }
      }
      return Reflect.apply(fetch, this, args);
    };
  };
  await page.addInitScript(install, { marker, origin });
  // The initial chooser document already exists when CDP attaches.
  await page.evaluate(install, { marker, origin });
};

/** Real preload IPC and document reloads; HTTP/browser approval remain owned fixtures. */
export const exercisePackagedCspReload = async ({ launch, pair, origin, observe, evidence,
  diagnostic = record => console.info('Packaged CSP reload diagnostics:', JSON.stringify(record)),
}) => {
  observe('startup');
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
    observe('pairing');
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
    observe('deselection');
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
