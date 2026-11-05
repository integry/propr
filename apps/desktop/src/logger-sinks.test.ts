import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createDesktopLogger, type LogLevel } from './logger';

type ConsoleMethodName = 'log' | 'warn' | 'error';

const CONSOLE_METHOD_FOR_LEVEL: Record<LogLevel, ConsoleMethodName> = {
  debug: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

const syncWriteError = (code: 'ENOSPC' | 'EPIPE'): NodeJS.ErrnoException => Object.assign(
  new Error(`${code}: simulated synchronous console write failure, write`),
  { code, errno: code === 'ENOSPC' ? -28 : -32, syscall: 'write' },
);

const waitFor = async (condition: () => Promise<boolean> | boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

const readLogLines = async (logPath: string): Promise<Array<Record<string, unknown>>> => {
  const content = await readFile(logPath, 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
};

describe('desktop logger sinks', () => {
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const consoleCalls: Array<{ method: ConsoleMethodName; line: string }> = [];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => { unhandledRejections.push(reason); };
  let directory = '';

  const recordConsole = (method: ConsoleMethodName, failure?: NodeJS.ErrnoException) => {
    console[method] = (line: string) => {
      consoleCalls.push({ method, line });
      if (failure) throw failure;
    };
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'propr-desktop-logger-'));
    consoleCalls.length = 0;
    unhandledRejections.length = 0;
    process.on('unhandledRejection', onUnhandledRejection);
    for (const method of ['log', 'warn', 'error'] as const) recordConsole(method);
  });

  afterEach(async () => {
    Object.assign(console, originalConsole);
    process.off('unhandledRejection', onUnhandledRejection);
    await rm(directory, { recursive: true, force: true });
  });

  it('writes each level to its console method and to a private log file', async () => {
    const logPath = join(directory, 'logs', 'desktop.log');
    const logger = createDesktopLogger(logPath);
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    for (const level of levels) logger.log(level, `desktop.test.${level}`, { detail: 'value' });

    assert.deepEqual(consoleCalls.map(call => call.method), levels.map(level => CONSOLE_METHOD_FOR_LEVEL[level]));
    await waitFor(async () => (await readLogLines(logPath)).length === levels.length, 'file sink records');
    const records = await readLogLines(logPath);
    assert.deepEqual(records.map(record => [record.level, record.event, record.detail]),
      levels.map(level => [level, `desktop.test.${level}`, 'value']));
    assert.deepEqual(consoleCalls.map(call => call.line), (await readFile(logPath, 'utf8')).trimEnd().split('\n'));
    if (process.platform !== 'win32') {
      assert.equal((await stat(logPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, 'logs'))).mode & 0o777, 0o700);
    }
  });

  for (const code of ['ENOSPC', 'EPIPE'] as const) {
    it(`contains synchronous ${code} console failures and still writes the file sink`, async () => {
      for (const method of ['log', 'warn', 'error'] as const) recordConsole(method, syncWriteError(code));
      const logPath = join(directory, 'desktop.log');
      const logger = createDesktopLogger(logPath);
      const levels: LogLevel[] = ['info', 'warn', 'error', 'debug'];

      for (const level of levels) {
        assert.doesNotThrow(() => logger.log(level, 'desktop.credentials.decision', {
          token: { secret: 'never-logged' },
          reason: new Error('/home/user/secret-path'),
        }));
      }

      assert.equal(consoleCalls.length, levels.length);
      await waitFor(async () => (await readLogLines(logPath)).length === levels.length, 'file sink records');
      const records = await readLogLines(logPath);
      assert.deepEqual(records.map(record => record.level), levels);
      for (const record of records) {
        assert.deepEqual(record.token, { code: 'DETAIL_REDACTED' });
        assert.deepEqual(record.reason, { code: 'OPERATION_FAILED' });
      }
      assert.doesNotMatch(await readFile(logPath, 'utf8'), /never-logged|secret-path/);
      assert.deepEqual(unhandledRejections, []);
    });
  }

  it('contains a failed append whose fallback console and failure hook also throw', async () => {
    const blockingFile = join(directory, 'not-a-directory');
    await writeFile(blockingFile, '');
    recordConsole('log', syncWriteError('ENOSPC'));
    recordConsole('error', syncWriteError('EPIPE'));
    let writeFailures = 0;
    const logger = createDesktopLogger(join(blockingFile, 'desktop.log'), () => {
      writeFailures += 1;
      throw new Error('smoke sink unavailable');
    });

    assert.doesNotThrow(() => logger.log('info', 'desktop.test.first'));
    assert.doesNotThrow(() => logger.log('error', 'desktop.test.second'));
    await waitFor(() => consoleCalls.filter(call => call.line.includes('desktop.log.write_failed')).length === 2,
      'fallback console attempts');
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(writeFailures, 2);
    assert.deepEqual(consoleCalls.map(call => call.method), ['log', 'error', 'error', 'error']);
    assert.deepEqual(JSON.parse(consoleCalls[2]!.line),
      { level: 'error', event: 'desktop.log.write_failed', code: 'LOG_WRITE_FAILED' });
    assert.deepEqual(unhandledRejections, []);
  });

  it('keeps writing later records after a console failure recovers', async () => {
    const logPath = join(directory, 'desktop.log');
    const logger = createDesktopLogger(logPath);
    recordConsole('warn', syncWriteError('ENOSPC'));
    logger.log('warn', 'desktop.test.during_failure');
    recordConsole('warn');
    logger.log('warn', 'desktop.test.after_recovery');

    await waitFor(async () => (await readLogLines(logPath)).length === 2, 'file sink records');
    assert.deepEqual((await readLogLines(logPath)).map(record => record.event),
      ['desktop.test.during_failure', 'desktop.test.after_recovery']);
    assert.equal(consoleCalls.length, 2);
  });
});
