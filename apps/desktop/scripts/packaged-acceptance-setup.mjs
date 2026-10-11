export const SETUP_ACTIONS = Object.freeze({
  'local-setup-prerequisites': { continue: { label: 'Continue', heading: 'Private local storage', call: null } },
  'local-setup-progress': { cancel: { label: 'Cancel safely', heading: 'Setup needs attention', call: 'cancel' } },
  'local-setup-error': {
    back: { label: 'Back', heading: null, call: null },
    review: { label: 'Review saved choices', heading: 'Connect GitHub', call: null },
    replace: { label: 'Restart with aligned runtime', heading: 'Setting up ProPR', call: 'replace-running-stack' },
    retry: { label: 'Retry setup', heading: 'Setting up ProPR', call: 'retry' },
  },
  'local-setup-completion': { connect: { label: 'Connect securely', heading: null, call: null } },
});
export const setupPhase = journey => ({
  'local-setup-prerequisites': 'idle', 'local-setup-progress': 'running',
  'local-setup-error': 'failed', 'local-setup-completion': 'completed',
})[journey];

export const prepareProductionSetup = async (page, journey) => {
  await page.getByRole('button', { name: /Set up this computer/ }).click();
  if (journey === 'local-setup-progress') {
    for (const heading of ['Check the essentials', 'Private local storage', 'Connect GitHub', 'GitHub event intake', 'Select coding agents']) {
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Install ProPR', exact: true }).click();
  }
  await page.getByRole('heading', { name: {
    'local-setup-prerequisites': 'Check the essentials', 'local-setup-progress': 'Setting up ProPR',
    'local-setup-error': 'Setup needs attention', 'local-setup-completion': 'ProPR is ready',
  }[journey], exact: true }).waitFor();
  if (await page.locator('main.desktop-setup-wizard').count() !== 1) throw new Error('Production LocalSetupWizard is missing');
  if (journey === 'local-setup-completion') await page.locator('.desktop-setup-success').waitFor();
};

/** Tab drives browser focus and scrolling. No focus(), scrollIntoView(), or forced click. */
export const reachSetupAction = async (page, label) => {
  const action = page.getByRole('button', { name: label, exact: true });
  for (let tabs = 1; tabs <= 40; tabs += 1) {
    await page.keyboard.press('Tab');
    if (!await action.evaluate(element => element === document.activeElement)) continue;
    // Keyboard focus may scroll an overflowing production card. Wait for layout to settle.
    const geometry = await action.evaluate(element => {
      const r = element.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { focused: element === document.activeElement, visible: r.width > 0 && r.height > 0
        && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth
        && (hit === element || element.contains(hit)),
      focusVisible: element.matches(':focus-visible') };
    });
    if (!geometry.visible || !geometry.focusVisible) throw new Error(`Setup action is focused but clipped or obscured: ${label}`);
    return { tabs, ...geometry };
  }
  throw new Error(`Setup action is not keyboard reachable: ${label}`);
};

export const activateSetupAction = async (page, journey, actionId) => {
  const action = SETUP_ACTIONS[journey][actionId];
  await page.keyboard.press('Enter');
  if (action.heading) await page.getByRole('heading', { name: action.heading, exact: true }).waitFor();
  else if (actionId === 'back') await page.getByRole('button', { name: /Set up this computer/ }).waitFor();
  else await page.getByRole('button', { name: 'Sign in in browser', exact: true }).waitFor();
  const evidence = await page.evaluate(() => window.__PROPR_PACKAGED_ACCEPTANCE__.setupEvidence());
  const expectedCalls = [...(journey === 'local-setup-progress' ? ['start'] : []), ...(action.call ? [action.call] : [])];
  const expectedPhase = actionId === 'cancel' ? 'cancelled'
    : ['retry', 'replace'].includes(actionId) ? 'running' : setupPhase(journey);
  if (JSON.stringify(evidence.calls) !== JSON.stringify(expectedCalls) || evidence.phase !== expectedPhase) {
    throw new Error(`Setup action returned an unexpected bridge response: ${actionId}`);
  }
  return { activated: true, outcome: action.heading ?? (actionId === 'back' ? 'instance-chooser' : 'authentication-required'), bridgeCall: action.call };
};
