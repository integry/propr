import { SETUP_ACTIONS, setupPhase } from './packaged-acceptance-setup.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, lstat, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import {
  ACCEPTANCE_ARTIFACT_LEAF,
  ACCEPTANCE_PROFILE_PREFIX,
  removeOwnedAcceptanceProfileSingletons,
  ACCEPTANCE_JOURNEYS,
  CSP_SOCKET_JOURNEYS,
  INSTALLED_SOCKET_JOURNEYS,
  validateSocketServiceSummary,
  ACCEPTANCE_REDACTION_PLACEHOLDER,
  acceptanceVariantsFor,
  validateSetupEvidence,
  DETERMINISTIC_INPUTS,
  FIXED_TIME,
  expectedScreenshotNames,
  readPngDimensions,
  safeRemoveAcceptanceLeaf,
  sanitizeAcceptanceTrace,
  scanAcceptancePaths,
  scanRenderedScreenshot,
  screenshotName,
  validateAcceptanceEvidence,
  verifyAcceptanceArtifacts,
  writeAcceptanceManifest,
} from './acceptance-artifacts.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const zipFixture = (name, contents) => {
  const filename = Buffer.from(name);
  const data = Buffer.from(contents);
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28); filename.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, central, end]);
};
const readSingleZipEntry = bytes => {
  const method = bytes.readUInt16LE(8);
  const compressedSize = bytes.readUInt32LE(18);
  const nameLength = bytes.readUInt16LE(26);
  const data = bytes.subarray(30 + nameLength, 30 + nameLength + compressedSize);
  return method === 0 ? Buffer.from(data) : inflateRawSync(data);
};
const pngHeader = (width, height) => {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const viewportMetricEvidenceFor = config => {
  const rendererViewport = {
    width: config.viewport.width / config.zoom,
    height: config.viewport.height / config.zoom,
  };
  const scrollbarInsets = config.zoom === 2 ? { width: 8, height: 0 } : { width: 0, height: 0 };
  const visualViewportInsets = config.zoom === 2 ? { width: 7.5, height: 0 } : { width: 0, height: 0 };
  const documentClientViewport = {
    width: rendererViewport.width - scrollbarInsets.width,
    height: rendererViewport.height - scrollbarInsets.height,
  };
  const rendererVisualViewport = {
    width: rendererViewport.width - visualViewportInsets.width,
    height: rendererViewport.height - visualViewportInsets.height,
    scale: 1,
  };
  return {
    requestedViewport: { ...config.viewport },
    playwrightViewport: { ...config.viewport },
    rendererViewport,
    documentClientViewport,
    scrollbarInsets,
    visualViewportInsets,
    layoutViewport: { ...documentClientViewport },
    cdpVisualViewport: { ...rendererVisualViewport },
    rendererVisualViewport,
    effectiveVisibleCssSpan: { ...rendererViewport },
    geometryZoom: { width: config.zoom, height: config.zoom },
    requestedDeviceScaleFactor: config.deviceScaleFactor,
    rendererDevicePixelRatio: config.deviceScaleFactor * config.zoom,
    requestedZoomFactor: config.zoom,
    appliedZoomFactor: config.zoom,
    zoomResetFactor: 1,
    zoomMechanism: 'electron-web-frame',
    physicalPngDimensions: {
      width: config.viewport.width * config.deviceScaleFactor,
      height: config.viewport.height * config.deviceScaleFactor,
    },
  };
};

const accessibilityFor = () => ({
  schemaVersion: 7,
  generatedAt: FIXED_TIME,
  serious: 0,
  critical: 0,
  findings: [],
  checks: ACCEPTANCE_JOURNEYS.flatMap(journey => Object.entries(acceptanceVariantsFor(journey)).map(([variant, config]) => ({
    name: screenshotName(journey, variant), journey, variant, serious: 0, critical: 0, accessibleNames: true,
    locale: DETERMINISTIC_INPUTS.locale, timezone: DETERMINISTIC_INPUTS.timezone, fontLoaded: true,
    reducedMotion: config.reducedMotion, animationsDisabled: true, rendererTime: FIXED_TIME,
    ...viewportMetricEvidenceFor(config),
  }))),
  keyboardOrder: true,
  visibleFocus: true,
  modalFocusTrap: true,
  modalFocusRestore: true,
  accessibleNames: true,
  liveAnnouncements: {
    status: { journey: 'remote-pairing', beforeHash: '1'.repeat(64), afterHash: '2'.repeat(64), mutated: true },
    error: { journey: 'offline', beforeHash: '3'.repeat(64), afterHash: '4'.repeat(64), mutated: true },
  },
});

const summaryFor = (mode = 'packaged') => {
  const summary = {
    schemaVersion: 7,
    generatedAt: FIXED_TIME,
    status: 'passed',
    journeys: ACCEPTANCE_JOURNEYS.length,
    screenshots: expectedScreenshotNames().length,
    boundary: { packagedExecutable: true, rendererOrigin: 'propr-app://renderer', preloadBridge: true, journeys: ACCEPTANCE_JOURNEYS },
    console: {
      records: 3,
      errors: 0,
      expectedErrors: 0,
      unexpectedErrors: 0,
      errorCategoryCounts: {
        expectedCspPolicyTransition: 0,
        expectedRevokedAuthorizationResponse: 0,
        currentUserSync: 0,
        apiLoad: 0,
        socketContext: 0,
        reactRuntime: 0,
        networkResource: 0,
        other: 0,
        pageError: 0,
      },
    },
    services: {
      rest: {
        requestCount: 12,
        authenticatedRequestCount: 3,
        journeys: ['dashboard-profile-manager'],
        currentUserValidation: {
          correlation: 'current-scope-user-validation',
          rendererRequestIssued: true,
          rendererScopeGeneration: 1,
          mainProxyObserved: true,
          mainActiveScopeGeneration: 0,
          activeScopeAccepted: true,
          mainOnlyBearerInjection: true,
          upstreamRequestArrived: true,
          responseStatus: 200,
          responseClassification: 'success',
          parsedUserSchemaAccepted: true,
          rendererActiveScopeAccepted: true,
          firstFailedPredicate: 'none',
        },
      },
      socketIo: {
        records: 3,
        subscriptions: 1,
        authenticatedConnections: 1,
        events: 1,
        journeys: ['dashboard-profile-manager'],
        handshake: {
          mainAttempts: 1,
          fixtureAttempts: 1,
          scopeQueryPresent: true,
          scopeQueryCount: 1,
          scopeEqualsActivatedBinding: true,
          activeBindingPresent: true,
          profileGenerationCurrent: true,
          originEqualsActivatedBinding: true,
          path: 'socket-io',
          transport: 'websocket',
          resource: 'websocket',
          rendererBearerPresent: false,
          rendererCookiePresent: false,
          authorizationHeaderPresent: true,
          authorizationHeaderExactlyMainInjected: true,
          rendererObservedApplicationEvent: true,
          rendererLifecycle: {
            phase: 'socket-connect-invoked',
            profileActivationPublished: true,
            socketProviderMounted: true,
            providerDisabled: false,
            disabledByDemoModeLoading: false,
            disabledByDemoMode: false,
            disabledByCurrentUserLoading: false,
            disabledByCurrentUserAbsent: false,
            desktopRuntime: true,
            connectionScope: 'available',
            socketConstructionInvocations: 1,
            socketConstructions: 1,
            connectInvocations: 1,
          },
          rejectionCategory: 'none',
        },
      },
      pairing: { started: 1, polled: 1, activated: 1, journeys: ['dashboard-profile-manager'] },
      connect: { confirmedRequests: 1, journeys: ['connect-confirmation'] },
    },
    redaction: 'Full raw surfaces were scanned; published logs retain only source, level, byte count, and digest.',
  };
  summary.services.socketIo.cspSessions = CSP_SOCKET_JOURNEYS.map(journey => ({
    ...structuredClone(summary.services.socketIo), journeys: [journey],
    handshake: { ...structuredClone(summary.services.socketIo.handshake), rendererLifecycle: null },
  }));
  summary.services.socketIo.installedSessions = mode === 'installed-rpm'
    ? INSTALLED_SOCKET_JOURNEYS.map((journey, index) => ({
      ...structuredClone(summary.services.socketIo.cspSessions[index]), journeys: [journey],
    })) : [];
  summary.services.socketIo.mode = mode;
  summary.services.socketIo.unexpectedRecords = 0;
  return summary;
};

  for (const mode of ['packaged', 'installed-rpm']) {
  it(`validates actual runner service evidence through final ${mode} artifacts`, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'combined-session-contract-'));
    try {
      const evidence = await createCompleteArtifactSet(join(parent, ACCEPTANCE_ARTIFACT_LEAF), mode);
      // Execute the runner's actual gate without launching Electron or capturing UI.
      const source = await readFile(new URL('./run-packaged-acceptance.mjs', import.meta.url), 'utf8');
      const start = source.indexOf('const observedServiceSummary = () => {');
      const end = source.indexOf('\ntry {', start);
      assert.ok(start >= 0 && end > start);
      const journey = 'dashboard-profile-manager';
      const journeys = [journey, ...CSP_SOCKET_JOURNEYS, ...(mode === 'installed-rpm' ? INSTALLED_SOCKET_JOURNEYS : [])];
      const { rest, socketIo } = summaryFor().services;
      const handshake = socketIo.handshake;
      const socketRecords = journeys
        .flatMap(journey => [
          { journey, event: 'connection', authenticated: true },
          { journey, event: 'subscribe:queue:stats', authenticated: true,
            genuineApplicationSubscription: true, direction: 'client-to-fixture' },
          { journey, event: 'queue:stats:update', authenticated: true,
            genuineApplicationEvent: true, direction: 'fixture-to-renderer' },
        ]);
      const context = {
        socketRecords,
        CSP_SOCKET_JOURNEYS,
        INSTALLED_SOCKET_JOURNEYS,
        installedRpm: mode === 'installed-rpm',
        validateSocketServiceSummary: socket => {
          evidence.summary.services.socketIo = socket;
          validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, evidence.summary, evidence.sanitizedLog);
        },
        QUEUE_STATS_SUBSCRIBE_EVENT: 'subscribe:queue:stats',
        QUEUE_STATS_UPDATE: 'queue:stats:update',
        PAIRING_ID: 'fixture-pairing',
        unique: values => [...new Set(values)],
        requestRecords: [
          { journey, method: 'GET', url: '/api/auth/user', hasAuthorization: true },
          ...['', '/fixture-pairing/poll', '/fixture-pairing/activate'].map(suffix => ({
            journey, method: 'POST', url: '/api/desktop/pairings' + suffix,
          })),
          { journey: 'connect-confirmation', method: 'GET', url: '/api/desktop/discovery' },
        ],
        mainHandshakeRecords: journeys.map(journey => ({ ...handshake, journey, accepted: true,
          scopeEqualsActive: true, originEqualsActive: true, bearerMainInjected: true })),
        fixtureHandshakeRecords: journeys.map(journey => ({ journey, accepted: true, scopeQueryPresent: true,
          authorizationPresent: true, authorizationMatchesActivatedBearer: true })),
        consoleRecords: journeys.map(journey => ({ journey, text: '[SocketContext] Received queue stats update: {}' })),
        rendererLifecycleRecords: [{ journey, ...handshake.rendererLifecycle }],
        rendererCurrentUserRecords: ['request-issued', 'parsed-user-accepted', 'active-scope-accepted']
          .map(phase => ({ journey, phase, activeScopePresent: true, scopeGeneration: 1, schemaAccepted: true })),
        mainCurrentUserRecords: [{ journey, activeScopeGeneration: 1, accepted: true,
          rendererBearerPresent: false, rendererCookiePresent: false, bearerMainInjected: true }],
        fixtureCurrentUserRecords: [{ journey, source: 'renderer', requestArrived: true,
          responseStatus: 200, classification: 'success' }],
        currentUserValidationFailureCategory: () => rest.currentUserValidation.firstFailedPredicate,
        socketHandshakeFailureCategory: () => 'none',
      };
      const summary = () => runInNewContext(source.slice(start, end) + '\nobservedServiceSummary()', { ...context });
      const services = summary();
      assert.equal(services.socketIo.authenticatedConnections, 1);
      assert.equal(services.socketIo.events, 1);
      assert.deepEqual(Array.from(services.socketIo.journeys), [journey]);
      assert.equal(services.socketIo.handshake.mainAttempts, 1);
      assert.equal(services.socketIo.handshake.fixtureAttempts, 1);

      assert.equal(services.socketIo.cspSessions.length, 3);
      validateSocketServiceSummary(services.socketIo, mode);

      // Every expected journey requires one complete session, independently.
      for (const journey of journeys) {
        for (const event of ['connection', 'subscribe:queue:stats', 'queue:stats:update']) {
          const index = socketRecords.findIndex(record => record.journey === journey && record.event === event);
          const [record] = socketRecords.splice(index, 1);
          assert.throws(summary, /service journeys were incomplete/, `missing ${event}`);
          socketRecords.splice(index, 0, record, { ...record });
          assert.throws(summary, /service journeys were incomplete/, `duplicate ${event}`);
          socketRecords.splice(index + 1, 1);
          record.authenticated = false;
          assert.throws(summary, /service journeys were incomplete/, `unauthorized ${journey} ${event}`);
          record.authenticated = true;
        }
        for (const key of ['mainHandshakeRecords', 'fixtureHandshakeRecords', 'consoleRecords']) {
          const records = context[key];
          const index = records.findIndex(record => record.journey === journey);
          const [record] = records.splice(index, 1);
          assert.throws(summary, /service journeys were incomplete/, `missing ${journey} ${key}`);
          records.splice(index, 0, record, { ...record });
          assert.throws(summary, /service journeys were incomplete/, `duplicate ${journey} ${key}`);
          records.splice(index + 1, 1);
          if (key !== 'consoleRecords') {
            record.accepted = false;
            assert.throws(summary, /service journeys were incomplete/, `rejected ${journey} ${key}`);
            record.accepted = true;
          }
        }
      }
      // An extra unauthenticated record in an owned journey cannot be filtered out.
      for (const journey of journeys) {
        socketRecords.push({ journey, event: 'connection', authenticated: false });
        assert.throws(summary, /service journeys were incomplete/);
        socketRecords.pop();
        const main = context.mainHandshakeRecords.find(record => record.journey === journey);
        const fixture = context.fixtureHandshakeRecords.find(record => record.journey === journey);
        for (const [record, key, invalid] of [
          [main, 'scopeQueryCount', 2], [main, 'scopeEqualsActive', false],
          [main, 'activeBindingPresent', false], [main, 'profileGenerationCurrent', false],
          [main, 'originEqualsActive', false], [main, 'path', 'other'],
          [main, 'transport', 'other'], [main, 'resource', 'other'],
          [main, 'rendererBearerPresent', true], [main, 'rendererCookiePresent', true],
          [main, 'bearerMainInjected', false], [fixture, 'authorizationPresent', false],
          [fixture, 'authorizationMatchesActivatedBearer', false],
        ]) {
          const original = record[key];
          record[key] = invalid;
          assert.throws(summary, /service journeys were incomplete/, `${journey} ${key}`);
          record[key] = original;
        }
      }
      for (const key of ['socketRecords', 'mainHandshakeRecords', 'fixtureHandshakeRecords']) {
        for (const authenticated of [true, false]) {
          for (const unexpectedJourney of ['unknown-session', 'installed-unknown',
            ...installedJourneys.filter(value => !journeys.includes(value))]) {
            context[key].push({ ...context[key][0], journey: unexpectedJourney, authenticated, accepted: authenticated });
            assert.throws(summary, /service journeys were incomplete/, `${unexpectedJourney} ${key}`);
            context[key].pop();
          }
        }
      }
      for (const mutate of [
        socket => { socket.installedSessions = []; },
        socket => { socket.installedSessions.push(structuredClone(socket.cspSessions[0])); },
        socket => { socket.installedSessions = [socket.installedSessions[0], socket.installedSessions[0]]; },
        socket => { socket.installedSessions[0].handshake.rendererLifecycle = structuredClone(handshake.rendererLifecycle); },
      ]) {
        if (mode !== 'installed-rpm') continue;
        const services = summary();
        mutate(services.socketIo);
        evidence.summary.services.socketIo = services.socketIo;
        assert.throws(() => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, evidence.summary, evidence.sanitizedLog), /installed sessions disagree|not observed/);
      }
      // The final artifact gate ties session coverage to the schema-2 log mode.
      for (const mismatch of ['packaged', 'installed-rpm', 'unknown']) {
        if (mismatch === mode) continue;
        const services = summary();
        services.socketIo.mode = mismatch;
        evidence.summary.services.socketIo = services.socketIo;
        assert.throws(() => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, evidence.summary, evidence.sanitizedLog), /mode/);
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
}

