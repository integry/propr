import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { before, describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-pairing-zstd-probe.cjs');

// The probe makes four sequential pairing requests, each bounded by the
// protocol's own fixed 8s header deadline. The budget covers all four so a
// stalled worker is reported as the stall it is, never as an opaque kill.
const FIXTURE_TIMEOUT_MS = 40_000;
// A contended shared runner can starve the probe or this server past those
// deadlines, so a request is abandoned before it is ever accepted. That is
// transport evidence rather than a behaviour change, and one clean retry keeps
// every assertion below strict without failing the shard for the contention.
const FIXTURE_ATTEMPTS = 2;

const PROBE_PATHS = ['/valid', '/decoded-over-limit', '/truncated', '/stacked'];

const runFixture = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, FIXTURE_TIMEOUT_MS);
  child.once('error', error => {
    clearTimeout(timer);
    rejectRun(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      resolveRun({ timedOut: true });
      return;
    }
    if (code !== 0) {
      rejectRun(new Error(`Electron zstd fixture failed (${String(code ?? signal)}): ${stderr.slice(-2_000)}`));
      return;
    }
    const reportLine = stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{'));
    if (!reportLine) {
      rejectRun(new Error(`Electron zstd fixture did not report evidence: ${stderr.slice(-2_000)}`));
      return;
    }
    resolveRun({ report: JSON.parse(reportLine) });
  });
});

describe('Electron pairing response compression', () => {
  let setup;
  // A cold Electron download belongs to setup, not the fixture's own budget.
  before(() => {
    // This probe uses only the main-process Session API, so Chromium's native
    // headless backend is sufficient when a Linux worker has no display.
    setup = prepareNativeElectronTest({ allowHeadlessLinux: true });
  }, { timeout: 120_000 });

  it('negotiates and transparently decodes zstd through defaultSession.fetch', {
    timeout: 120_000,
  }, async context => {
    if ('skipReason' in setup) {
      context.skip(setup.skipReason);
      return;
    }

    const expected = { status: 'approved', transport: 'native-electron-zstd' };
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(expected)));
    const decodedOverLimit = zstdCompressSync(Buffer.from(JSON.stringify({
      value: 'A'.repeat(4_097),
    })));
    let requests = [];
    const server = createServer((request, response) => {
      requests.push({ url: request.url, acceptEncoding: request.headers['accept-encoding'] });
      const body = request.url === '/decoded-over-limit'
        ? decodedOverLimit
        : request.url === '/truncated'
          ? compressed.subarray(0, Math.floor(compressed.byteLength / 2))
          : compressed;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': request.url === '/stacked' ? 'zstd, gzip' : 'zstd',
        'Content-Length': String(body.byteLength),
      });
      response.end(body);
    });
    // The probe sends all four requests over one keep-alive connection. Closing
    // it on the default idle timeout would race a request that a busy worker
    // delayed, losing it for a reason that has nothing to do with zstd.
    server.keepAliveTimeout = 0;
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const electronArguments = [
        ...(process.platform === 'linux' ? [
          '--no-sandbox',
          '--disable-gpu',
          ...('headlessLinux' in setup ? ['--headless', '--ozone-platform=headless'] : []),
        ] : []),
        fixture,
        `http://127.0.0.1:${address.port}/valid`,
      ];

      for (let attempt = 1; attempt <= FIXTURE_ATTEMPTS; attempt += 1) {
        requests = [];
        const outcome = setup.xvfbRun
          ? await runFixture(setup.xvfbRun, ['--auto-servernum', setup.electronExecutable, ...electronArguments])
          : await runFixture(setup.electronExecutable, electronArguments);
        const served = requests.map(request => request.url);
        const unserved = PROBE_PATHS.filter(path => !served.includes(path));
        // This server answers every request immediately, so an expired pairing
        // deadline can only mean the request or its response was held up off
        // the wire. None of the four expected outcomes below is a timeout.
        const expiredDeadlines = Object.entries(outcome.report ?? {})
          .filter(([, result]) => result?.kind === 'timeout')
          .map(([probe]) => probe);
        // Only a request that was never served in time is read as worker
        // contention. Everything the probe did exchange is asserted below, on
        // this attempt, so no behaviour difference can be retried away.
        const contention = outcome.timedOut
          ? `the probe exceeded its ${FIXTURE_TIMEOUT_MS}ms budget after serving ${JSON.stringify(served)}`
          : unserved.length > 0
            ? `${JSON.stringify(unserved)} never reached the test server`
            : expiredDeadlines.length > 0
              ? `the pairing deadline expired on ${JSON.stringify(expiredDeadlines)}`
              : undefined;
        if (contention) {
          if (attempt < FIXTURE_ATTEMPTS) {
            context.diagnostic(`Retrying the Electron zstd probe: ${contention}`);
            continue;
          }
          assert.fail(`The Electron zstd probe never completed its pairing requests: ${contention}`);
        }

        const { report } = outcome;
        assert.deepEqual(served, PROBE_PATHS);
        for (const { acceptEncoding } of requests) {
          assert.match(acceptEncoding ?? '', /(?:^|,\s*)zstd(?:\s*,|$)/u);
        }
        assert.deepEqual(report.valid, {
          kind: 'success',
          responseEncoding: 'zstd',
          responseLength: String(compressed.byteLength),
          value: expected,
        });
        assert.equal(report.decodedOverLimit.kind, 'invalid_response');
        assert.equal(report.decodedOverLimit.responseEncoding, 'zstd');
        assert.equal(report.decodedOverLimit.responseLength, String(decodedOverLimit.byteLength));
        assert.ok(['invalid_response', 'network'].includes(report.truncated.kind));
        assert.equal(report.truncated.responseEncoding, 'zstd');
        assert.doesNotMatch(report.truncated.message, /zstd|decompress|decoder/u);
        assert.equal(report.stacked.kind, 'invalid_response');
        assert.equal(report.stacked.responseEncoding, 'zstd, gzip');
        return;
      }
    } finally {
      // keepAliveTimeout is disabled above, so an idle connection the probe
      // left behind must be closed here for the server to settle.
      server.closeAllConnections();
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
