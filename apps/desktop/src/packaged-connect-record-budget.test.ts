import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  CONNECT_READY_EVENT,
  PACKAGED_CONNECT_RECORD_MAX_COUNT,
  runPackagedConnectLifecycle,
} from '../scripts/packaged-connect-lifecycle.mjs';
import {
  createPackagedConnectOwnershipReporter,
  type DesktopRendererOwnershipEvidence,
} from './session-security';

const expectedOwnership = Object.freeze({
  schemaVersion: 1,
  resourceCategory: 'xhr',
  mainRendererPresent: true,
  mainRendererLive: true,
  webContentsIdMatches: true,
  webContentsAbsentOrMatches: true,
  mainFrameLive: true,
  rendererDocumentTrusted: true,
  rendererDocumentAuthorityEqual: true,
  frameOmitted: false,
  framePresent: true,
  frameMatchesMainFrame: true,
  frameExplicitlyForeign: false,
  rendererOwned: true,
} satisfies DesktopRendererOwnershipEvidence);

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  write(record: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  close(): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', 0, null));
  }
}

test('combined tray and notifications Connect lifecycle stays within the 128-record contract', async () => {
  const ownershipRecords: Array<Record<string, unknown>> = [];
  const reportOwnership = createPackagedConnectOwnershipReporter(evidence => {
    ownershipRecords.push({ event: 'desktop.renderer.connect_request_ownership', ...evidence });
  });
  const resourceCategories: DesktopRendererOwnershipEvidence['resourceCategory'][] = [
    'xhr', 'webSocket', 'other',
  ];

  for (let index = 0; index < 58; index += 1) {
    reportOwnership({
      ...expectedOwnership,
      resourceCategory: resourceCategories[index % resourceCategories.length]!,
    });
  }
  const unexpectedOwnership: DesktopRendererOwnershipEvidence = {
    ...expectedOwnership,
    frameOmitted: true,
    framePresent: false,
    frameMatchesMainFrame: false,
    rendererOwned: false,
  };
  reportOwnership(unexpectedOwnership);

  assert.equal(PACKAGED_CONNECT_RECORD_MAX_COUNT, 128);
  assert.equal(71 + 58, 129, 'the previously observed lifecycle exceeds the contract');
  assert.equal(ownershipRecords.length, 4);
  assert.deepEqual(ownershipRecords.at(-1), {
    event: 'desktop.renderer.connect_request_ownership',
    ...unexpectedOwnership,
  });

  const lifecycleRecords: Array<Record<string, unknown>> = [
    { event: 'desktop.app.ready' },
    { event: 'desktop.renderer.ready' },
    { event: 'desktop.tray.ready' },
    { event: 'desktop.renderer.connect_discovery.status' },
    { event: 'desktop.renderer.connect_discovery.milestone' },
  ];
  for (let index = 0; index < 19; index += 1) {
    lifecycleRecords.push({ event: 'desktop.renderer.connect_journey.stage' });
  }
  for (let index = 0; index < 12; index += 1) {
    lifecycleRecords.push({ event: 'desktop.renderer.connect_discovery.phase' });
  }
  for (let index = 0; index < 6; index += 1) {
    lifecycleRecords.push({ event: 'desktop.authentication_pair.progress' });
  }
  for (let index = 0; index < 5; index += 1) {
    lifecycleRecords.push({
      event: 'desktop.renderer.connect_journey.operation',
      operation: 'PROBE',
      status: 'READY',
    });
  }
  for (let index = 0; index < 20; index += 1) {
    lifecycleRecords.push({
      event: 'desktop.app.shutdown_step',
      step: index === 1 ? 'tray-closed' : index === 2 ? 'notifications-closed' : `step-${index}`,
    });
  }
  lifecycleRecords.push(
    {
      timestamp: '2026-09-07T21:00:00.000Z',
      level: 'info',
      event: CONNECT_READY_EVENT,
      selectedPlatform: 'linux',
      selectedArch: 'x64',
      authorityMechanism: 'argv-token',
      rendererSchemaValid: true,
    },
    { event: 'desktop.tray.closed' },
    { event: 'desktop.app.shutdown_retry' },
    { event: 'desktop.app.shutdown' },
  );
  assert.equal(lifecycleRecords.length, 71);

  const records = lifecycleRecords.slice(0, -4)
    .concat(ownershipRecords, lifecycleRecords.slice(-4));
  assert.ok(records.length < PACKAGED_CONNECT_RECORD_MAX_COUNT);
  const child = new FakeChild();
  const result = await runPackagedConnectLifecycle({
    binaryPath: '/package/propr-desktop',
    args: [],
    env: {},
    cwd: '/package',
    platform: 'linux',
    arch: 'x64',
    authorityMechanism: 'argv-token',
    sensitiveNeedles: ['secret-SENTINEL'],
    treeKillerPath: '/usr/bin/false',
    spawn: () => {
      queueMicrotask(() => {
        for (const record of records) child.write(record);
        child.close();
      });
      return child;
    },
    readyTimeoutMs: 50,
    shutdownGraceMs: 50,
    terminationTimeoutMs: 50,
    streamDrainTimeoutMs: 50,
  });

  assert.equal(result.ok, true);
  assert.equal(result.category, 'ready-clean-exit');
  assert.equal(result.capture, 'complete');
  assert.ok(result.records.some(record => record.event === 'desktop.renderer.connect_request_ownership'
    && record.rendererOwned === false));
});
