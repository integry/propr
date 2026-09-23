import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { before, describe, it } from 'node:test';
import { prepareNativeElectronTest } from './electron-native-test-setup.mjs';

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'electron-pairing-zstd-probe.cjs');

const runFixture = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.once('error', error => {
    clearTimeout(timer);
    rejectRun(error);
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) {
      rejectRun(new Error(`Electron zstd fixture failed (${String(code ?? signal)}): ${stderr.slice(-2_000)}`));
      return;
    }
    const reportLine = stdout.trim().split(/\r?\n/u).findLast(line => line.startsWith('{'));
    if (!reportLine) {
      rejectRun(new Error(`Electron zstd fixture did not report evidence: ${stderr.slice(-2_000)}`));
      return;
    }
    resolveRun(JSON.parse(reportLine));
  });
});

describe('Electron pairing response compression', () => {
  let setup;
  // A cold Electron download belongs to setup, not the fixture's 25s budget.
  before(() => {
    // This probe uses only the main-process Session API, so Chromium's native
    // headless backend is sufficient when a Linux worker has no display.
    setup = prepareNativeElectronTest({ allowHeadlessLinux: true });
  }, { timeout: 120_000 });

  // The budget covers the probe's own bounded retries of a stalled loopback
  // request, which each cost the client's fixed header deadline.
  it('negotiates and transparently decodes zstd through defaultSession.fetch', {
    timeout: 40_000,
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
      const report = setup.xvfbRun
        ? await runFixture(setup.xvfbRun, ['--auto-servernum', setup.electronExecutable, ...electronArguments])
        : await runFixture(setup.electronExecutable, electronArguments);

      const evidence = JSON.stringify(report);
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
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
      });
    }
  });
});
