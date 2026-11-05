// Fixed, reviewed browser acceptance checkpoints for signed installed-RPM diagnostics.
// The packaged runner prints only these identifiers and a failure category chosen
// from a fixed allowlist; error messages, stacks, URLs, paths and child output never
// enter a marker. The host accepts a checkpoint only when it is allowlisted and
// strictly later than the previous one, so duplicated, stale or reordered records
// cannot replace the last meaningful checkpoint.
const STANDARD_STEPS = ['launched', 'prepared', 'captured', 'completed'];
const PAIRING_DECISION_STEPS = ['launched', 'approval-decided', 'verified'];

// Execution order of run-packaged-acceptance.mjs; keep in sync with its journeys.
export const BROWSER_ACCEPTANCE_JOURNEY_STEPS = Object.freeze([
  ['runner', ['started', 'fixtures-ready']],
  ['first-run-chooser', STANDARD_STEPS],
  ['manual-endpoint-confirmation', STANDARD_STEPS],
  ['connect-confirmation', STANDARD_STEPS],
  ['remote-pairing', STANDARD_STEPS],
  ['local-setup-prerequisites', STANDARD_STEPS],
  ['local-setup-progress', STANDARD_STEPS],
  ['local-setup-error', STANDARD_STEPS],
  ['local-setup-completion', STANDARD_STEPS],
  ['dashboard-profile-manager', ['launched', 'paired', 'connected', 'pairing-observed', 'socket-authenticated',
    'modal-focus-verified', 'trace-written', 'prepared', 'captured', 'completed']],
  ['offline', STANDARD_STEPS],
  ['revoked', STANDARD_STEPS],
  ['incompatible-instance', STANDARD_STEPS],
  ['csp-reload-startup', ['entered']],
  ['csp-reload-pairing', ['entered']],
  ['csp-reload-restart', ['entered']],
  ['csp-reload-deselection', ['entered']],
  ['csp-reload-saved-selection', ['entered']],
  ['csp-reload-removal', ['entered']],
  ['csp-reload', ['completed']],
  ['installed-approved', ['launched', 'paired', 'connected', 'socket-authenticated', 'verified']],
  ['installed-restart', ['launched', 'connected', 'socket-authenticated', 'logout-revoked']],
  ['installed-logged-out', ['launched', 'verified']],
  ['installed-reject', PAIRING_DECISION_STEPS],
  ['installed-reject-restart', ['launched', 'verified']],
  ['installed-expire', PAIRING_DECISION_STEPS],
  ['installed-expire-restart', ['launched', 'verified']],
  ['installed-wrong-account', PAIRING_DECISION_STEPS],
  ['installed-wrong-account-restart', ['launched', 'verified']],
  ['installed-pairing', ['evidence-written']],
  ['final-evidence', ['log-written', 'lifecycle-verified', 'boundary-verified', 'renderer-errors-verified',
    'accessibility-written', 'services-validated', 'summary-written', 'surfaces-scanned', 'manifest-written',
    'artifacts-verified']],
].map(([journey, steps]) => Object.freeze([journey, Object.freeze([...steps])])));

export const BROWSER_ACCEPTANCE_CHECKPOINTS = Object.freeze(BROWSER_ACCEPTANCE_JOURNEY_STEPS
  .flatMap(([journey, steps]) => steps.map(step => `${journey}/${step}`)));

export const BROWSER_ACCEPTANCE_FAILURE_CATEGORIES = Object.freeze([
  'ui-wait-timeout', 'renderer-closed', 'renderer-initialization', 'renderer-lifecycle-invalid', 'renderer-errors',
  'socket-handshake', 'dashboard-connected-timeout', 'service-observation-timeout', 'service-journeys-incomplete',
  'boundary-incomplete', 'csp-reload', 'pairing-assertion', 'keyboard-focus', 'accessibility', 'layout-capture',
  'trace-evidence', 'secret-scan', 'artifact-verification', 'application-cleanup', 'fixture-setup', 'unclassified',
]);

export const BROWSER_CHECKPOINT_MARKER = 'PROPR_RPM_BROWSER_CHECKPOINT=';
export const BROWSER_FAILURE_MARKER = 'PROPR_RPM_BROWSER_FAILURE=';

