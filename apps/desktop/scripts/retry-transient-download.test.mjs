import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
  isTransientDownloadFailure,
  parseCli,
  runWithTransientDownloadRetries,
} from './retry-transient-download.mjs';

const execFileAsync = promisify(execFile);
const retryScript = fileURLToPath(new URL('./retry-transient-download.mjs', import.meta.url));
const shasumsUrl = 'https://github.com/electron/electron/releases/download/v44.0.0/SHASUMS256.txt';

const scriptedSpawn = outcomes => {
  const invocations = [];
  const spawn = (command, commandArguments) => {
    const outcome = outcomes[invocations.length];
    invocations.push({ command, arguments: commandArguments });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout));
      if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr));
      child.emit('close', outcome.exitCode, outcome.signal ?? null);
    });
    return child;
  };
  return { spawn, invocations };
};

const collectingSink = (mirrored) => ({ write: chunk => { mirrored.push(chunk.toString('utf8')); } });

const run = async (outcomes, overrides = {}) => {
  const { spawn, invocations } = scriptedSpawn(outcomes);
  const delays = [];
  const logs = [];
  const mirrored = [];
  const exitCode = await runWithTransientDownloadRetries({
    command: 'npm',
    arguments: ['run', 'make', '--', '--arch=x64'],
    spawn,
    delay: async milliseconds => { delays.push(milliseconds); },
    log: message => logs.push(message),
    stdout: collectingSink(mirrored),
    stderr: collectingSink(mirrored),
    ...overrides,
  });
  return { exitCode, invocations, delays, logs, mirrored };
};

