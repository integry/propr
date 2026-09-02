#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
  process.stderr.write('Windows authority batch regression requires native win32-x64 or win32-arm64.\n');
  process.exit(1);
}

const {
  parseWindowsBrokerDocument,
  runWindowsInspectionBrokerBatch,
  WINDOWS_INSPECTION_SOURCE,
  WindowsNativeStageError,
} = await import('../../../packages/cli/dist/connectWindowsAuthority.js');

const systemRoot = process.env.SystemRoot;
assert.match(systemRoot ?? '', /^[A-Za-z]:\\/u);
const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const environment = { SystemRoot: systemRoot, WINDIR: systemRoot };
const directory = mkdtempSync(join(tmpdir(), 'propr-authority-batch-'));
const descriptors = [];
const livePids = new Set();

const argumentsFor = source => [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64'),
];

const startPowerShell = (source, fd) => {
  const child = spawn(executable, argumentsFor(source), {
    shell: false,
    windowsHide: true,
    cwd: dirname(executable),
    env: environment,
    stdio: [fd, 'pipe', 'pipe'],
  });
  if (Number.isSafeInteger(child.pid)) livePids.add(child.pid);
  child.once('close', () => livePids.delete(child.pid));
  return child;
};

const assertStage = async (promise, stage) => {
  await assert.rejects(
    promise,
    error => error instanceof WindowsNativeStageError && error.stage === stage,
  );
  assert.equal(livePids.size, 0, `${stage} left a broker process alive`);
};

try {
  for (let index = 0; index < 4; index += 1) {
    const path = join(directory, `target-${index}`);
    writeFileSync(path, `fixture-${index}`);
    descriptors.push(openSync(path, 'r'));
  }

  const deliberatelySlowInspector = `Start-Sleep -Milliseconds 1500\n${WINDOWS_INSPECTION_SOURCE}`;
  const started = performance.now();
  const slow = await runWindowsInspectionBrokerBatch({
    entryCount: descriptors.length,
    startBroker: index => startPowerShell(deliberatelySlowInspector, descriptors[index]),
    deadlineMs: 60_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
  });
  assert.equal(slow.length, descriptors.length);
  slow.forEach(output => parseWindowsBrokerDocument(output));
  assert.ok(performance.now() - started < 60_000, 'slow brokers exceeded one wall-clock bound');
  assert.equal(livePids.size, 0, 'successful slow batch left a broker process alive');

  const reorderedSources = [80, 10, 45].map((delay, index) => (
    `Start-Sleep -Milliseconds ${delay};[Console]::Out.Write('${index}')`
  ));
  const reordered = await runWindowsInspectionBrokerBatch({
    entryCount: reorderedSources.length,
    startBroker: index => startPowerShell(reorderedSources[index], descriptors[index]),
    deadlineMs: 60_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  });
  assert.deepEqual(reordered.map(output => output.toString('utf8')), ['0', '1', '2']);
  assert.equal(livePids.size, 0, 'reordered batch left a broker process alive');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 2,
    startBroker: index => startPowerShell(
      index === 0 ? 'Start-Sleep -Seconds 120' : "[Console]::Out.Write('sibling')",
      descriptors[index],
    ),
    deadlineMs: 1_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  }), 'spawn:timeout');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 3,
    startBroker: index => startPowerShell(
      index === 0 ? 'exit 70' : 'Start-Sleep -Seconds 120',
      descriptors[index],
    ),
    deadlineMs: 60_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  }), 'spawn:status');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 2,
    startBroker: index => startPowerShell(
      index === 0 ? "[Console]::Out.Write(('x'*2048))" : 'Start-Sleep -Seconds 120',
      descriptors[index],
    ),
    deadlineMs: 60_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  }), 'parent:utf8');

  const validEntry = parseWindowsBrokerDocument(slow[0]);
  for (const entries of [[], [validEntry, validEntry]]) assert.throws(
    () => parseWindowsBrokerDocument(JSON.stringify({ version: 1, entries })),
    error => error instanceof WindowsNativeStageError && error.stage === 'parent:entry-count',
  );
  assert.throws(
    () => parseWindowsBrokerDocument(JSON.stringify({ version: 1, entries: [{ ...validEntry, extra: true }] })),
    error => error instanceof WindowsNativeStageError && error.stage === 'parent:entry-shape',
  );

  process.stdout.write(`Windows ${process.arch} authority batch regression passed.\n`);
} finally {
  for (const fd of descriptors) closeSync(fd);
  rmSync(directory, { recursive: true, force: true });
}
