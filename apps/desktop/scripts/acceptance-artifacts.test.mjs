import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  ACCEPTANCE_ARTIFACT_LEAF,
  ACCEPTANCE_JOURNEYS,
  ACCEPTANCE_VARIANTS,
  DETERMINISTIC_INPUTS,
  FIXED_TIME,
  expectedScreenshotNames,
  readPngDimensions,
  safeRemoveAcceptanceLeaf,
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
  schemaVersion: 6,
  generatedAt: FIXED_TIME,
  serious: 0,
  critical: 0,
  findings: [],
  checks: ACCEPTANCE_JOURNEYS.flatMap(journey => Object.entries(ACCEPTANCE_VARIANTS).map(([variant, config]) => ({
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

const summaryFor = () => ({
  schemaVersion: 4,
  generatedAt: FIXED_TIME,
  status: 'passed',
  journeys: ACCEPTANCE_JOURNEYS.length,
  screenshots: expectedScreenshotNames().length,
  boundary: { packagedExecutable: true, rendererOrigin: 'propr-app://renderer', preloadBridge: true, journeys: ACCEPTANCE_JOURNEYS },
  console: { records: 3, errors: 0 },
  services: {
    rest: { requestCount: 12, authenticatedRequestCount: 3, journeys: ['dashboard-profile-manager'] },
    socketIo: {
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
});

const sanitizedLogFor = () => ({
  schemaVersion: 1,
  generatedAt: FIXED_TIME,
  records: [
    ...Array.from({ length: 3 }, (_, index) => ({
      journey: 'first-run-chooser', source: 'renderer-console', level: 'info', bytes: index, sha256: '5'.repeat(64),
    })),
    ...ACCEPTANCE_JOURNEYS.map(journey => ({
      journey, source: 'packaged-process', level: 'combined', bytes: 0, sha256: '6'.repeat(64),
    })),
  ],
});

const createCompleteArtifactSet = async root => {
  await mkdir(join(root, 'screenshots'), { recursive: true });
  const metadata = [];
  for (const journey of ACCEPTANCE_JOURNEYS) {
    for (const [variant, config] of Object.entries(ACCEPTANCE_VARIANTS)) {
      const name = screenshotName(journey, variant);
      const bytes = Buffer.concat([
        pngHeader(config.viewport.width * config.deviceScaleFactor, config.viewport.height * config.deviceScaleFactor),
        Buffer.from(`${journey}:${variant}`),
      ]);
      await writeFile(join(root, 'screenshots', name), bytes);
      metadata.push({
        name, journey, variant,
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
  const summary = summaryFor();
  const sanitizedLog = sanitizedLogFor();
  await writeFile(join(root, 'accessibility.json'), `${JSON.stringify(accessibility)}\n`);
  await writeFile(join(root, 'sanitized-summary.json'), `${JSON.stringify(summary)}\n`);
  await writeFile(join(root, 'sanitized-log.json'), `${JSON.stringify(sanitizedLog)}\n`);
  await writeFile(join(root, 'sanitized-trace.zip'), zipFixture('trace-entry.txt', 'sanitized trace'));
  const manifest = await writeAcceptanceManifest(root, metadata);
  return { accessibility, manifest, summary, sanitizedLog };
};

describe('packaged acceptance artifact contract', () => {
  it('has exactly 60 deterministic unique names and physical dimensions', () => {
    const names = ACCEPTANCE_JOURNEYS.flatMap(journey => Object.entries(ACCEPTANCE_VARIANTS).map(([variant, config]) => {
      assert.deepEqual(readPngDimensions(pngHeader(config.viewport.width * config.deviceScaleFactor, config.viewport.height * config.deviceScaleFactor)), {
        width: config.viewport.width * config.deviceScaleFactor,
        height: config.viewport.height * config.deviceScaleFactor,
      });
      return screenshotName(journey, variant);
    }));
    assert.equal(names.length, 60);
    assert.deepEqual(names, expectedScreenshotNames());
    assert.equal(new Set(names).size, 60);
    assert.ok(names.every(name => /^[a-z0-9-]+--[a-z0-9-]+\.png$/.test(name)));
  });

  it('writes and verifies the complete strict 60-entry manifest and supporting set', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-acceptance-contract-full-'));
    const root = join(parent, ACCEPTANCE_ARTIFACT_LEAF);
    try {
      const evidence = await createCompleteArtifactSet(root);
      assert.equal(evidence.manifest.screenshots.length, 60);
      assert.equal(evidence.manifest.schemaVersion, 6);
      assert.equal(evidence.accessibility.schemaVersion, 6);
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