// Ordered prefix rules over the runner's own fixed error texts. Only the category
// leaves the process; the matched message itself is never printed.
const FAILURE_RULES = [
  ['socket-handshake', ['Acceptance Socket.IO handshake failed']],
  ['dashboard-connected-timeout', ['Acceptance dashboard Connected control timed out']],
  ['service-observation-timeout', ['Acceptance did not observe']],
  ['renderer-initialization', ['Packaged acceptance deterministic boundary initialization']],
  ['renderer-lifecycle-invalid', ['Acceptance renderer lifecycle evidence']],
  ['boundary-incomplete', ['Packaged main/preload/renderer boundary', 'Acceptance executable boundary']],
  ['renderer-errors', ['Packaged acceptance observed unexpected renderer errors', 'Acceptance console']],
  ['service-journeys-incomplete', ['Acceptance packaged-renderer service journeys', 'Acceptance claimed service journey',
    'Acceptance socket summary']],
  ['csp-reload', ['Connected account is missing its CSP', 'First activation must install the loopback policy',
    'CSP reload fixture', 'Account did not remain Connected']],
  ['pairing-assertion', ['Installed RPM', 'Logout credential survived', 'Failed approval authenticated',
    'Rejected or expired browser approval', 'Browser approval did not transition', 'Acceptance revocation',
    'Invalid fixture pairing']],
  ['keyboard-focus', ['Acceptance modal has insufficient focus', 'Pairing keyboard control', 'Approval keyboard focus',
    'Pairing control is not keyboard', 'Setup action']],
  ['accessibility', ['Packaged accessibility', 'axe-core', 'Acceptance accessibility']],
  ['layout-capture', ['Acceptance screenshot', 'Acceptance zoom-200', 'Acceptance deterministic renderer inputs',
    'Initial viewport', 'Production setup presentation', 'Production LocalSetupWizard', 'Unexpected setup evidence']],
  ['secret-scan', ['Secret sentinel found', 'Secret-shaped value found']],
  ['trace-evidence', ['Acceptance trace', 'Playwright trace']],
  ['artifact-verification', ['Acceptance manifest', 'Acceptance supporting', 'Acceptance artifact', 'Acceptance sanitized',
    'Duplicate acceptance', 'Unexpected acceptance screenshot', 'Acceptance scan input']],
  ['application-cleanup', ['Packaged acceptance cleanup failed', 'Acceptance cleanup', 'Acceptance singleton',
    'Acceptance child has not stopped', 'Unknown acceptance cleanup']],
  ['fixture-setup', ['Acceptance fixture origin changed', 'Packaged acceptance binary']],
];

export const classifyBrowserAcceptanceFailure = error => {
  if (error?.name === 'TimeoutError') return 'ui-wait-timeout';
  const message = typeof error?.message === 'string' ? error.message : '';
  for (const [category, prefixes] of FAILURE_RULES) {
    if (prefixes.some(prefix => message.startsWith(prefix))) return category;
  }
  // Playwright prefixes its own errors with the API call (for example "locator.click: ").
  if (/^[a-zA-Z.]+: Target (page, context or browser has been closed|closed)/.test(message)) return 'renderer-closed';
  return 'unclassified';
};

// Emits nothing unless the signed installed-RPM container opted in, and never an unlisted value.
export const createBrowserCheckpointReporter = ({
  enabled = process.env.PROPR_DESKTOP_INSTALLED_RPM_ACCEPTANCE === '1',
  write = line => process.stdout.write(line),
} = {}) => ({
  checkpoint: (journey, step) => {
    const id = `${journey}/${step}`;
    if (enabled && BROWSER_ACCEPTANCE_CHECKPOINTS.includes(id)) write(`${BROWSER_CHECKPOINT_MARKER}${id}\n`);
  },
  failure: error => {
    if (enabled) write(`${BROWSER_FAILURE_MARKER}${classifyBrowserAcceptanceFailure(error)}\n`);
  },
});

// Host-side tracker for complete marker lines read from the installed container.
export const createBrowserCheckpointTracker = () => {
  let index = -1, failure;
  return {
    reset: () => { index = -1; failure = undefined; },
    accept: line => {
      if (failure !== undefined) return;
      if (line.startsWith(BROWSER_CHECKPOINT_MARKER)) {
        const next = BROWSER_ACCEPTANCE_CHECKPOINTS.indexOf(line.slice(BROWSER_CHECKPOINT_MARKER.length));
        if (next > index) index = next;
      } else if (line.startsWith(BROWSER_FAILURE_MARKER)) {
        const category = line.slice(BROWSER_FAILURE_MARKER.length);
        if (BROWSER_ACCEPTANCE_FAILURE_CATEGORIES.includes(category)) failure = category;
      }
    },
    snapshot: () => {
      const result = {};
      if (index >= 0) {
        const [journey, step] = BROWSER_ACCEPTANCE_CHECKPOINTS[index].split('/');
        Object.assign(result, { browserJourney: journey, browserCheckpoint: step });
      }
      if (failure !== undefined) result.browserFailure = failure;
      return result;
    },
  };
};

export const isBrowserCheckpoint = (journey, step) => typeof journey === 'string' && typeof step === 'string'
  && BROWSER_ACCEPTANCE_CHECKPOINTS.includes(`${journey}/${step}`);
