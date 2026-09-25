import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { before, describe, it } from 'node:test';
import { linuxProbeArguments, runElectronFixture } from './electron-fixture-runner.mjs';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-pairing-zstd-probe.cjs');

describe('Electron pairing response compression', () => {
  let setup;
  // A cold Electron download belongs to setup, not the fixture's own budget.
  before(() => {
    // This probe uses only the main-process Session API, so Chromium's native
    // headless backend is sufficient when a Linux worker has no display.
    setup = prepareNativeElectronTest({ allowHeadlessLinux: true });
  }, { timeout: 120_000 });

  // The fixture budget covers the probe's 45s wait for the default session's
  // network stack to start and its bounded retry of a stalled pairing request,
  // which costs the client's fixed header deadline. The test budget adds the
  // runner's bounded relaunch of a worker that killed the fixture outright.
  it('negotiates and transparently decodes zstd through defaultSession.fetch', {
    timeout: 110_000,
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
    const received = [];
    const server = createServer((request, response) => {
      // The probe's readiness request only proves the network stack is up.
      if (request.url === '/ready') {
        response.writeHead(204).end();
        return;
      }
      received.push({ acceptEncoding: request.headers['accept-encoding'], path: request.url });
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
      const report = await runElectronFixture({
        diagnostic: message => context.diagnostic(message),
        electronArguments: [
          ...(process.platform === 'linux' ? [
            ...linuxProbeArguments,
            ...('headlessLinux' in setup ? ['--headless', '--ozone-platform=headless'] : []),
          ] : []),
          fixture,
          `http://127.0.0.1:${address.port}/valid`,
        ],
        name: 'Electron zstd fixture',
        setup,
        timeout: 80_000,
      });

      const evidence = JSON.stringify(report);
      assert.equal(
        report.readiness?.ready,
        true,
        `Electron's default session never reached the loopback server: ${evidence}`,
      );
      // 8s is the pairing client's header deadline: a start-up this slow would
      // have failed a measured request without the readiness wait.
      if (report.readiness.attempts > 1 || report.readiness.elapsedMs >= 8_000) {
        context.diagnostic(
          `default session needed ${report.readiness.attempts} requests and ${report.readiness.elapsedMs}ms to reach the loopback server`,
        );
      }
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
        ['/decoded-over-limit', '/stacked', '/truncated', '/valid'],
        `Electron did not reach every pairing endpoint: ${evidence}`,
      );
      if (report.stalls.length > 0) {
        context.diagnostic(`retried stalled pairing requests: ${report.stalls.join(', ')}`);
      }
      assert.deepEqual(report.valid, {
        kind: 'success',
        responseEncoding: 'zstd',
        responseLength: String(compressed.byteLength),
        value: expected,
      }, `the valid endpoint did not decode: ${evidence}`);
      assert.equal(report.decodedOverLimit.kind, 'invalid_response', evidence);
      assert.equal(report.decodedOverLimit.responseEncoding, 'zstd');
      assert.equal(report.decodedOverLimit.responseLength, String(decodedOverLimit.byteLength));
      assert.ok(['invalid_response', 'network'].includes(report.truncated.kind), evidence);
      assert.equal(report.truncated.responseEncoding, 'zstd');
      assert.doesNotMatch(report.truncated.message, /zstd|decompress|decoder/u);
      assert.equal(report.stacked.kind, 'invalid_response', evidence);
      assert.equal(report.stacked.responseEncoding, 'zstd, gzip');
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
