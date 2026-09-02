import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createPackagedSmokeEvidenceSink,
  validatePackagedCurrentUserBoundaryEvidence,
  PACKAGED_SMOKE_EVIDENCE_EVENTS,
  PACKAGED_SMOKE_EVIDENCE_FILE,
  validatePackagedStaleSocketBoundaryEvidence,
} from './smoke-test-evidence';

const withSmokeDirectory = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'propr-desktop-smoke-evidence-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('packaged smoke evidence', () => {
  it('does not create evidence for a non-smoke run', () => {
    withSmokeDirectory(directory => {
      assert.equal(createPackagedSmokeEvidenceSink(null), null);
      assert.deepEqual(readdirSync(directory), []);
    });
  });

  it('writes only fixed allowlisted event-only records and suppresses duplicates', () => {
    withSmokeDirectory(directory => {
      const sink = createPackagedSmokeEvidenceSink(directory);
      assert.ok(sink);
      sink.write('desktop.smoke.authorized');
      sink.write('desktop.smoke.authorized');
      sink.write('https://credentials.example/token?secret=raw');
      sink.write('desktop.renderer.ready');
      sink.close();

      const evidencePath = join(directory, PACKAGED_SMOKE_EVIDENCE_FILE);
      const stats = lstatSync(evidencePath);
      assert.ok(stats.isFile());
      assert.equal(stats.isSymbolicLink(), false);
      const contents = readFileSync(evidencePath, 'utf8');
      assert.deepEqual(contents.trimEnd().split('\n').map(line => JSON.parse(line)), [
        { event: 'desktop.smoke.authorized' },
        { event: 'desktop.renderer.ready' },
      ]);
      assert.doesNotMatch(contents, /timestamp|path|url|error|exception|credential|secret|raw/i);

      const base = {
        schemaVersion: 1 as const,
        path: 'socket-io' as const,
        transport: 'websocket' as const,
        resource: 'websocket' as const,
        scopeQueryPresent: true,
        scopeQueryCount: 1,
        activeBindingPresent: true,
        profileGenerationCurrent: true,
        originEqualsActive: true,
        rendererBearerPresent: false,
        rendererCookiePresent: false,
      };
      const summary = validatePackagedStaleSocketBoundaryEvidence([
        {
          ...base,
          scopeEqualsActive: false,
          outboundBearerPresent: false,
          bearerMainInjected: false,
          accepted: false,
          rejectionCategory: 'stale-scope',
        },
        {
          ...base,
          scopeEqualsActive: true,
          outboundBearerPresent: true,
          bearerMainInjected: true,
          accepted: true,
          rejectionCategory: 'none',
        },
      ], false);
      assert.deepEqual(summary, {
        schemaVersion: 1,
        mainAttempts: 2,
        staleRejectedByMain: true,
        staleRejectionCategory: 'stale-scope',
        freshAcceptedByMain: true,
        exactPath: true,
        exactTransport: true,
        exactResource: true,
        queryCount: 1,
        activeBindingPresent: true,
        profileGenerationCurrent: true,
        originEqualsActive: true,
        rendererBearerPresent: false,
        rendererCookiePresent: false,
        staleOutboundBearerPresent: false,
        staleBearerMainInjected: false,
        freshBearerMainInjected: true,
      });
      assert.throws(
        () => validatePackagedStaleSocketBoundaryEvidence([], false),
        /main-boundary evidence failed/,
      );
      assert.throws(
        () => validatePackagedStaleSocketBoundaryEvidence([
          {
            ...base,
            scopeEqualsActive: false,
            outboundBearerPresent: false,
            bearerMainInjected: false,
            accepted: false,
            rejectionCategory: 'stale-scope',
          },
          {
            ...base,
            scopeEqualsActive: true,
            outboundBearerPresent: true,
            bearerMainInjected: true,
            accepted: true,
            rejectionCategory: 'none',
          },
        ], true),
        /main-boundary evidence failed/,
      );

      const currentUserEvidence = {
        schemaVersion: 2 as const,
        correlation: 'current-scope-user-validation' as const,
        requestObserved: true as const,
        method: 'get' as const,
        rendererScopeGeneration: 1,
        scopeGenerationQueryCount: 1 as const,
        scopeGenerationQueryValid: true,
        scopeHeaderCount: 1 as const,
        activeBindingPresent: true,
        activeScopeGeneration: 0,
        profileGenerationCurrent: true,
        scopeEqualsActive: true,
        originEqualsActive: true,
        rendererBearerPresent: false,
        rendererCookiePresent: false,
        outboundBearerPresent: true,
        bearerMainInjected: true,
        accepted: true,
        rejectionCategory: 'none' as const,
      };
      assert.deepEqual(validatePackagedCurrentUserBoundaryEvidence([
        currentUserEvidence,
        { ...currentUserEvidence, rendererScopeGeneration: 2, activeScopeGeneration: 1 },
        { ...currentUserEvidence, rendererScopeGeneration: 3, activeScopeGeneration: 2 },
      ], false), {
        schemaVersion: 2,
        rendererValidations: 3,
        rendererScopeGenerations: [1, 2, 3],
        exactGet: true,
        scopeHeaderCount: 1,
        activeBindingPresent: true,
        profileGenerationCurrent: true,
        scopeEqualsActive: true,
        originEqualsActive: true,
        rendererBearerPresent: false,
        rendererCookiePresent: false,
        outboundBearerPresent: true,
        bearerMainInjected: true,
        accepted: true,
      });
      assert.throws(
        () => validatePackagedCurrentUserBoundaryEvidence([
          currentUserEvidence,
          { ...currentUserEvidence, rendererScopeGeneration: 2 },
          { ...currentUserEvidence, rendererScopeGeneration: 3, rendererBearerPresent: true },
        ], false),
        /current-user main-boundary evidence failed/,
      );
    });
  });

  it('flushes the bounded lifecycle in emission order', () => {
    withSmokeDirectory(directory => {
      const lifecycle = [
        'desktop.smoke.authorized',
        'desktop.app.ready',
        'desktop.renderer.mvp_flows.ready',
        'desktop.renderer.layout.ready',
        'desktop.native.reduced_window.ready',
        'desktop.renderer.ready',
        'desktop.app.shutdown',
      ];
      const sink = createPackagedSmokeEvidenceSink(directory);
      assert.ok(sink);
      for (const event of lifecycle) sink.write(event);
      for (const event of PACKAGED_SMOKE_EVIDENCE_EVENTS) sink.write(event);
      sink.close();

      const contents = readFileSync(join(directory, PACKAGED_SMOKE_EVIDENCE_FILE), 'utf8');
      const records = contents.trimEnd().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(records.slice(0, lifecycle.length).map(record => record.event), lifecycle);
      assert.equal(records.length, PACKAGED_SMOKE_EVIDENCE_EVENTS.length);
      assert.ok(Buffer.byteLength(contents, 'utf8') < 1024);
    });
  });
});
