import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { INSTALLED_SOCKET_JOURNEYS } from './acceptance-artifacts.mjs';

const readSource = relativePath => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const runnerSource = readSource('./run-packaged-acceptance.mjs');
const artifactsSource = readSource('./acceptance-artifacts.mjs');
const socketProviderSource = readSource('../../../propr-ui/src/contexts/SocketProvider.tsx');

const sourceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const occurrences = (source, value) => source.split(value).length - 1;

// Bound each contract to its own top-level function, independent of startup statements.
const assertExactSocketCounts = (source, validatorSource = artifactsSource) => {
  const waitSource = sourceBetween(
    source,
    'const waitForAuthenticatedSocket = async journey => {',
    '\n};',
  );
  const summarySource = sourceBetween(
    source,
    'const observedServiceSummary = () => {',
    '\n};',
  );

  assert.match(waitSource, /mainAccepted\.length === 1 && fixtureAccepted\.length === 1/);
  assert.match(waitSource, /connected\.length === 1 && applicationSubscriptions\.length === 1/);
  assert.match(waitSource, /applicationEvents\.length === 1 && rendererObservedApplicationEvents\.length === 1/);
  assert.match(waitSource, /record\.event === QUEUE_STATS_SUBSCRIBE_EVENT && record\.authenticated/);
  assert.match(waitSource, /record\.event === QUEUE_STATS_UPDATE && record\.authenticated/);
  assert.match(source, /if \(subscriptions\.length > 1\) return 'duplicate-application-subscription';/);
  assert.match(source, /if \(applicationEvents\.length > 1\) return 'duplicate-application-event';/);
  assert.match(source, /return 'application-subscription-not-observed';/);
  assert.match(source, /return 'renderer-application-event-not-observed';/);
  assert.match(summarySource, /validateSocketServiceSummary\(services\.socketIo, installedRpm/);
  assert.match(summarySource, /cspSessions: CSP_SOCKET_JOURNEYS\.map\(socketSessionSummary\)/);
  assert.match(summarySource, /rendererObservedApplicationEvents\.length === 1/);
  const sessionSource = sourceBetween(validatorSource, 'const validateSocketSession =', '\n};');
  for (const predicate of [
    'socketIo.authenticatedConnections !== 1', 'socketIo.subscriptions !== 1',
    'socketIo.events !== 1', 'socketIo.records !== 3',
    'handshake.mainAttempts !== 1', 'handshake.fixtureAttempts !== 1',
    'handshake.rendererObservedApplicationEvent !== true',
  ]) {
    assert.ok(sessionSource.includes(predicate), `Missing count predicate: ${predicate}`);
  }
  assert.doesNotMatch(waitSource, /applicationEvents\.length >= 1/);
};

describe('packaged acceptance Socket.IO application synchronization', () => {
  it('uses the exact production subscription event and emits only from its one-shot handler', () => {
    assert.match(socketProviderSource, /socket\.emit\('subscribe:queue:stats'\)/);
    assert.match(runnerSource, /const QUEUE_STATS_SUBSCRIBE_EVENT = 'subscribe:queue:stats';/);

    const connectionCallback = sourceBetween(
      runnerSource,
      "io.on('connection', socket => {",
      '  server.listen(',
    );
    const connectionRecord = connectionCallback.indexOf(
      "socketRecords.push({ journey, mode, event: 'connection', authenticated });",
    );
    const subscriptionHandler = connectionCallback.indexOf(
      'socket.once(QUEUE_STATS_SUBSCRIBE_EVENT, () => {',
    );
    const subscriptionReceived = connectionCallback.indexOf(
      'recordApplicationSubscription();',
      subscriptionHandler,
    );
    const serverEmit = connectionCallback.indexOf(
      'socket.emit(QUEUE_STATS_UPDATE, {',
      subscriptionReceived,
    );
    const fixtureEventRecord = connectionCallback.indexOf(
      "direction: 'fixture-to-renderer',",
      serverEmit,
    );

    assert.ok(connectionRecord < subscriptionHandler);
    assert.ok(subscriptionHandler < subscriptionReceived);
    assert.ok(subscriptionReceived < serverEmit);
    assert.ok(serverEmit < fixtureEventRecord);
    assert.equal(occurrences(connectionCallback, 'socket.emit(QUEUE_STATS_UPDATE, {'), 1);
    assert.doesNotMatch(connectionCallback.slice(0, subscriptionHandler), /socket\.emit\(QUEUE_STATS_UPDATE/);
    assert.doesNotMatch(connectionCallback, /setTimeout|sleep\(/);
    assert.match(connectionCallback, /timestamp: FIXED_TIME/);
    assert.match(connectionCallback, /completed: 12, failed: 0, delayed: 0, total: 12/);
  });

  it('records a bounded duplicate subscription without producing another fixture event', () => {
    const connectionCallback = sourceBetween(
      runnerSource,
      "io.on('connection', socket => {",
      '  server.listen(',
    );

    assert.equal(
      occurrences(connectionCallback, 'socket.once(QUEUE_STATS_SUBSCRIBE_EVENT'),
      2,
    );
    assert.match(
      connectionCallback,
      /recordApplicationSubscription\(\);\s+socket\.once\(QUEUE_STATS_SUBSCRIBE_EVENT, recordApplicationSubscription\);\s+socket\.emit\(QUEUE_STATS_UPDATE/,
    );
    assert.equal(occurrences(connectionCallback, 'genuineApplicationSubscription: true'), 1);
    assert.equal(occurrences(connectionCallback, 'genuineApplicationEvent: true'), 1);
  });

  it('requires exact connection, subscription, emit, and renderer-observation counts', () => {
    assertExactSocketCounts(runnerSource);
  });

  it('keeps checking the summary when startup work precedes fixture creation', () => {
    const startupMarker = '\ntry {';
    assert.ok(runnerSource.includes(startupMarker));
    const withStartupWork = runnerSource.replace(
      startupMarker,
      '\ntry {\n  await prepareAcceptance();',
    );

    assertExactSocketCounts(withStartupWork);
    assert.throws(
      () => assertExactSocketCounts(withStartupWork, artifactsSource.replace(
        'socketIo.events !== 1', 'socketIo.events < 1',
      )),
      { code: 'ERR_ASSERTION' },
    );
  });

  it('rejects weakened exact counts in both the wait and final summary', () => {
    for (const predicate of [
      'mainAccepted.length === 1',
      'fixtureAccepted.length === 1',
      'connected.length === 1',
      'applicationSubscriptions.length === 1',
      'applicationEvents.length === 1',
      'rendererObservedApplicationEvents.length === 1',
      'socketIo.authenticatedConnections !== 1',
      'socketIo.subscriptions !== 1',
      'socketIo.events !== 1',
      'handshake.mainAttempts !== 1',
      'handshake.fixtureAttempts !== 1',
    ]) {
      const weakened = predicate.replace('=== 1', '>= 1').replace('!== 1', '< 1');
      const inRunner = runnerSource.includes(predicate);
      assert.ok(inRunner || artifactsSource.includes(predicate), `Missing count predicate: ${predicate}`);
      assert.throws(
        () => assertExactSocketCounts(
          inRunner ? runnerSource.replaceAll(predicate, weakened) : runnerSource,
          inRunner ? artifactsSource : artifactsSource.replaceAll(predicate, weakened),
        ),
        { code: 'ERR_ASSERTION' },
        `Must reject weakened count: ${predicate}`,
      );
    }
  });
});


it('installed positive phases wait for genuine renderer application events before closing', async () => {
  const waitSource = sourceBetween(runnerSource, 'const waitForAuthenticatedSocket = async journey => {', '\n};');
  const lifecycleSource = sourceBetween(runnerSource, 'const installedPairingLifecycle = async () => {', '\n};');
  const categorySource = sourceBetween(runnerSource, 'const socketHandshakeFailureCategory = journey => {', '\n};');
  assert.equal(occurrences(lifecycleSource, 'await waitForAuthenticatedSocket(activeJourney);'), 2);
  for (const journey of INSTALLED_SOCKET_JOURNEYS) {
    const context = {
      INSTALLED_SOCKET_JOURNEYS,
      QUEUE_STATS_SUBSCRIBE_EVENT: 'subscribe:queue:stats', QUEUE_STATS_UPDATE: 'queue:stats:update',
      mainHandshakeRecords: [{ journey, accepted: true }], fixtureHandshakeRecords: [{ journey, accepted: true }],
      socketRecords: [
        { journey, event: 'connection', authenticated: true },
        { journey, event: 'subscribe:queue:stats', authenticated: true,
          genuineApplicationSubscription: true, direction: 'client-to-fixture' },
      ],
      consoleRecords: [],
      rendererLifecycleCategory: () => assert.fail('Installed scenarios do not capture lifecycle diagnostics'),
      socketHandshakeFailureCategory: () => 'renderer-application-event-not-observed',
      currentUserPhaseSummary: () => ({}), rendererLifecycleDiagnosticSummary: () => ({}), networkPermissionSummary: () => ({}),
    };
    const actualCategory = runInNewContext(categorySource + '\n};\nsocketHandshakeFailureCategory', { ...context });
    context.socketHandshakeFailureCategory = actualCategory;
    assert.equal(actualCategory(journey), 'application-event-not-produced');
    assert.equal(actualCategory('installed-approved' === journey ? 'installed-restart' : 'installed-approved'), 'application-session-not-observed');
    let polls = 0;
    context.sleep = async () => {
      polls++;
      if (polls === 1) context.socketRecords.push({ journey, event: 'queue:stats:update', authenticated: true,
        genuineApplicationEvent: true, direction: 'fixture-to-renderer' });
      else context.consoleRecords.push({ journey, text: '[SocketContext] Received queue stats update: {}' });
    };
    const wait = () => runInNewContext(waitSource + '\n};\nwaitForAuthenticatedSocket(' + JSON.stringify(journey) + ')', { ...context });
    await wait();
    assert.equal(polls, 2, 'The produced event alone must not complete the wait');
    context.mainHandshakeRecords.push({ journey, accepted: false });
    context.mainHandshakeRecords.at(-1).rejectionCategory = 'rejected';
    await assert.rejects(wait, /main-rejected/);
    context.mainHandshakeRecords.pop();
    context.socketRecords.push({ journey, event: 'connection', authenticated: true });
    await assert.rejects(wait, /duplicate-authenticated-connection/);
  }
});
