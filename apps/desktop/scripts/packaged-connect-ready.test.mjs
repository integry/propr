import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  createConnectReadyPublisher,
  createConnectReadyRecord,
  isExactConnectReadyRecord,
} from './packaged-connect-ready.mjs';
import { runPackagedConnectLifecycle } from './packaged-connect-lifecycle.mjs';

const expected = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  authorityMechanism: 'inherited-standard-handle',
});
const record = () => createConnectReadyRecord({
  ...expected,
  timestamp: '2026-09-02T15:27:57.000Z',
});

describe('packaged Connect READY fd-1 publisher', () => {
  test('completes partial writes and publishes one exact UTF-8 line', () => {
    const chunks = [];
    const publisher = createConnectReadyPublisher({
      writeSync(fd, bytes, offset, length) {
        assert.equal(fd, 1);
        const progress = Math.min(7, length);
        chunks.push(Buffer.from(bytes.subarray(offset, offset + progress)));
        return progress;
      },
    });
    const result = publisher.publish(record(), expected);
    assert.equal(result.ok, true);
    const output = Buffer.concat(chunks).toString('utf8');
    assert.equal(output.endsWith('\n'), true);
    assert.equal(output.slice(0, -1).includes('\n'), false);
    assert.equal(isExactConnectReadyRecord(JSON.parse(output), expected), true);
  });

  test('classifies zero progress without retrying indefinitely', () => {
    let calls = 0;
    const result = createConnectReadyPublisher({
      writeSync() { calls += 1; return 0; },
    }).publish(record(), expected);
    assert.deepEqual(result, { ok: false, category: 'zero-progress' });
    assert.equal(calls, 1);
  });

  test('classifies a broken pipe without exposing exception text', () => {
    const result = createConnectReadyPublisher({
      writeSync() { throw new Error('private-pipe-path-SENTINEL'); },
    }).publish(record(), expected);
    assert.deepEqual(result, { ok: false, category: 'broken-pipe' });
    assert.doesNotMatch(JSON.stringify(result), /private|SENTINEL/u);
  });

  test('rejects a duplicate publication and writes no duplicate bytes', () => {
    const chunks = [];
    const publisher = createConnectReadyPublisher({
      writeSync(_fd, bytes, offset, length) {
        chunks.push(Buffer.from(bytes.subarray(offset, offset + length)));
        return length;
      },
    });
    assert.equal(publisher.publish(record(), expected).ok, true);
    assert.deepEqual(publisher.publish(record(), expected), { ok: false, category: 'duplicate' });
    assert.equal(Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').length, 1);
  });

  test('rejects the wrong schema before writing fd 1', () => {
    let called = false;
    const publisher = createConnectReadyPublisher({
      writeSync() { called = true; return 1; },
    });
    assert.deepEqual(publisher.publish({ ...record(), rendererSchemaValid: 'true' }, expected), {
      ok: false,
      category: 'schema',
    });
    assert.equal(called, false);
  });

  test('rejects the exact record before writing when the byte bound is exceeded', () => {
    let called = false;
    const result = createConnectReadyPublisher({
      maximumBytes: 1,
      writeSync() { called = true; return 1; },
    }).publish(record(), expected);
    assert.deepEqual(result, { ok: false, category: 'byte-bound' });
    assert.equal(called, false);
  });

  test('keeps the native pipe regression in front of the real packaged lifecycle', () => {
    const smoke = readFileSync(fileURLToPath(new URL('./smoke-packaged-connect.mjs', import.meta.url)), 'utf8');
    const regression = smoke.indexOf('await verifyNativeWindowsReadyPipeRegression({ treeKillerPath });');
    const lifecycle = smoke.indexOf('outcome = await runPackagedConnectLifecycle({');
    assert.ok(regression !== -1 && regression < lifecycle);
    assert.doesNotMatch(smoke.slice(lifecycle, smoke.indexOf('  });', lifecycle)), /readyTimeoutMs/u);
    const lifecycleSource = readFileSync(
      fileURLToPath(new URL('./packaged-connect-lifecycle.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(lifecycleSource, /readyTimeoutMs = 240_000/u);
  });
});

const windowsTreeKiller = process.platform === 'win32' && process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
  : undefined;
const childFixture = fileURLToPath(new URL('./packaged-connect-ready-child.mjs', import.meta.url));

describe('native Windows inherited READY pipe', { skip: process.platform !== 'win32' }, () => {
  const nativeExpected = {
    platform: 'win32',
    arch: process.arch,
    authorityMechanism: 'inherited-standard-handle',
  };
  const runNative = behavior => runPackagedConnectLifecycle({
    binaryPath: process.execPath,
    args: [childFixture, behavior],
    env: {},
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    ...nativeExpected,
    treeKillerPath: windowsTreeKiller,
    readyTimeoutMs: 5_000,
    shutdownGraceMs: 100,
    terminationTimeoutMs: 5_000,
    streamDrainTimeoutMs: 2_000,
  });

  test('receives one exact line from an actual child and closes cleanly', async () => {
    const result = await runNative('clean');
    assert.deepEqual(result, {
      ok: true,
      category: 'ready-clean-exit',
      capture: 'complete',
      records: [{ event: 'desktop.renderer.connect_discovery.ready' }],
    });
  });

  test('terminates but rejects a child that remains alive after READY', async () => {
    const result = await runNative('remain-alive');
    assert.equal(result.ok, false);
    assert.equal(result.category, 'child-remained-alive');
    assert.equal(result.secondary, undefined);
  });
});
