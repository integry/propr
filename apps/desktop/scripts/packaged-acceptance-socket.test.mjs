import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const readSource = relativePath => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8',
);

const runnerSource = readSource('./run-packaged-acceptance.mjs');
const socketProviderSource = readSource('../../../propr-ui/src/contexts/SocketProvider.tsx');

const sourceBetween = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const occurrences = (source, value) => source.split(value).length - 1;

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
    const waitSource = sourceBetween(
      runnerSource,
      'const waitForAuthenticatedSocket = async journey => {',
      '\nconst observedServiceSummary = () => {',
    );
    const summarySource = sourceBetween(
      runnerSource,
      'const observedServiceSummary = () => {',
      '\ntry {\n  readyOrigin = await createFixture',
    );

    assert.match(waitSource, /connected\.length === 1 && applicationSubscriptions\.length === 1/);
    assert.match(waitSource, /applicationEvents\.length === 1 && rendererObservedApplicationEvents\.length === 1/);
    assert.match(waitSource, /record\.event === QUEUE_STATS_SUBSCRIBE_EVENT && record\.authenticated/);
    assert.match(waitSource, /record\.event === QUEUE_STATS_UPDATE && record\.authenticated/);
    assert.match(runnerSource, /if \(subscriptions\.length > 1\) return 'duplicate-application-subscription';/);
    assert.match(runnerSource, /if \(applicationEvents\.length > 1\) return 'duplicate-application-event';/);
    assert.match(runnerSource, /return 'application-subscription-not-observed';/);
    assert.match(runnerSource, /return 'renderer-application-event-not-observed';/);
    assert.match(summarySource, /socketSubscriptions\.length !== 1/);
    assert.match(summarySource, /services\.socketIo\.events !== 1/);
    assert.match(summarySource, /rendererObservedApplicationEvents\.length !== 1/);
    assert.doesNotMatch(waitSource, /applicationEvents\.length >= 1/);
  });
});