describe('transient download retries', () => {
  test('retries the whole command only while the failure is a transient download', async () => {
    const forgeFailure = 'An unhandled rejection has occurred inside Forge:\nTypeError: fetch failed\n';
    const { exitCode, invocations, delays, mirrored } = await run([
      { exitCode: 1, stderr: forgeFailure },
      { exitCode: 1, stdout: 'Preparing native dependencies [FAILED: fetch failed]' },
      { exitCode: 0, stdout: 'Finalizing package' },
    ]);
    assert.equal(exitCode, 0);
    assert.equal(invocations.length, 3);
    assert.deepEqual(invocations[2], { command: 'npm', arguments: ['run', 'make', '--', '--arch=x64'] });
    assert.deepEqual(delays, [DEFAULT_BACKOFF_MS, 2 * DEFAULT_BACKOFF_MS]);
    assert.deepEqual(mirrored, [forgeFailure, 'Preparing native dependencies [FAILED: fetch failed]', 'Finalizing package']);
  });

  test('fails immediately when the command fails without a download signature', async () => {
    const { exitCode, invocations, delays, logs } = await run([
      { exitCode: 2, stderr: 'error TS2345: Argument of type string is not assignable\n' },
      { exitCode: 0 },
    ]);
    assert.equal(exitCode, 2);
    assert.equal(invocations.length, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(logs, ['Command failed without a transient download signature; not retrying.']);
  });

  test('gives up with the last exit code once the bounded attempts are exhausted', async () => {
    const outcome = { exitCode: 1, stderr: 'request to https://artifacts.electronjs.org failed, reason: socket hang up' };
    const { exitCode, invocations, delays, logs } = await run([outcome, outcome, outcome, { exitCode: 0 }]);
    assert.equal(exitCode, 1);
    assert.equal(invocations.length, DEFAULT_ATTEMPTS);
    assert.deepEqual(delays, [DEFAULT_BACKOFF_MS, 2 * DEFAULT_BACKOFF_MS]);
    assert.deepEqual(logs.at(-1), `Command failed after ${DEFAULT_ATTEMPTS} attempt(s); giving up.`);
  });

  test('runs a successful command exactly once', async () => {
    const { exitCode, invocations, delays, logs } = await run([{ exitCode: 0, stdout: 'done' }]);
    assert.equal(exitCode, 0);
    assert.equal(invocations.length, 1);
    assert.deepEqual(delays, []);
    assert.deepEqual(logs, []);
  });

  test('treats a signalled command as a non-zero result', async () => {
    const { exitCode, invocations } = await run([{ exitCode: null, signal: 'SIGKILL' }]);
    assert.equal(exitCode, 1);
    assert.equal(invocations.length, 1);
  });

  test('recognizes the Electron download failures seen in packaging and rejects unrelated output', () => {
    for (const output of [
      'TypeError: fetch failed',
      'Packaging for x64 on darwin [FAILED: fetch failed]',
      'read ECONNRESET',
      'connect ETIMEDOUT 140.82.121.4:443',
      'getaddrinfo EAI_AGAIN github.com',
      'Failed to download Electron zip',
      'Received status code 503 from the server',
      'UND_ERR_CONNECT_TIMEOUT',
      `HTTPError: Response code 500 (Internal Server Error) for ${shasumsUrl}`,
      `✖ Packaging for x64 on linux [FAILED: Response code 500 (Internal Server Error) for ${shasumsUrl}]`,
      'npm error code ETIMEDOUT\nnpm error syscall read\nnpm error errno -60\nnpm error network read ETIMEDOUT',
    ]) assert.ok(isTransientDownloadFailure(output), `expected transient: ${output}`);

    for (const output of [
      'npm error code 1\nnpm error command failed',
      'error TS2345: Argument of type string is not assignable',
      '✖ 1 test failed',
      'Received status code 404 from the server',
      `HTTPError: Response code 404 (Not Found) for ${shasumsUrl}`,
      'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
      'Packaged darwin desktop icon failed native metadata verification',
    ]) assert.ok(!isTransientDownloadFailure(output), `expected permanent: ${output}`);
  });

  test('retries a locked install interrupted by a registry read timeout, but not a lockfile defect', async () => {
    const registryTimeout = [
      'npm error code ETIMEDOUT',
      'npm error syscall read',
      'npm error errno -60',
      'npm error network read ETIMEDOUT',
      'npm error network This is a problem related to network connectivity.',
      '',
    ].join('\n');
    const install = { command: 'npm', arguments: ['ci'] };
    const timedOut = await run([
      { exitCode: 196, stderr: registryTimeout },
      { exitCode: 0, stdout: 'added 1841 packages' },
    ], install);
    assert.equal(timedOut.exitCode, 0);
    assert.equal(timedOut.invocations.length, 2);
    assert.deepEqual(timedOut.invocations[1], install);
    assert.deepEqual(timedOut.delays, [DEFAULT_BACKOFF_MS]);

    const outOfSync = await run([
      { exitCode: 1, stderr: 'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.\n' },
      { exitCode: 0 },
    ], install);
    assert.equal(outOfSync.exitCode, 1);
    assert.equal(outOfSync.invocations.length, 1);
    assert.deepEqual(outOfSync.logs, ['Command failed without a transient download signature; not retrying.']);
  });

  test('parses the command after the first separator and keeps nested separators', () => {
    assert.deepEqual(parseCli(['--attempts', '2', '--backoff-ms', '0', '--', 'npm', 'run', 'make', '--', '--arch=x64']), {
      attempts: 2,
      backoffMs: 0,
      command: 'npm',
      arguments: ['run', 'make', '--', '--arch=x64'],
    });
    assert.deepEqual(parseCli(['--', 'npm', 'run', 'desktop:package']), {
      attempts: DEFAULT_ATTEMPTS,
      backoffMs: DEFAULT_BACKOFF_MS,
      command: 'npm',
      arguments: ['run', 'desktop:package'],
    });
    for (const argv of [[], ['--'], ['--attempts', '--', 'npm'], ['--unknown', '1', '--', 'npm']]) {
      assert.throws(() => parseCli(argv), /invalid-cli/);
    }
  });

  test('rejects invalid retry bounds', async () => {
    for (const overrides of [{ attempts: 0 }, { backoffMs: -1 }, { command: '' }, { arguments: [1] }]) {
      await assert.rejects(
        runWithTransientDownloadRetries({
          command: 'npm',
          arguments: [],
          spawn: () => new EventEmitter(),
          stdout: collectingSink([]),
          stderr: collectingSink([]),
          ...overrides,
        }),
        /invalid-retry-input/,
      );
    }
  });

  test('retries a real transient child process and preserves the final exit code', async () => {
    const child = [
      "const fs = require('node:fs');",
      'const path = process.argv[1];',
      "const attempt = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) + 1 : 1;",
      'fs.writeFileSync(path, String(attempt));',
      "if (attempt < 2) { console.error('TypeError: fetch failed'); process.exit(1); }",
      "console.log('packaged');",
    ].join('\n');
    const counter = join(await mkdtemp(join(tmpdir(), 'propr-retry-')), 'attempts.txt');
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        retryScript, '--attempts', '3', '--backoff-ms', '0', '--', process.execPath, '-e', child, counter,
      ]);
      assert.match(stdout, /packaged/);
      assert.equal(await readFile(counter, 'utf8'), '2');
    } finally {
      await rm(dirname(counter), { recursive: true, force: true });
    }

    await assert.rejects(execFileAsync(process.execPath, [
      retryScript, '--attempts', '2', '--backoff-ms', '0', '--', process.execPath, '-e', "process.exit(3)",
    ]), error => error.code === 3);
  });
});
