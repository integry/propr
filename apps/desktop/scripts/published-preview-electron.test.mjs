import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, it } from 'node:test';
import { build } from 'esbuild';
import { linuxProbeArguments, runElectronFixture } from './electron-fixture-runner.mjs';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(desktop, '../..');

// The only image this probe can assert on travels loopback twice: out through
// the allowlisted CONNECT proxy and into the TLS origin running beside it in the
// fixture's own main process. A shared CI worker can take that path away and
// give it back — one recorded run stalled every request for ~40s and then
// served the next one at once — so the launch budget sizes an outage rather than
// any single request. A healthy worker spends a small fraction of it: this whole
// unit, setup included, has run green in 7.4s.
const launchTimeoutMs = 40_000;
// Two full launches plus the fixture bundle. The runner relaunches a launch it
// could not use (`rejectReport`, `retryAfterSpentBudget`), and setup is hoisted
// into `before` so it cannot claim the room that relaunch needs: that is exactly
// how this unit failed, setup and one killed launch together filling a 50s
// budget that had been copied from a sibling sized for two launches alone.
const testTimeoutMs = 100_000;

let setup;
// `prepareNativeElectronTest` is not free — it spawns `electron --version`
// through the same wrapper the fixture uses, and gives that probe its own 15s
// budget. On the worker that failed this unit, that ran inside the test and left
// the relaunch nowhere to go. It belongs to setup, not the fixture's budget.
before(() => {
  setup = prepareNativeElectronTest();
}, { timeout: 120_000 });

it('renders a published GitHub preview through the native session boundary and signed redirect', {
  timeout: testTimeoutMs,
}, async context => {
  if ('skipReason' in setup) {
    context.skip(setup.skipReason);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'propr-published-preview-'));
  try {
    const fixture = join(directory, 'main.cjs');
    await build({
      entryPoints: [join(desktop, 'scripts/fixtures/published-preview/main.ts')],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
    const report = await runElectronFixture({
      diagnostic: message => context.diagnostic(message),
      electronArguments: [
        ...(process.platform === 'linux' ? linuxProbeArguments : []),
        fixture,
        `--propr-published-preview-image=${join(root, 'propr-ui/public/logo.png')}`,
      ],
      name: 'Published preview Electron fixture',
      // A spent budget is only the shape the one recorded failure happened to
      // take. The same loopback outage can error the image while the page still
      // fires `load`, so the fixture reports `fallbackHidden: false` and shuts
      // down well inside its budget — and the wider the budget, the likelier
      // that is the shape it takes. Naming the evidence relaunches that run too;
      // a preview that is genuinely broken fails the same assertion below on
      // every attempt.
      rejectReport: report => (report.visible?.fallbackHidden === true
        ? undefined
        : 'reported the preview image as unavailable'),
      retryAfterSpentBudget: true,
      setup,
      timeout: launchTimeoutMs,
    });
    assert.equal(report.visible.complete, true);
    assert.equal(report.visible.fallbackHidden, true);
    assert.ok(report.visible.naturalHeight > 0);
    assert.ok(report.visible.naturalWidth > 0);
    assert.equal(report.visible.status, 'Preview loaded securely');
    assert.equal(report.visible.visible, true);
    assert.deepEqual(report.handled.map(request => request.url), [
      'https://github.com/user-attachments/assets/bfd3845c-0e36-42a1-a193-a58f2f368f1d',
      'https://github-production-user-asset-6210df.s3.amazonaws.com/829273/659411478-bfd3845c-0e36-42a1-a193-a58f2f368f1d.png'
        + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAVCODYLSA53PQK4ZA%2F20260926%2Fus-east-1%2Fs3%2Faws4_request'
        + '&X-Amz-Date=20260926T160427Z&X-Amz-Expires=300'
        + `&X-Amz-Signature=${'a'.repeat(64)}&X-Amz-SignedHeaders=host&response-content-type=image%2Fpng`,
    ]);
    assert.deepEqual([...new Set(report.tunnels)], [
      'github.com:443',
      'github-production-user-asset-6210df.s3.amazonaws.com:443',
    ]);
    assert.deepEqual(report.boundary.map(request => request.url), report.handled.map(request => request.url));
    assert.ok(report.boundary.every(request => request.rendererOwned === true
      && request.resourceType === 'image' && !request.cancelled
      && !request.authorization && !request.cookie));
    assert.equal(report.handled.some(request => request.cookie), false);
    assert.equal(report.responseCookiesPersisted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
