import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  BROWSER_ACCEPTANCE_CHECKPOINTS, BROWSER_ACCEPTANCE_FAILURE_CATEGORIES, BROWSER_ACCEPTANCE_JOURNEY_STEPS,
  BROWSER_CHECKPOINT_MARKER, BROWSER_FAILURE_MARKER, classifyBrowserAcceptanceFailure,
  createBrowserCheckpointReporter, createBrowserCheckpointTracker,
} from './packaged-acceptance-checkpoints.mjs';
import { ACCEPTANCE_JOURNEYS, CSP_SOCKET_JOURNEYS, INSTALLED_SOCKET_JOURNEYS } from './acceptance-artifacts.mjs';

const SECRET = 'sentinel-secret-7f3a9c';
const runner = readFileSync(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
const checkpoint = id => `${BROWSER_CHECKPOINT_MARKER}${id}`;

test('checkpoint identifiers are fixed, unique, bounded and follow the runner journey order', () => {
  assert.equal(new Set(BROWSER_ACCEPTANCE_CHECKPOINTS).size, BROWSER_ACCEPTANCE_CHECKPOINTS.length);
  for (const id of [...BROWSER_ACCEPTANCE_CHECKPOINTS, ...BROWSER_ACCEPTANCE_FAILURE_CATEGORIES]) {
    assert.match(id, /^[a-z0-9-]+(\/[a-z0-9-]+)?$/);
    assert.ok(`${BROWSER_CHECKPOINT_MARKER}${id}`.length <= 128);
  }
  const journeys = BROWSER_ACCEPTANCE_JOURNEY_STEPS.map(([journey]) => journey);
  const ordered = names => names.map(name => journeys.indexOf(name));
  for (const names of [ACCEPTANCE_JOURNEYS, CSP_SOCKET_JOURNEYS, INSTALLED_SOCKET_JOURNEYS]) {
    const indexes = ordered(names);
    assert.ok(indexes.every(index => index >= 0), `missing journey in ${names}`);
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  }
  assert.deepEqual([journeys[0], journeys.at(-1)], ['runner', 'final-evidence']);
});

test('every literal runner checkpoint is allowlisted and every allowlisted step is instrumented', () => {
  const literal = [...runner.matchAll(/browserProgress\.checkpoint\('([^']+)', '([^']+)'\)/g)];
  assert.ok(literal.length >= 20);
  for (const [, journey, step] of literal) assert.ok(BROWSER_ACCEPTANCE_CHECKPOINTS.includes(`${journey}/${step}`), `${journey}/${step}`);
  for (const [journey, steps] of BROWSER_ACCEPTANCE_JOURNEY_STEPS) {
    for (const step of steps) assert.match(runner, new RegExp(`browserProgress\\.checkpoint\\([^)]*'${step}'\\)`), `${journey}/${step}`);
  }
  // Failure reporting rethrows the original error and never prints it.
  assert.match(runner, /\} catch \(error\) \{\n[^\n]*\n  browserProgress\.failure\(error\);\n  throw error;\n\} finally \{/);
});

test('the reporter emits only allowlisted markers and only for the installed RPM container', () => {
  const lines = [];
  const reporter = createBrowserCheckpointReporter({ enabled: true, write: line => lines.push(line) });
  reporter.checkpoint('dashboard-profile-manager', 'socket-authenticated');
  reporter.checkpoint('dashboard-profile-manager', SECRET);
  reporter.checkpoint(`${SECRET}\nPROPR_RPM_BROWSER_CHECKPOINT=runner`, 'started');
  const error = new Error(`Acceptance Socket.IO handshake failed: ${SECRET} https://user:${SECRET}@example.test /home/acceptance`);
  error.stack = `${error.message}\n    at /tmp/${SECRET}`;
  reporter.failure(error);
  reporter.failure({ message: { toString: () => SECRET } });
  assert.deepEqual(lines, [
    `${BROWSER_CHECKPOINT_MARKER}dashboard-profile-manager/socket-authenticated\n`,
    `${BROWSER_FAILURE_MARKER}socket-handshake\n`,
    `${BROWSER_FAILURE_MARKER}unclassified\n`,
  ]);
  const disabled = [];
  const quiet = createBrowserCheckpointReporter({ enabled: false, write: line => disabled.push(line) });
  quiet.checkpoint('runner', 'started'); quiet.failure(error);
  assert.deepEqual(disabled, []);
});

test('known runner failures map to fixed categories without inspecting anything beyond a prefix', () => {
  const timeout = new Error(`locator.waitFor: Timeout 15000ms exceeded. ${SECRET}`);
  timeout.name = 'TimeoutError';
  for (const [error, category] of [
    [timeout, 'ui-wait-timeout'],
    [new Error(`Acceptance dashboard Connected control timed out: {"x":"${SECRET}"}`), 'dashboard-connected-timeout'],
    [new Error('Acceptance did not observe logout revocation'), 'service-observation-timeout'],
    [new Error('Installed RPM did not activate and authenticate the live renderer'), 'pairing-assertion'],
    [new Error('Connected account is missing its CSP policy'), 'csp-reload'],
    [new Error('Packaged acceptance observed unexpected renderer errors: {}'), 'renderer-errors'],
    [new Error(`Secret sentinel found in /tmp/${SECRET}`), 'secret-scan'],
    [new AggregateError([], 'Packaged acceptance cleanup failed'), 'application-cleanup'],
    [new Error('page.evaluate: Target page, context or browser has been closed'), 'renderer-closed'],
    [new Error(`unexpected ${SECRET}`), 'unclassified'],
    ['not an error', 'unclassified'],
    [undefined, 'unclassified'],
  ]) assert.equal(classifyBrowserAcceptanceFailure(error), category);
});

test('the host tracker keeps the latest monotonic checkpoint and the first allowlisted failure', () => {
  const tracker = createBrowserCheckpointTracker();
  assert.deepEqual(tracker.snapshot(), {});
  for (const line of [
    checkpoint('runner/started'),
    checkpoint('dashboard-profile-manager/paired'),
    checkpoint('runner/fixtures-ready'), // stale: earlier than the accepted checkpoint
    checkpoint('dashboard-profile-manager/paired'), // duplicate
    checkpoint(`dashboard-profile-manager/${SECRET}`),
    checkpoint('dashboard-profile-manager'),
    `${checkpoint('final-evidence/artifacts-verified')} ${SECRET}`,
    `x${checkpoint('final-evidence/artifacts-verified')}`,
    `${BROWSER_FAILURE_MARKER}${SECRET}`,
    `${BROWSER_FAILURE_MARKER}socket-handshake`,
    `${BROWSER_FAILURE_MARKER}unclassified`, // a second failure record cannot replace the first
    checkpoint('final-evidence/artifacts-verified'), // nothing after a failure is accepted
  ]) tracker.accept(line);
  assert.deepEqual(tracker.snapshot(), {
    browserJourney: 'dashboard-profile-manager', browserCheckpoint: 'paired', browserFailure: 'socket-handshake',
  });
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), {});
});
