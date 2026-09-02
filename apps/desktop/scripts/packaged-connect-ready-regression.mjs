import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECT_READY_EVENT,
  createConnectReadyPublisher,
  createConnectReadyRecord,
  isExactConnectReadyRecord,
} from './packaged-connect-ready.mjs';
import { runPackagedConnectLifecycle } from './packaged-connect-lifecycle.mjs';

const childFixture = fileURLToPath(new URL('./packaged-connect-ready-child.mjs', import.meta.url));

/** Run inside the ordinary-user Windows gate so Node owns the actual inherited pipe. */
export const verifyNativeWindowsReadyPipeRegression = async ({ treeKillerPath }) => {
  if (process.platform !== 'win32') return;
  const expected = {
    platform: process.platform,
    arch: process.arch,
    authorityMechanism: 'inherited-standard-handle',
  };
  const record = createConnectReadyRecord(expected);
  const chunks = [];
  const partial = createConnectReadyPublisher({
    writeSync(_descriptor, bytes, offset, length) {
      const progress = Math.min(7, length);
      chunks.push(Buffer.from(bytes.subarray(offset, offset + progress)));
      return progress;
    },
  });
  if (!partial.publish(record, expected).ok) {
    throw new Error('Native Windows READY partial-write regression failed');
  }
  const partialOutput = Buffer.concat(chunks).toString('utf8');
  let parsedPartial;
  try { parsedPartial = JSON.parse(partialOutput); } catch { /* Fixed failure below. */ }
  if (!partialOutput.endsWith('\n') || partialOutput.slice(0, -1).includes('\n')
    || !isExactConnectReadyRecord(parsedPartial, expected)) {
    throw new Error('Native Windows READY partial-write regression failed');
  }
  const zeroProgress = createConnectReadyPublisher({ writeSync: () => 0 }).publish(record, expected);
  if (zeroProgress.ok || zeroProgress.category !== 'zero-progress') {
    throw new Error('Native Windows READY zero-progress regression failed');
  }
  const brokenPipe = createConnectReadyPublisher({
    writeSync() { throw new Error('discarded'); },
  }).publish(record, expected);
  if (brokenPipe.ok || brokenPipe.category !== 'broken-pipe') {
    throw new Error('Native Windows READY broken-pipe regression failed');
  }
  const duplicateBytes = [];
  const duplicate = createConnectReadyPublisher({
    writeSync(_descriptor, bytes, offset, length) {
      duplicateBytes.push(Buffer.from(bytes.subarray(offset, offset + length)));
      return length;
    },
  });
  if (!duplicate.publish(record, expected).ok
    || duplicate.publish(record, expected).category !== 'duplicate'
    || Buffer.concat(duplicateBytes).toString('utf8').trimEnd().split('\n').length !== 1) {
    throw new Error('Native Windows READY duplicate regression failed');
  }
  let invalidWriteAttempted = false;
  const wrongSchema = createConnectReadyPublisher({
    writeSync() { invalidWriteAttempted = true; return 1; },
  }).publish({ ...record, rendererSchemaValid: 'true' }, expected);
  if (wrongSchema.ok || wrongSchema.category !== 'schema' || invalidWriteAttempted) {
    throw new Error('Native Windows READY schema regression failed');
  }
  const run = behavior => runPackagedConnectLifecycle({
    binaryPath: process.execPath,
    args: [childFixture, behavior],
    env: {},
    cwd: dirname(childFixture),
    ...expected,
    treeKillerPath,
    readyTimeoutMs: 5_000,
    shutdownGraceMs: 100,
    terminationTimeoutMs: 5_000,
    streamDrainTimeoutMs: 2_000,
  });
  const clean = await run('clean');
  if (!clean.ok || clean.category !== 'ready-clean-exit'
    || clean.capture !== 'complete'
    || clean.records.length !== 1
    || clean.records[0]?.event !== CONNECT_READY_EVENT) {
    throw new Error('Native Windows READY pipe clean-close regression failed');
  }
  const remainedAlive = await run('remain-alive');
  if (remainedAlive.ok || remainedAlive.category !== 'child-remained-alive'
    || remainedAlive.secondary !== undefined) {
    throw new Error('Native Windows READY pipe live-child regression failed');
  }
};
