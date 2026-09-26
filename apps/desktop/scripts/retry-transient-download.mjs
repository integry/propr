#!/usr/bin/env node

// electron-forge fetches the Electron runtime archive and native dependency headers from the
// Electron release endpoints on every cache miss, and `npm ci` fetches the locked tarballs from
// the registry. Those downloads fail transiently (`fetch failed`, reset sockets, read timeouts,
// 5xx) often enough to fail otherwise-green matrix legs, so retry the whole wrapped command for
// that failure class only. Any failure without a transient download signature - a real build,
// test, packaging, or lockfile defect - exits on the first attempt.

import { spawn as nodeSpawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 15_000;
const MAX_CAPTURED_BYTES = 256 * 1024;

export const TRANSIENT_DOWNLOAD_PATTERNS = [
  /fetch failed/i,
  /socket hang up/i,
  /network (?:timeout|error)/i,
  /(?:failed|unable) to download/i,
  /\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|EPIPE|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT))\b/,
  // `@electron/get` surfaces release-endpoint outages as `HTTPError: Response code 500 (...)`,
  // where `HTTP` carries no trailing word boundary, so match the reported code phrase too.
  /\b(?:status|statusCode|HTTP|response code)\b[^\n]{0,20}\b5\d{2}\b/i,
  /getaddrinfo/i,
];

export const isTransientDownloadFailure = output =>
  TRANSIENT_DOWNLOAD_PATTERNS.some(pattern => pattern.test(output));

const createBoundedTail = () => {
  const chunks = [];
  let bytes = 0;
  return {
    append(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(value);
      bytes += value.length;
      while (bytes > MAX_CAPTURED_BYTES && chunks.length > 1) bytes -= chunks.shift().length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
};

const runOnce = ({ command, arguments: commandArguments, spawn, output, stdout, stderr }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, {
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('error', reject);
    child.stdout?.on('data', chunk => { output.append(chunk); stdout.write(chunk); });
    child.stderr?.on('data', chunk => { output.append(chunk); stderr.write(chunk); });
    child.once('close', (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });

export const runWithTransientDownloadRetries = async ({
  command,
  arguments: commandArguments = [],
  attempts = DEFAULT_ATTEMPTS,
  backoffMs = DEFAULT_BACKOFF_MS,
  spawn = nodeSpawn,
  delay = sleep,
  stdout = process.stdout,
  stderr = process.stderr,
  log = message => stderr.write(`${message}\n`),
}) => {
  if (typeof command !== 'string' || command.length === 0
    || !Array.isArray(commandArguments) || !commandArguments.every(value => typeof value === 'string')
    || !Number.isInteger(attempts) || attempts < 1
    || !Number.isInteger(backoffMs) || backoffMs < 0) {
    throw new Error('invalid-retry-input');
  }

  for (let attempt = 1; ; attempt += 1) {
    const output = createBoundedTail();
    const exitCode = await runOnce({
      command, arguments: commandArguments, spawn, output, stdout, stderr,
    });
    if (exitCode === 0) return 0;
    if (attempt >= attempts) {
      log(`Command failed after ${attempt} attempt(s); giving up.`);
      return exitCode;
    }
    if (!isTransientDownloadFailure(output.text())) {
      log('Command failed without a transient download signature; not retrying.');
      return exitCode;
    }
    const delayMs = attempt * backoffMs;
    log(`Attempt ${attempt} failed while downloading; retrying in ${Math.round(delayMs / 1000)} seconds...`);
    await delay(delayMs);
  }
};

export const parseCli = argv => {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) throw new Error('invalid-cli');
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const parsed = { attempts: DEFAULT_ATTEMPTS, backoffMs: DEFAULT_BACKOFF_MS };
  for (let index = 0; index < options.length; index += 2) {
    const value = options[index + 1];
    if (value === undefined) throw new Error('invalid-cli');
    if (options[index] === '--attempts') parsed.attempts = Number(value);
    else if (options[index] === '--backoff-ms') parsed.backoffMs = Number(value);
    else throw new Error('invalid-cli');
  }
  return { ...parsed, command: command[0], arguments: command.slice(1) };
};

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    process.exitCode = await runWithTransientDownloadRetries(parseCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`Retryable command could not run: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