it('requires exact dashboard and CSP session counts in the sanitized service summary', () => {
  const valid = summaryFor().services.socketIo;
  assert.doesNotThrow(() => validateSocketServiceSummary(valid));
  for (const index of [-1, 0, 1, 2]) {
    for (const field of ['records', 'authenticatedConnections', 'subscriptions', 'events']) {
      for (const delta of [-1, 1]) {
        const summary = structuredClone(valid);
        const session = index === -1 ? summary : summary.cspSessions[index];
        session[field] += delta;
        assert.throws(() => validateSocketServiceSummary(summary), /not observed/);
      }
    }
    const summary = structuredClone(valid);
    const session = index === -1 ? summary : summary.cspSessions[index];
    session.journeys = ['unknown-session'];
    assert.throws(() => validateSocketServiceSummary(summary), /not observed/);
    session.handshake.authorizationHeaderExactlyMainInjected = false;
    session.journeys = index === -1 ? ['dashboard-profile-manager'] : [CSP_SOCKET_JOURNEYS[index]];
    assert.throws(() => validateSocketServiceSummary(summary), /not observed/);
  }
  for (const mutate of [
    summary => summary.cspSessions.pop(),
    summary => summary.cspSessions.push(structuredClone(summary.cspSessions[0])),
    summary => { summary.cspSessions[1] = structuredClone(summary.cspSessions[0]); },
    summary => { summary.unexpectedRecords = 1; },
  ]) {
    const summary = structuredClone(valid);
    mutate(summary);
    assert.throws(() => validateSocketServiceSummary(summary), /not observed/);
  }
});

