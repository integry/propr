import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { before, describe, it } from 'node:test';
import { linuxProbeArguments, runElectronFixture } from './electron-fixture-runner.mjs';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-pairing-zstd-probe.cjs');

// A shared CI worker can take the whole loopback path away and give it back:
// one run stalled every request for ~40s and then served the next one at once.
// The probe waits that outage out inside the budget it is given, so a budget
// sizes an outage rather than any single request. A healthy worker spends none
// of it — these launches take about a second, and one that rides out a 40s
// outage still lands well inside the numbers below.
//
// `scripts/run-test-suite.mjs` bounds this whole unit at 180s and the Electron
// download in `before` draws on the same ceiling, so the two launches are
// budgeted to fit under it together rather than each assuming the whole file.
// A launch the runner has to retry can therefore reach the test timeout rather
// than the runner's own message; it only retries a fixture that reported
// nothing at all, which is a crash rather than a spent budget.
const stallBudgetMs = 45_000;
const stallTestTimeoutMs = 105_000;
// A launch also pays Electron's start-up and the four decoded requests, and
// must outlast the budget so the probe is never killed mid-report.
const fixtureAttempts = 2;
const launchTimeout = budgetMs => budgetMs + 15_000;

const expectedValue = { status: 'approved', transport: 'native-electron-zstd' };
const compressed = zstdCompressSync(Buffer.from(JSON.stringify(expectedValue)));
const decodedOverLimit = zstdCompressSync(Buffer.from(JSON.stringify({
  value: 'A'.repeat(4_097),
})));
const pairingPaths = ['/decoded-over-limit', '/stacked', '/truncated', '/valid'];

const responseBody = path => path === '/decoded-over-limit'
  ? decodedOverLimit
  : path === '/truncated'
    ? compressed.subarray(0, Math.floor(compressed.byteLength / 2))
    : compressed;

describe('Electron pairing response compression', () => {
  let setup;
  // A cold Electron download belongs to setup, not the fixture's own budget.
  before(() => {
    // This probe uses only the main-process Session API, so Chromium's native
    // headless backend is sufficient when a Linux worker has no display.
    setup = prepareNativeElectronTest({ allowHeadlessLinux: true });
  }, { timeout: 120_000 });

  // `stalledRequests` leading requests are accepted and never answered, which
  // is what a worker whose loopback path has briefly gone away looks like from
  // the probe. They are not recorded: only a served request is coverage.
  const runProbe = async ({ budgetMs, context, stalledRequests = 0 }) => {
    const received = [];
    let handled = 0;
    const server = createServer((request, response) => {
      handled += 1;
      if (handled <= stalledRequests) return;
      received.push({ acceptEncoding: request.headers['accept-encoding'], path: request.url });
      const body = responseBody(request.url);
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': request.url === '/stacked' ? 'zstd, gzip' : 'zstd',
        'Content-Length': String(body.byteLength),
      });
      response.end(body);
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const report = await runElectronFixture({
        attempts: fixtureAttempts,
        diagnostic: message => context.diagnostic(message),
        electronArguments: [
          ...(process.platform === 'linux' ? [
            ...linuxProbeArguments,
            ...('headlessLinux' in setup ? ['--headless', '--ozone-platform=headless'] : []),
          ] : []),
          fixture,
          `--pairing-stall-budget-ms=${budgetMs}`,
          `http://127.0.0.1:${address.port}/valid`,
        ],
        name: 'Electron zstd fixture',
        setup,
        timeout: launchTimeout(budgetMs),
      });

      // Reported before any assertion: a worker that ran out of budget fails
      // the coverage assertion below, and the stall counts are what say whether
      // the endpoint or the worker was at fault.
      if (report.stalls.length > 0) {
        const counts = new Map();
        for (const path of report.stalls) counts.set(path, (counts.get(path) ?? 0) + 1);
        context.diagnostic(`retried stalled pairing requests: ${[...counts]
          .map(([path, count]) => `${path} x${count}`)
          .join(', ')}`);
      }
      return { evidence: JSON.stringify(report), received, report };
    } finally {
      // A stalled request is still holding its socket, and `close` alone waits
      // for it.
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  };

  it('negotiates and transparently decodes zstd through defaultSession.fetch', {
    timeout: stallTestTimeoutMs,
  }, async context => {
    if ('skipReason' in setup) {
      context.skip(setup.skipReason);
      return;
    }

    const { evidence, received, report } = await runProbe({
      budgetMs: stallBudgetMs,
      context,
    });

    for (const { acceptEncoding, path } of received) {
      assert.match(
        acceptEncoding ?? '',
        /(?:^|,\s*)zstd(?:\s*,|$)/u,
        `${path} did not negotiate zstd: ${String(acceptEncoding)}`,
      );
    }
    // Path coverage rather than a request count: a retried stall repeats one
    // path, and a missing path names the endpoint that never completed.
    assert.deepEqual(
      [...new Set(received.map(({ path }) => path))].sort(),
      pairingPaths,
      `Electron did not reach every pairing endpoint: ${evidence}`,
    );
    assert.deepEqual(report.valid, {
      kind: 'success',
      responseEncoding: 'zstd',
      responseLength: String(compressed.byteLength),
      value: expectedValue,
    }, `the valid endpoint did not decode: ${evidence}`);
    assert.equal(report.decodedOverLimit.kind, 'invalid_response', evidence);
    assert.equal(report.decodedOverLimit.responseEncoding, 'zstd');
    assert.equal(report.decodedOverLimit.responseLength, String(decodedOverLimit.byteLength));
    assert.ok(['invalid_response', 'network'].includes(report.truncated.kind), evidence);
    assert.equal(report.truncated.responseEncoding, 'zstd');
    assert.doesNotMatch(report.truncated.message, /zstd|decompress|decoder/u);
    assert.equal(report.stacked.kind, 'invalid_response', evidence);
    assert.equal(report.stacked.responseEncoding, 'zstd, gzip');
  });

  // The failure this budget exists for: a worker swallowed five straight
  // requests and then served the sixth at once, and a per-run retry count was
  // spent by the first endpoint to stall — so the three endpoints behind it
  // were reported as unreachable rather than retried. Five is what that run
  // did; the budget leaves room for the worker to stall on its own account too.
  const stalledRequests = 5;
  const regressionBudgetMs = 20_000;
  // The smaller half of the unit's ceiling: this case reproduces the outage in
  // about ten seconds and does not need the room the real coverage above does.
  const regressionTestTimeoutMs = 60_000;

  it('outlives a worker that swallows the first requests and then recovers', {
    timeout: regressionTestTimeoutMs,
  }, async context => {
    if ('skipReason' in setup) {
      context.skip(setup.skipReason);
      return;
    }

    const { evidence, received, report } = await runProbe({
      budgetMs: regressionBudgetMs,
      context,
      stalledRequests,
    });

    assert.deepEqual(
      [...new Set(received.map(({ path }) => path))].sort(),
      pairingPaths,
      `a recovered worker left pairing endpoints unreached: ${evidence}`,
    );
    // Every swallowed request is a stall, and they all land on the first
    // endpoint: the budget is shared, so retrying it does not disarm the rest.
    assert.deepEqual(report.stalls, Array(stalledRequests).fill('/valid'), evidence);
    assert.equal(report.valid.kind, 'success', evidence);
    assert.equal(report.stacked.kind, 'invalid_response', evidence);
  });
});
