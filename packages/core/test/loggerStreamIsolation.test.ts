import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const here = resolve(fileURLToPath(import.meta.url), '..');
const tsx = resolve(here, '../../../node_modules/.bin/tsx');
const loggerModule = resolve(here, '../src/utils/logger.ts');
const workspace = mkdtempSync(join(tmpdir(), 'propr-logger-stream-'));

after(() => rmSync(workspace, { force: true, recursive: true }));

// pino writes from its own pino-pretty transport worker, so it does not share
// the main thread's write ordering on whichever descriptor it is given. When
// node:test owns the child's stdout as a v8-serialized report channel, a log
// line landing inside a half-written frame fails the whole file with an
// uncaught "Unable to deserialize cloned data" and no test at fault.
const emitLog = (testRunnerContext: string | undefined): { stdout: string; stderr: string } => {
    const script = join(workspace, `emit-${testRunnerContext ?? 'none'}.ts`);
    writeFileSync(script, [
        `import logger from ${JSON.stringify(loggerModule)};`,
        'logger.info("propr logger stream probe");',
        '',
    ].join('\n'));
    const environment: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: 'info', NODE_ENV: 'test' };
    if (testRunnerContext === undefined) delete environment.NODE_TEST_CONTEXT;
    else environment.NODE_TEST_CONTEXT = testRunnerContext;
    const result = spawnSync(tsx, [script], { encoding: 'utf8', env: environment, timeout: 60_000 });
    assert.equal(result.status, 0, `logger probe failed: ${result.stderr}`);
    return { stdout: result.stdout, stderr: result.stderr };
};

describe('core logger stream isolation', () => {
    test('keeps stdout free of log output under the node:test runner', () => {
        const { stdout, stderr } = emitLog('child-v8');
        assert.doesNotMatch(stdout, /propr logger stream probe/u);
        assert.match(stderr, /propr logger stream probe/u);
    });

    test('still logs to stdout outside the runner', () => {
        const { stdout } = emitLog(undefined);
        assert.match(stdout, /propr logger stream probe/u);
    });
});