const sanitizedLogFor = (mode = 'packaged') => ({
  schemaVersion: 2,
  generatedAt: FIXED_TIME,
  mode,
  records: [
    ...Array.from({ length: 3 }, (_, index) => ({
      journey: 'first-run-chooser', source: 'renderer-console', level: 'info', bytes: index, sha256: '5'.repeat(64),
    })),
    ...[...ACCEPTANCE_JOURNEYS, 'csp-reload-pairing', 'csp-reload-removal'].map(journey => ({
      journey, source: 'packaged-process', level: 'combined', bytes: 0, sha256: '6'.repeat(64),
    })),
    ...(mode === 'installed-rpm' ? installedJourneys.flatMap(journey => [
      { journey, source: 'renderer-console', level: 'info', bytes: 12, sha256: '5'.repeat(64) },
      { journey, source: 'packaged-process', level: 'combined', bytes: 24, sha256: '6'.repeat(64) },
    ]) : []),
  ],
});

const setupEvidenceFor = (journey, variant) => {
  if (!SETUP_ACTIONS[journey]) return null;
  const id = variant.startsWith('zoom-200-') ? variant.slice('zoom-200-'.length) : null;
  const action = SETUP_ACTIONS[journey][id];
  return { presentation: 'LocalSetupWizard', fixture: 'preload-setup-v1', phase: setupPhase(journey),
    capture: id ? 'keyboard-reached' : 'initial-viewport',
    action: id ? { id, label: action.label, tabs: 3, focused: true, visible: true, focusVisible: true, activated: true,
      outcome: action.heading ?? (id === 'back' ? 'instance-chooser' : 'authentication-required'), bridgeCall: action.call } : null };
};

it('rejects substituted setup presentation and presence-only action evidence', () => {
  const journey = 'local-setup-completion', variant = 'zoom-200-connect';
  const valid = setupEvidenceFor(journey, variant);
  validateSetupEvidence(valid, journey, variant);
  for (const presentation of ['PackagedAcceptanceLocalSetup', 'hand-built-success']) {
    assert.throws(() => validateSetupEvidence({ ...valid, presentation }, journey, variant), /presentation/);
  }
  for (const field of ['focused', 'visible', 'focusVisible', 'activated']) {
    assert.throws(() => validateSetupEvidence({ ...valid, action: { ...valid.action, [field]: false } }, journey, variant), /activation/);
  }
  assert.throws(() => validateSetupEvidence({ ...valid, capture: 'initial-viewport' }, journey, variant), /presentation/);
  assert.throws(() => validateSetupEvidence({ ...valid, phase: 'idle' }, journey, variant), /fixture/);
});

const installedJourneys = [
  'installed-approved', 'installed-restart', 'installed-logged-out',
  'installed-reject', 'installed-reject-restart',
  'installed-expire', 'installed-expire-restart',
  'installed-wrong-account', 'installed-wrong-account-restart',
];

const createCompleteArtifactSet = async (root, mode = 'packaged') => {
  await mkdir(join(root, 'screenshots'), { recursive: true });
  const metadata = [];
  for (const journey of ACCEPTANCE_JOURNEYS) {
    for (const [variant, config] of Object.entries(acceptanceVariantsFor(journey))) {
      const name = screenshotName(journey, variant);
      const bytes = Buffer.concat([
        pngHeader(config.viewport.width * config.deviceScaleFactor, config.viewport.height * config.deviceScaleFactor),
        Buffer.from(`${journey}:${variant}`),
      ]);
      await writeFile(join(root, 'screenshots', name), bytes);
      metadata.push({
        name, journey, variant,
        setup: setupEvidenceFor(journey, variant),
        width: config.viewport.width * config.deviceScaleFactor,
        height: config.viewport.height * config.deviceScaleFactor,
        reducedMotion: config.reducedMotion,
        ...viewportMetricEvidenceFor(config),
        locale: DETERMINISTIC_INPUTS.locale,
        timezone: DETERMINISTIC_INPUTS.timezone,
        font: DETERMINISTIC_INPUTS.font,
        colorScheme: DETERMINISTIC_INPUTS.colorScheme,
        rendererTime: FIXED_TIME,
        originPolicy: DETERMINISTIC_INPUTS.originPolicy,
        visibleData: DETERMINISTIC_INPUTS.visibleData,
        animations: DETERMINISTIC_INPUTS.animations,
        repeatabilitySha256: sha256(bytes),
      });
    }
  }
  const accessibility = accessibilityFor();
  const summary = summaryFor(mode);
  const sanitizedLog = sanitizedLogFor(mode);
  summary.console.records = sanitizedLog.records.filter(record => record.source !== 'packaged-process').length;
  await writeFile(join(root, 'accessibility.json'), `${JSON.stringify(accessibility)}\n`);
  await writeFile(join(root, 'sanitized-summary.json'), `${JSON.stringify(summary)}\n`);
  await writeFile(join(root, 'sanitized-log.json'), `${JSON.stringify(sanitizedLog)}\n`);
  await writeFile(join(root, 'sanitized-trace.zip'), zipFixture('trace-entry.txt', 'sanitized trace'));
  const manifest = await writeAcceptanceManifest(root, metadata);
  return { accessibility, manifest, summary, sanitizedLog };
};

describe('packaged acceptance artifact contract', () => {
  it('verifies installed-mode artifacts and strictly accounts for every lifecycle phase', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'acceptance-installed-contract-'));
    const root = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
    try {
      const evidence = await createCompleteArtifactSet(root, 'installed-rpm');
      const validate = log => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, evidence.summary, log);
      assert.doesNotThrow(() => validate(evidence.sanitizedLog));
      await verifyAcceptanceArtifacts(root, { ocr: async () => '' });

      for (const journey of installedJourneys) {
        const processRecord = evidence.sanitizedLog.records.find(record => record.journey === journey && record.source === 'packaged-process');
        assert.throws(() => validate({ ...evidence.sanitizedLog,
          records: evidence.sanitizedLog.records.filter(record => record !== processRecord),
        }), /process log coverage/);
        assert.throws(() => validate({ ...evidence.sanitizedLog,
          records: [...evidence.sanitizedLog.records, processRecord],
        }), /process log coverage/);
        const rendererRecord = evidence.sanitizedLog.records.find(record => record.journey === journey && record.source === 'renderer-console');
        assert.throws(() => validate({ ...evidence.sanitizedLog,
          records: evidence.sanitizedLog.records.filter(record => record !== rendererRecord),
        }), /log and summary counts disagree/);
        for (const source of ['renderer-console', 'renderer-page-error']) {
          assert.throws(() => validate({ ...evidence.sanitizedLog,
            records: evidence.sanitizedLog.records.map(record => record === rendererRecord ? { ...record, source, level: 'error' } : record),
          }), /log and summary counts disagree/);
        }
      }
      const unknownPhase = structuredClone(evidence.sanitizedLog);
      unknownPhase.records.at(-1).journey = 'installed-unknown';
      assert.throws(() => validate(unknownPhase), /log record is invalid/);
      const reordered = structuredClone(evidence.sanitizedLog);
      reordered.records.reverse();
      assert.throws(() => validate(reordered), /process log coverage/);
      assert.throws(() => validate({ ...evidence.sanitizedLog, mode: 'packaged' }), /log record is invalid/);
      for (const mode of ['unknown', 'toString', null, ['installed-rpm']]) {
        assert.throws(() => validate({ ...evidence.sanitizedLog, mode }), /sanitized log is invalid/);
      }
      assert.throws(() => validate({ ...sanitizedLogFor(), mode: 'installed-rpm' }), /process log coverage/);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('has exactly 67 deterministic unique names and physical dimensions', () => {
    const names = ACCEPTANCE_JOURNEYS.flatMap(journey => Object.entries(acceptanceVariantsFor(journey)).map(([variant, config]) => {
      assert.deepEqual(readPngDimensions(pngHeader(config.viewport.width * config.deviceScaleFactor, config.viewport.height * config.deviceScaleFactor)), {
        width: config.viewport.width * config.deviceScaleFactor,
        height: config.viewport.height * config.deviceScaleFactor,
      });
      return screenshotName(journey, variant);
    }));
    assert.equal(names.length, 67);
    assert.deepEqual(names, expectedScreenshotNames());
    assert.equal(new Set(names).size, 67);
    assert.ok(names.every(name => /^[a-z0-9-]+--[a-z0-9-]+\.png$/.test(name)));
  });

  it('writes and verifies the complete strict 67-entry manifest and supporting set', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-full-'));
    const root = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
    try {
      const evidence = await createCompleteArtifactSet(root);
      assert.equal(evidence.manifest.screenshots.length, 67);
      assert.equal(evidence.manifest.schemaVersion, 7);
      assert.equal(evidence.accessibility.schemaVersion, 7);
      const zoomEvidence = evidence.manifest.screenshots.find(entry => entry.variant === 'zoom-200');
      assert.deepEqual(zoomEvidence.rendererViewport, { width: 640, height: 410 });
      assert.deepEqual(zoomEvidence.documentClientViewport, { width: 632, height: 410 });
      assert.deepEqual(zoomEvidence.layoutViewport, { width: 632, height: 410 });
      assert.deepEqual(zoomEvidence.rendererVisualViewport, { width: 632.5, height: 410, scale: 1 });
      assert.deepEqual(zoomEvidence.cdpVisualViewport, { width: 632.5, height: 410, scale: 1 });
      assert.deepEqual(zoomEvidence.scrollbarInsets, { width: 8, height: 0 });
      assert.deepEqual(zoomEvidence.visualViewportInsets, { width: 7.5, height: 0 });
      assert.deepEqual(evidence.manifest.screenshots.map(entry => entry.name), expectedScreenshotNames());
      assert.ok(evidence.manifest.screenshots.every(entry => entry.bytes > 24 && entry.sha256 === entry.repeatabilitySha256));
      assert.deepEqual(evidence.manifest.supporting.map(entry => entry.name), [
        'accessibility.json', 'sanitized-summary.json', 'sanitized-log.json', 'sanitized-trace.zip',
      ]);
      assert.doesNotThrow(() => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, evidence.summary, evidence.sanitizedLog));
      const verified = await verifyAcceptanceArtifacts(root, { ocr: async () => '' });
      assert.deepEqual(verified, JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('scans full persisted surfaces and OCR-recognized rendered pixels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-scan-'));
    try {
      await mkdir(join(root, 'storage'));
      await writeFile(join(root, 'storage', 'safe.json'), '{"status":"ready"}');
      await scanAcceptancePaths([root], ['acceptance-exact-sentinel']);
      await assert.rejects(
        scanRenderedScreenshot(Buffer.from('not-used-by-mock'), 'screenshot.png', ['acceptance-exact-sentinel'], async () => 'acceptance-exact-sentinel'),
        /rendered pixels/,
      );
      await writeFile(join(root, 'storage', 'unsafe.log'), 'acceptance-exact-sentinel');
      await assert.rejects(scanAcceptancePaths([root], ['acceptance-exact-sentinel']), /Secret sentinel/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps generic matching within printable binary runs and exact sentinel scanning raw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-binary-scan-'));
    const database = join(root, 'key4.db');
    const binaryAssignmentBridge = Buffer.concat([
      Buffer.from('SQLite format 3\0NSS metadata password=', 'ascii'),
      Buffer.from([0x00, 0x80, 0xff, 0x01]),
      Buffer.from('binary-record-body', 'ascii'),
      Buffer.from([0x00, 0x02]),
    ]);
    try {
      assert.match(binaryAssignmentBridge.toString('utf8'), /password\s*[=:]\s*[^\s"']{8,}/i);
      await writeFile(database, binaryAssignmentBridge);
      await scanAcceptancePaths([database]);

      for (const credential of [
        `propr_it_${'a'.repeat(20)}`,
        `ghp_${'b'.repeat(20)}`,
        `Bearer ${'c'.repeat(16)}`,
        'token=printable-value',
        'secret: printable-value',
        'password = printable-value',
        'private-key=printable-value',
      ]) {
        await writeFile(database, Buffer.concat([
          binaryAssignmentBridge,
          Buffer.from([0x00, 0xff]),
          Buffer.from(credential, 'ascii'),
          Buffer.from([0x00]),
        ]));
        await assert.rejects(scanAcceptancePaths([database]), /Secret-shaped value/);
      }

      const sentinel = 'acceptance-exact-sentinel';
      await writeFile(database, Buffer.concat([
        Buffer.from([0x00, 0x80, 0xff]),
        Buffer.from(sentinel, 'ascii'),
        Buffer.from([0x01, 0xfe, 0x00]),
      ]));
      await assert.rejects(scanAcceptancePaths([database], [sentinel]), /Secret sentinel/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not mistake base64url journal ciphertext for a token prefix while still catching bounded tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-journal-scan-'));
    const desktop = join(root, 'desktop');
    const journal = join(desktop, 'profiles.journal.0');
    // Deterministic ciphertext-shaped base64url whose random-looking bytes happen to spell
    // token prefixes mid-run, as uniformly random encrypted payloads do by chance.
    const ciphertext = `${'Qm'.repeat(40)}ghp_${'x'.repeat(36)}${'-_'.repeat(20)}propr_it_${'Y'.repeat(43)}${'Qm'.repeat(40)}`;
    const record = { version: 2, generation: '7', encryptedPayload: ciphertext, checksum: 'f'.repeat(64) };
    try {
      await mkdir(desktop, { recursive: true });
      await writeFile(journal, `P${JSON.stringify(record)}\n`);
      await scanAcceptancePaths([root]);

      for (const leaked of [
        `{"encryptedPayload":"${ciphertext}","leak":"ghp_${'b'.repeat(36)}"}`,
        `${ciphertext} ghu_${'b'.repeat(36)}`,
        `token=propr_it_${'T'.repeat(43)}`,
        `{"url":"https://example.invalid/propr_it_${'T'.repeat(43)}"}`,
      ]) {
        await writeFile(journal, `P${leaked}\n`);
        await assert.rejects(scanAcceptancePaths([root]), /Secret-shaped value/);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('catches tokens bounded by serialized whitespace escapes through the artifact scan, raw binary runs, trace sanitization and the manifest contract, while mid-ciphertext prefixes and exact sentinel checks stay as they are', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-escaped-scan-'));
    const log = join(root, 'desktop', 'packaged-process.log');
    // Synthetic token shapes; neither is a real credential.
    const token = `ghp_${'b'.repeat(36)}`;
    const internal = `propr_it_${'T'.repeat(43)}`;
    // Ciphertext whose random-looking bytes spell both prefixes mid-run, each right after a base64url character.
    const ciphertext = `${'Qm'.repeat(40)}nghp_${'x'.repeat(36)}${'-_'.repeat(20)}Apropr_it_${'Y'.repeat(43)}${'Qm'.repeat(40)}`;
    try {
      await mkdir(join(root, 'desktop'), { recursive: true });
      // A serialized log escapes the whitespace that bounds a token; the scan does not decode it, yet must see
      // the token after the escape, as it does after the decoded whitespace itself.
      for (const serialized of [
        String.raw`{"level":"error","message":"request failed\n${token}"}`,
        String.raw`{"level":"error","message":"request failed\t${internal}"}`,
        String.raw`{"level":"error","message":"request failed\r\n${token}"}`,
        String.raw`{"level":"error","message":"request failed\u000a${internal}"}`,
        String.raw`{"level":"error","message":"{\"nested\":\"request failed\\n${token}\"}"}`,
        String.raw`error: request failed\x0a${token}`,
        `GET /callback?error=%0A${internal} HTTP/1.1`,
        `{"level":"error","message":"request failed\n${token}"}`,
        `{"level":"error","message":"request failed\t${internal}"}`,
      ]) {
        await writeFile(log, `${serialized}\n`);
        await assert.rejects(scanAcceptancePaths([root]), /Secret-shaped value/, serialized);
      }
      // The same escapes before ciphertext do not turn its mid-run coincidences into tokens: a prefix is still
      // excluded whenever a base64url character precedes it.
      for (const record of [
        `P${JSON.stringify({ version: 2, generation: '7', encryptedPayload: ciphertext, checksum: 'f'.repeat(64) })}`,
        String.raw`{"level":"debug","message":"journal\n${ciphertext}"}`,
        String.raw`{"level":"debug","message":"journal\u000a${ciphertext}"}`,
        `{"level":"debug","message":"journal\n${ciphertext}"}`,
      ]) {
        await writeFile(log, `${record}\n`);
        await scanAcceptancePaths([root]);
      }
      // An exact forbidden value is matched raw, before any shape, whatever serialized whitespace precedes it.
      await writeFile(log, String.raw`{"level":"error","message":"request failed\n${internal}"}` + '\n');
      await assert.rejects(scanAcceptancePaths([root], [internal]), /Secret sentinel/);

      // The raw scanner sees the same boundary inside a printable run of a binary file.
      const database = join(root, 'key4.db');
      await writeFile(database, Buffer.concat([
        Buffer.from('SQLite format 3\0', 'ascii'),
        Buffer.from([0x00, 0x80, 0xff]),
        Buffer.from(String.raw`{"message":"failed\n${token}"}`, 'ascii'),
        Buffer.from([0x00, 0x02]),
      ]));
      await assert.rejects(scanAcceptancePaths([database]), /Secret-shaped value/);

      // A traced response body with a token after a newline is serialized with the escape; the published trace is
      // rejected until it is sanitized, which replaces only the token and keeps the escape.
      const trace = join(root, 'sanitized-trace.zip');
      const network = JSON.stringify({
        type: 'resource-snapshot',
        snapshot: {
          request: { url: 'http://127.0.0.2:41731/api/queue/stats' },
          response: { status: 401, content: { text: `authorization failed\n${token}` } },
        },
      });
      assert.ok(network.includes(String.raw`\n${token}`), 'the trace entry carries the escaped newline before the token');
      await writeFile(trace, zipFixture('trace.network', network));
      await assert.rejects(scanAcceptancePaths([trace]), /Secret-shaped value/);
      await sanitizeAcceptanceTrace(trace);
      await scanAcceptancePaths([trace]);
      const event = JSON.parse(readSingleZipEntry(await readFile(trace)).toString('utf8'));
      assert.equal(event.snapshot.response.content.text, `authorization failed\n${ACCEPTANCE_REDACTION_PLACEHOLDER}`);
      assert.equal(event.snapshot.request.url, 'http://127.0.0.2:41731/api/queue/stats');

      // Through the artifact contract itself: a complete, manifest-consistent artifact set whose trace still carries
      // the escaped-newline token fails verification on the scan, not on the manifest, and passes once sanitized.
      // The fixture stores its entry uncompressed, so the scan of the ZIP's own bytes is what rejects it.
      const parent = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-escaped-artifacts-'));
      const artifactRoot = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
      try {
        await createCompleteArtifactSet(artifactRoot);
        const publishedTrace = join(artifactRoot, 'sanitized-trace.zip');
        const republish = async bytes => {
          await writeFile(publishedTrace, bytes);
          const manifest = JSON.parse(await readFile(join(artifactRoot, 'manifest.json'), 'utf8'));
          manifest.supporting = manifest.supporting.map(entry => entry.name === 'sanitized-trace.zip'
            ? { ...entry, bytes: bytes.length, sha256: sha256(bytes) } : entry);
          await writeFile(join(artifactRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        };
        await republish(zipFixture('trace.network', network));
        await assert.rejects(verifyAcceptanceArtifacts(artifactRoot, { ocr: async () => '' }), /Secret-shaped value found in .*sanitized-trace\.zip/);
        await sanitizeAcceptanceTrace(publishedTrace);
        await republish(await readFile(publishedTrace));
        await verifyAcceptanceArtifacts(artifactRoot, { ocr: async () => '' });
      } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('sanitizes traced network secrets so sentinel and generic scans pass deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-trace-'));
    const trace = join(root, 'sanitized-trace.zip');
    const sentinel = `propr_it_${'T'.repeat(43)}`;
    const network = JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        request: {
          url: 'http://127.0.0.2:41731/api/queue/stats',
          headers: [{ name: 'Authorization', value: `Bearer ${sentinel}` }],
        },
        response: { status: 200 },
      },
    });
    try {
      await writeFile(trace, zipFixture('trace.network', network));
      await assert.rejects(scanAcceptancePaths([trace], [sentinel]), /Secret sentinel/);
      await sanitizeAcceptanceTrace(trace, [sentinel]);
      await scanAcceptancePaths([trace], [sentinel]);
      await scanAcceptancePaths([trace]);
      const sanitizedEntry = readSingleZipEntry(await readFile(trace)).toString('utf8');
      const event = JSON.parse(sanitizedEntry);
      assert.equal(event.snapshot.request.url, 'http://127.0.0.2:41731/api/queue/stats');
      assert.equal(event.snapshot.request.headers[0].value, `Bearer ${ACCEPTANCE_REDACTION_PLACEHOLDER}`);
      assert.ok(!sanitizedEntry.includes(sentinel));
      const firstPass = await readFile(trace);
      await sanitizeAcceptanceTrace(trace, [sentinel]);
      assert.deepEqual(await readFile(trace), firstPass);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves secret-free trace entries byte-for-byte through sanitization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-trace-binary-'));
    const trace = join(root, 'sanitized-trace.zip');
    const binary = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x80]),
      Buffer.from('screenshot-body', 'ascii'),
      Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    ]);
    try {
      await writeFile(trace, zipFixture('resources/page@1.jpeg', binary));
      await sanitizeAcceptanceTrace(trace, [`propr_it_${'T'.repeat(43)}`]);
      assert.deepEqual(readSingleZipEntry(await readFile(trace)), binary);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails closed on missing, mutated, and unexpected artifact data', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-invalid-'));
    const root = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
    try {
      await mkdir(join(root, 'screenshots'), { recursive: true });
      await assert.rejects(verifyAcceptanceArtifacts(root, { ocr: async () => '' }), /artifact set mismatch.*missing/i);
      const evidence = await createCompleteArtifactSet(root);
      assert.throws(
        () => validateAcceptanceEvidence({ ...evidence.accessibility, extra: true }, evidence.manifest, evidence.summary, evidence.sanitizedLog),
        /schema changed/,
      );
      assert.throws(
        () => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, {
          ...evidence.summary,
          services: { ...evidence.summary.services, connect: { confirmedRequests: 0, journeys: [] } },
        }, evidence.sanitizedLog),
        /not observed/,
      );
      assert.throws(
        () => validateAcceptanceEvidence(evidence.accessibility, evidence.manifest, {
          ...evidence.summary,
          console: {
            ...evidence.summary.console,
            records: 4,
            errors: 1,
            unexpectedErrors: 1,
            errorCategoryCounts: { ...evidence.summary.console.errorCategoryCounts, networkResource: 1 },
          },
        }, evidence.sanitizedLog),
        /console summary is invalid/,
      );
      assert.throws(() => validateAcceptanceEvidence(
        evidence.accessibility, evidence.manifest, evidence.summary,
        { ...evidence.sanitizedLog, records: evidence.sanitizedLog.records.filter(record => record.journey !== 'csp-reload-removal') },
      ), /process log coverage is incomplete/);
      const unknownPhaseLog = structuredClone(evidence.sanitizedLog);
      unknownPhaseLog.records.at(-1).journey = 'csp-reload-unknown';
      assert.throws(() => validateAcceptanceEvidence(
        evidence.accessibility, evidence.manifest, evidence.summary, unknownPhaseLog,
      ), /sanitized log record is invalid/);
      const transitionSummary = structuredClone(evidence.summary);
      Object.assign(transitionSummary.console, { records: 6, errors: 6, expectedErrors: 6 });
      transitionSummary.console.errorCategoryCounts.expectedCspPolicyTransition = 6;
      const transitionLog = { ...evidence.sanitizedLog, records: [...evidence.sanitizedLog.records.filter(record => record.source === 'packaged-process'), ...Array.from({ length: 6 }, () => ({
        journey: 'csp-reload-pairing', source: 'renderer-console', level: 'error', bytes: 10, sha256: '5'.repeat(64),
      }))] };
      assert.doesNotThrow(() => validateAcceptanceEvidence(
        evidence.accessibility, evidence.manifest, transitionSummary, transitionLog,
      ));
      Object.assign(transitionSummary.console, { records: 7, errors: 7, expectedErrors: 7 });
      transitionSummary.console.errorCategoryCounts.expectedCspPolicyTransition = 7;
      assert.throws(() => validateAcceptanceEvidence(
        evidence.accessibility, evidence.manifest, transitionSummary, evidence.sanitizedLog,
      ), /console summary is invalid/);
      for (const mutateHandshake of [
        handshake => { handshake.scopeQueryPresent = false; handshake.scopeQueryCount = 0; },
        handshake => { handshake.scopeQueryCount = 2; },
        handshake => { handshake.scopeEqualsActivatedBinding = false; handshake.rejectionCategory = 'stale-scope'; },
        handshake => { handshake.rejectionCategory = 'wrong-origin'; },
        handshake => { handshake.rendererBearerPresent = true; },
      ]) {
        const invalidSummary = structuredClone(evidence.summary);
        mutateHandshake(invalidSummary.services.socketIo.handshake);
        assert.throws(
          () => validateAcceptanceEvidence(
            evidence.accessibility, evidence.manifest, invalidSummary, evidence.sanitizedLog,
          ),
          /not observed/,
        );
      }
      for (const mutateLifecycle of [
        lifecycle => { lifecycle.profileActivationPublished = false; },
        lifecycle => { lifecycle.socketProviderMounted = false; },
        lifecycle => { lifecycle.providerDisabled = true; },
        lifecycle => { lifecycle.disabledByDemoModeLoading = true; },
        lifecycle => { lifecycle.disabledByDemoMode = true; },
        lifecycle => { lifecycle.disabledByCurrentUserLoading = true; },
        lifecycle => { lifecycle.disabledByCurrentUserAbsent = true; },
        lifecycle => { lifecycle.connectionScope = 'unavailable'; },
        lifecycle => { lifecycle.socketConstructionInvocations = 0; },
        lifecycle => { lifecycle.socketConstructions = 0; },
        lifecycle => { lifecycle.connectInvocations = 0; },
        lifecycle => { lifecycle.connectInvocations = 2; },
      ]) {
        const invalidSummary = structuredClone(evidence.summary);
        mutateLifecycle(invalidSummary.services.socketIo.handshake.rendererLifecycle);
        assert.throws(
          () => validateAcceptanceEvidence(
            evidence.accessibility, evidence.manifest, invalidSummary, evidence.sanitizedLog,
          ),
          /not observed/,
        );
      }
      const relabeledManifest = structuredClone(evidence.manifest);
      const zoomEntry = relabeledManifest.screenshots.find(entry => entry.variant === 'zoom-200');
      zoomEntry.appliedZoomFactor = 1;
      zoomEntry.rendererDevicePixelRatio = 1;
      zoomEntry.geometryZoom = { width: 1, height: 1 };
      zoomEntry.effectiveVisibleCssSpan = { width: 1280, height: 820 };
      assert.throws(
        () => validateAcceptanceEvidence(evidence.accessibility, relabeledManifest, evidence.summary, evidence.sanitizedLog),
        /zoom-200.*viewport metric evidence changed/,
      );
      for (const mutate of [
        entry => { entry.layoutViewport.width += 1; },
        entry => { entry.scrollbarInsets.width += 1; },
        entry => { entry.visualViewportInsets.width += 1; },
        entry => { entry.rendererVisualViewport.width += 0.5; },
        entry => { entry.cdpVisualViewport.width += 0.5; },
        entry => {
          entry.documentClientViewport.width = entry.rendererViewport.width - 65;
          entry.layoutViewport.width = entry.documentClientViewport.width;
          entry.scrollbarInsets.width = 65;
        },
        entry => {
          entry.visualViewportInsets.width = 65;
          entry.rendererVisualViewport.width = entry.rendererViewport.width - 65;
          entry.cdpVisualViewport.width = entry.rendererVisualViewport.width;
        },
        entry => { entry.visualViewportInsets.width = Number.NaN; },
      ]) {
        const invalidScrollbarManifest = structuredClone(evidence.manifest);
        mutate(invalidScrollbarManifest.screenshots.find(entry => entry.variant === 'zoom-200'));
        assert.throws(
          () => validateAcceptanceEvidence(evidence.accessibility, invalidScrollbarManifest, evidence.summary, evidence.sanitizedLog),
          /zoom-200.*viewport metric evidence changed/,
        );
      }
      const invalidAccessibility = structuredClone(evidence.accessibility);
      invalidAccessibility.checks.find(check => check.variant === 'zoom-200').visualViewportInsets.width = 8;
      assert.throws(
        () => validateAcceptanceEvidence(invalidAccessibility, evidence.manifest, evidence.summary, evidence.sanitizedLog),
        /zoom-200.*viewport metric evidence changed/,
      );
      const duplicateManifest = structuredClone(evidence.manifest);
      const duplicateZoom = duplicateManifest.screenshots.find(entry => entry.variant === 'zoom-200');
      const matchingHighDpi = duplicateManifest.screenshots.find(entry => (
        entry.journey === duplicateZoom.journey && entry.variant === 'high-dpi'
      ));
      duplicateZoom.sha256 = matchingHighDpi.sha256;
      duplicateZoom.repeatabilitySha256 = matchingHighDpi.sha256;
      assert.throws(
        () => validateAcceptanceEvidence(evidence.accessibility, duplicateManifest, evidence.summary, evidence.sanitizedLog),
        /zoom-200 screenshot is not visually distinct/,
      );
      const screenshotPath = join(root, 'screenshots', expectedScreenshotNames()[0]);
      await writeFile(screenshotPath, pngHeader(1, 1));
      await assert.rejects(verifyAcceptanceArtifacts(root, { ocr: async () => '' }), /bytes, digest, or dimensions/);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('only recursively removes a dedicated non-link allowlisted leaf', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-cleanup-'));
    try {
      const leaf = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
      await mkdir(join(leaf, 'nested'), { recursive: true });
      await writeFile(join(leaf, 'nested', 'artifact'), 'safe');
      await safeRemoveAcceptanceLeaf(resolve(leaf), { kind: 'artifact', allowedWorkspaceParents: [parent] });
      await safeRemoveAcceptanceLeaf(resolve(leaf), { kind: 'artifact', allowedWorkspaceParents: [parent] });
      await assert.rejects(safeRemoveAcceptanceLeaf(resolve(parent), { kind: 'artifact', allowedWorkspaceParents: [parent] }), /dedicated allowlisted leaf/);
      const tooDeep = join(parent, 'nested', ACCEPTANCE_ARTIFACT_LEAF);
      await mkdir(tooDeep, { recursive: true });
      await assert.rejects(safeRemoveAcceptanceLeaf(resolve(tooDeep), { kind: 'artifact', allowedWorkspaceParents: [parent] }), /canonical allowlisted parent/);
      const realParent = join(parent, 'real-parent');
      const linkedParent = join(parent, 'linked-parent');
      await mkdir(join(realParent, ACCEPTANCE_ARTIFACT_LEAF), { recursive: true });
      await symlink(realParent, linkedParent);
      await assert.rejects(
        safeRemoveAcceptanceLeaf(resolve(linkedParent, ACCEPTANCE_ARTIFACT_LEAF), { kind: 'artifact', allowedWorkspaceParents: [linkedParent] }),
        /allowed parent must be an existing non-link directory/,
      );
      const outside = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-escape-'));
      try {
        const escapedParent = join(parent, 'escaped-parent');
        await symlink(outside, escapedParent);
        await mkdir(join(outside, 'nested', ACCEPTANCE_ARTIFACT_LEAF), { recursive: true });
        await assert.rejects(
          safeRemoveAcceptanceLeaf(join(escapedParent, 'nested', ACCEPTANCE_ARTIFACT_LEAF), { kind: 'artifact', allowedWorkspaceParents: [parent] }),
          /canonical allowlisted parent/,
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
      const linkedLeaf = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
      await symlink(join(realParent, ACCEPTANCE_ARTIFACT_LEAF), linkedLeaf);
      await assert.rejects(
        safeRemoveAcceptanceLeaf(resolve(linkedLeaf), { kind: 'artifact', allowedWorkspaceParents: [parent] }),
        /non-link directory/,
      );
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('confines the singleton exception to an owned private profile root with a dangling uint64 target', {
    skip: process.platform === 'win32' ? 'POSIX singleton regression' : false,
  }, async () => {
    const profile = await mkdtemp(join(tmpdir(), ACCEPTANCE_PROFILE_PREFIX));
    const outside = await mkdtemp(join(tmpdir(), 'propr-cookie-escape-'));
    try {
      const cookie = join(profile, 'SingletonCookie');
      for (const target of [join(outside, 'outside'), '../outside', '18446744073709551616', '01', 'not-a-cookie']) {
        await symlink(target, cookie);
        await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile), /uint64 token/);
        await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
        await rm(cookie);
      }
      await symlink('123', cookie);
      await chmod(profile, 0o755);
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile), /owned private profile/);
      await chmod(profile, 0o700);
      await rm(cookie);
      const alias = join(outside, 'profile-alias');
      await symlink(profile, alias);
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(alias), /allowlisted leaf/);
      await writeFile(join(profile, '123'), 'regular target');
      await symlink('123', cookie);
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile), /target must be absent/);
      await rm(cookie);
      await rm(join(profile, '123'));
      await symlink(outside, join(profile, '123'));
      await symlink('123', cookie);
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile), /target must be absent/);
      await rm(cookie);
      await rm(join(profile, '123'));
      await mkdir(join(profile, 'nested'));
      await symlink('123', join(profile, 'nested', 'SingletonCookie'));
      await removeOwnedAcceptanceProfileSingletons(profile);
      await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
      await symlink('123', join(outside, 'SingletonCookie'));
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(outside), /allowlisted leaf/);
      await assert.rejects(scanAcceptancePaths([outside]), /symbolic link/);
      await writeFile(cookie, 'secret-cookie-sentinel');
      await removeOwnedAcceptanceProfileSingletons(profile);
      await rm(join(profile, 'nested'), { recursive: true });
      await assert.rejects(scanAcceptancePaths([profile], ['secret-cookie-sentinel']), /Secret sentinel/);
    } finally {
      await rm(profile, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts only exact stopped-child singleton entries and preserves outside paths and profile files', {
    skip: process.platform === 'win32' ? 'POSIX singleton regression' : false,
  }, async () => {
    const profile = await mkdtemp(join(tmpdir(), ACCEPTANCE_PROFILE_PREFIX));
    const outside = await mkdtemp('/tmp/scoped_dir');
    const pid = 12345;
    const options = { stoppedChildPid: pid };
    try {
      const socketTarget = join(outside, 'SingletonSocket');
      await writeFile(socketTarget, 'outside data');
      await writeFile(join(profile, 'persisted-session'), 'session data');
      for (const token of ['0', '18446744073709551615']) {
        await symlink(token, join(profile, 'SingletonCookie'));
        await symlink(`${hostname()}-${pid}`, join(profile, 'SingletonLock'));
        await symlink(socketTarget, join(profile, 'SingletonSocket'));
        await removeOwnedAcceptanceProfileSingletons(profile, options);
        for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
          await assert.rejects(lstat(join(profile, name)), { code: 'ENOENT' });
        }
        await scanAcceptancePaths([profile]);
        assert.equal(await readFile(socketTarget, 'utf8'), 'outside data');
        assert.equal(await readFile(join(profile, 'persisted-session'), 'utf8'), 'session data');
      }
      for (const target of ['foreign-host-12345', `${hostname()}-12346`, `${hostname()}-012345`,
        `${hostname()}-0`, `${hostname()}--1`, `${hostname()}-12345/extra`, '../escape', socketTarget]) {
        await symlink(target, join(profile, 'SingletonLock'));
        await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /stopped child PID/);
        assert.equal(await readlink(join(profile, 'SingletonLock')), target);
        await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
        await rm(join(profile, 'SingletonLock'));
      }
      await symlink(`${hostname()}-${pid}`, join(profile, 'SingletonLock'));
      for (const stoppedChildPid of [undefined, 0, -1, 1.5, '12345', Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, { stoppedChildPid }), /stopped child PID/);
      }
      await chmod(profile, 0o755);
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /owned private profile/);
      await chmod(profile, 0o700);
      await writeFile(join(profile, `${hostname()}-${pid}`), 'secret');
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /target must be absent/);
      await rm(join(profile, `${hostname()}-${pid}`));
      await symlink(outside, join(profile, `${hostname()}-${pid}`));
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /target must be absent/);
      await rm(join(profile, `${hostname()}-${pid}`));
      await symlink('123', join(profile, 'SingletonCookie'));
      for (const target of ['/tmp/scoped_dirABC12/SingletonSocket', '/tmp/scoped_dirABC1234/SingletonSocket',
        '/tmp/scoped_dirABC_12/SingletonSocket', '/tmp/scoped_dirABC123/other',
        '/tmp/org.chromium.Chromium.ABC123/SingletonSocket', '/outside/scoped_dirABC123/SingletonSocket',
        '../scoped_dirABC123/SingletonSocket', '/tmp/scoped_dirABC123/../SingletonSocket']) {
        await symlink(target, join(profile, 'SingletonSocket'));
        await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /socket requires/);
        assert.equal(await readlink(join(profile, 'SingletonCookie')), '123'); // No partial cleanup.
        assert.equal(await readlink(join(profile, 'SingletonSocket')), target);
        await rm(join(profile, 'SingletonSocket'));
      }
      await symlink(socketTarget, join(profile, 'SingletonSocket'));
      await rm(join(profile, 'SingletonCookie'));
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /socket requires/);
      await rm(join(profile, 'SingletonLock'));
      await symlink('123', join(profile, 'SingletonCookie'));
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(profile, options), /socket requires/);
      await rm(join(profile, 'SingletonSocket'));
      await removeOwnedAcceptanceProfileSingletons(profile, options);
      for (const name of ['SingletonLockExtra', 'SingletonSocketExtra', 'SingletonOther',
        'singletoncookie', 'singletonlock', 'singletonsocket', 'SINGLETONLOCK']) {
        await symlink(`${hostname()}-${pid}`, join(profile, name));
        await removeOwnedAcceptanceProfileSingletons(profile, options);
        await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
        await rm(join(profile, name));
      }
      // Default macOS volumes resolve this spelling to SingletonLock. Detect
      // that identity in the fixture rather than assuming case sensitivity.
      const caseVariant = join(profile, 'singletonlock');
      await symlink(`${hostname()}-${pid}`, caseVariant);
      const variantStats = await lstat(caseVariant);
      const canonicalStats = await lstat(join(profile, 'SingletonLock')).catch(error => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (canonicalStats) {
        assert.equal(canonicalStats.dev, variantStats.dev);
        assert.equal(canonicalStats.ino, variantStats.ino);
      }
      await removeOwnedAcceptanceProfileSingletons(profile, options);
      assert.equal(await readlink(caseVariant), `${hostname()}-${pid}`);
      await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
      await rm(caseVariant);
      await mkdir(join(profile, 'nested'));
      await symlink(`${hostname()}-${pid}`, join(profile, 'nested', 'SingletonLock'));
      await removeOwnedAcceptanceProfileSingletons(profile, options);
      await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
      await rm(join(profile, 'nested'), { recursive: true });
      await symlink(`${hostname()}-${pid}`, join(outside, 'SingletonLock'));
      await assert.rejects(removeOwnedAcceptanceProfileSingletons(outside, options), /allowlisted leaf/);
      for (const name of ['SingletonLock', 'SingletonSocket']) {
        await writeFile(join(profile, name), 'regular-file-secret');
        await removeOwnedAcceptanceProfileSingletons(profile, options);
        await assert.rejects(scanAcceptancePaths([profile], ['regular-file-secret']), /Secret sentinel/);
        await rm(join(profile, name));
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves case-insensitive singleton aliases on macOS for strict scanning', {
    skip: process.platform !== 'darwin' ? 'macOS-only case-insensitive filesystem regression' : false,
  }, async t => {
    const profile = await mkdtemp(join(tmpdir(), ACCEPTANCE_PROFILE_PREFIX));
    const targets = { SingletonCookie: '123', SingletonLock: `${hostname()}-12345`,
      SingletonSocket: '/tmp/scoped_dirABC123/SingletonSocket' };
    try {
      for (const [name, target] of Object.entries(targets)) {
        const alias = join(profile, name.toLowerCase());
        await symlink(target, alias);
        const aliasStats = await lstat(alias);
        const canonicalStats = await lstat(join(profile, name)).catch(error => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!canonicalStats) {
          t.skip('the configured macOS temporary volume is case-sensitive');
          return;
        }
        assert.equal(canonicalStats.dev, aliasStats.dev);
        assert.equal(canonicalStats.ino, aliasStats.ino);
        await removeOwnedAcceptanceProfileSingletons(profile, { stoppedChildPid: 12345 });
        assert.equal(await readlink(alias), target);
        await assert.rejects(scanAcceptancePaths([profile]), /symbolic link/);
        await rm(alias);
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('does not probe differently spelled singleton entries even when path lookup would alias them', async () => {
    const source = await readFile(new URL('./acceptance-artifacts.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export const removeOwnedAcceptanceProfileSingletons =');
    const end = source.indexOf('export const prepareAcceptanceArtifactDirectory', start);
    const cleanup = runInNewContext(source.slice(start, end).replace('export const', 'const') +
      '; removeOwnedAcceptanceProfileSingletons;', {
        process: { getuid: () => 1000 }, hostname: () => 'local-host', join,
        validateAcceptanceLeaf: async () => ({ target: '/tmp/profile',
          stats: { dev: 1, ino: 2, uid: 1000, mode: 0o40700 } }),
        readdir: async () => ['singletoncookie', 'singletonlock', 'singletonsocket', 'SingletonOther'],
        lstat: async () => assert.fail('unrecognized directory entry must not be probed'),
        readlink: async () => assert.fail('unrecognized link must not be read'),
        unlink: async () => assert.fail('unrecognized link must not be removed'),
      });
    await cleanup('/tmp/profile', { stoppedChildPid: 321 });
  });

  it('rejects changed links and profile identity before unlink, including replacement with the same target', async () => {
    const source = await readFile(new URL('./acceptance-artifacts.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('export const removeOwnedAcceptanceProfileSingletons =');
    const end = source.indexOf('export const prepareAcceptanceArtifactDirectory', start);
    for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
      for (const race of ['target', 'inode', 'regular-file', 'owner', 'profile', 'spelling']) {
        for (const phase of [2, 3, 4, 5]) { // Before/after readlink in both validation passes.
          const targets = { SingletonCookie: '123', SingletonLock: 'local-host-321',
            SingletonSocket: '/tmp/scoped_dirABC123/SingletonSocket' };
          const entryStats = { dev: 1, ino: 1, uid: 1000, mode: 0o120777, ctimeMs: 1, isSymbolicLink: () => true };
          const profileStats = { dev: 1, ino: 2, uid: 1000, mode: 0o40700 };
          const reads = new Map();
          let raced = false;
          const unlinked = [];
          const cleanup = runInNewContext(source.slice(start, end).replace('export const', 'const') +
            '; removeOwnedAcceptanceProfileSingletons;', {
              process: { getuid: () => 1000 }, hostname: () => 'local-host', join, Number, BigInt,
              validateAcceptanceLeaf: async () => ({ target: '/tmp/profile',
                stats: raced && race === 'profile' ? { ...profileStats, ino: 9 } : profileStats }),
              readdir: async () => Object.keys(targets).map(entry =>
                raced && race === 'spelling' && entry === name ? entry.toLowerCase() : entry),
              lstat: async path => {
                const entry = path.split('/').at(-1);
                if (!(entry in targets)) throw Object.assign(new Error('missing token'), { code: 'ENOENT' });
                const count = (reads.get(entry) ?? 0) + 1;
                reads.set(entry, count);
                if (entry === name && count === phase) raced = true;
                if (entry === name && raced) {
                  if (race === 'target') return { ...entryStats, ctimeMs: 9 };
                  if (race === 'inode') return { ...entryStats, ino: 9 };
                  if (race === 'regular-file') return { ...entryStats, mode: 0o100600 };
                  if (race === 'owner') return { ...entryStats, uid: 999 };
                }
                return entryStats;
              },
              readlink: async path => {
                const entry = path.split('/').at(-1);
                return raced && entry === name && race === 'target' ? '/outside/changed' : targets[entry];
              },
              unlink: async path => { unlinked.push(path.split('/').at(-1)); },
            });
          await assert.rejects(cleanup('/tmp/profile', { stoppedChildPid: 321 }), /changed during cleanup/);
          assert.equal(unlinked.includes(name), false, `${name}/${race}/${phase}`);
          if (phase <= 3) assert.deepEqual(unlinked, []);
        }
      }
    }
  });

  it('authorizes the standard macOS temporary-directory alias by canonical parent identity', {
    skip: process.platform !== 'darwin' ? 'macOS-only /var alias regression' : false,
  }, async t => {
    const aliasedParent = await mkdtemp(join(resolve(tmpdir()), 'propr-acceptance-macos-alias-'));
    const canonicalParent = await realpath(aliasedParent);
    if (aliasedParent === canonicalParent) {
      await rm(aliasedParent, { recursive: true, force: true });
      t.skip('the configured macOS temporary directory does not use an alias');
      return;
    }
    const leaf = join(aliasedParent, ACCEPTANCE_ARTIFACT_LEAF);
    try {
      await mkdir(leaf);
      await safeRemoveAcceptanceLeaf(leaf, { kind: 'artifact', allowedWorkspaceParents: [canonicalParent] });
      await safeRemoveAcceptanceLeaf(leaf, { kind: 'artifact', allowedWorkspaceParents: [canonicalParent] });
    } finally {
      await rm(aliasedParent, { recursive: true, force: true });
    }
  });
});
