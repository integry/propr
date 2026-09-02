#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
  process.stderr.write('Windows authority batch regression requires native win32-x64 or win32-arm64.\n');
  process.exit(1);
}

const {
  parseWindowsBrokerDocument,
  runWindowsReadOnlyInspection,
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

const startPowerShell = (source, fds) => {
  const inherited = Array.isArray(fds) ? fds : [fds];
  const child = spawn(executable, argumentsFor(source), {
    shell: false,
    windowsHide: true,
    cwd: dirname(executable),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe', ...inherited],
  });
  if (Number.isSafeInteger(child.pid)) livePids.add(child.pid);
  child.once('close', () => livePids.delete(child.pid));
  return child;
};

const targetFor = (fd, index) => {
  const stat = fstatSync(fd, { bigint: true });
  return {
    path: '',
    kind: 'env',
    pinnedFd: fd,
    expectedIdentity: { device: stat.dev.toString(10), file: stat.ino.toString(10) },
    index,
  };
};

const oneRoundSource = WINDOWS_INSPECTION_SOURCE
  .replace('__PROPR_ENTRY_COUNT__', '1')
  .replace('__PROPR_ROUND_COUNT__', '1');

const fixedEvidence = (count, outcome, stage, diagnostics) => ({
  brokers: count,
  outcome,
  stage,
  results: diagnostics,
});

const canonicalFrame = output => {
  assert.equal(output.at(-1), 0x0a);
  const end = output.at(-2) === 0x0d ? output.length - 2 : output.length - 1;
  assert.equal(output.subarray(0, end).includes(0x0a), false);
  return output.subarray(0, end);
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

  // Production proof: 1, 2, and 4 targets each use one cold PowerShell process
  // and remain inside the unchanged single 60-second wall bound.
  for (const count of [1, 2, 4]) {
    const targets = descriptors.slice(0, count).map(targetFor);
    const started = performance.now();
    const inspections = await runWindowsReadOnlyInspection(targets);
    assert.equal(inspections.length, count);
    assert.ok(performance.now() - started < 60_000, `one-broker ${count}-handle batch exceeded its wall bound`);
  }

  // Resource evidence remains non-authoritative and total: reproduce 1, 2,
  // then 4 independent full cold starts, but allow a fixed failure now that
  // production does not depend on N-process concurrency. No native text enters
  // the record, and the supervisor still drains every process before return.
  for (const count of [1, 2, 4]) {
    const diagnostics = [];
    let outcome = 'passed';
    let stage = 'ok';
    try {
      const outputs = await runWindowsInspectionBrokerBatch({
        entryCount: count,
        startBroker: index => startPowerShell(oneRoundSource, descriptors[index]),
        deadlineMs: 60_000,
        cleanupTimeoutMs: 5_000,
        maxOutputBytes: 128 * 1024,
        onBrokerResult: diagnostic => diagnostics.push(diagnostic),
      });
      outputs.forEach(output => parseWindowsBrokerDocument(canonicalFrame(output)));
    } catch (error) {
      assert.ok(error instanceof WindowsNativeStageError);
      outcome = 'failed';
      stage = error.stage;
    }
    assert.equal(diagnostics.length, count);
    assert.equal(livePids.size, 0, `${count}-broker evidence left a process alive`);
    process.stdout.write(`Windows authority concurrency evidence ${JSON.stringify(
      fixedEvidence(count, outcome, stage, diagnostics),
    )}\n`);
  }

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

  const validOutput = await runWindowsInspectionBrokerBatch({
    entryCount: 1,
    startBroker: () => startPowerShell(oneRoundSource, descriptors[0]),
    deadlineMs: 60_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128 * 1024,
  });
  const validEntry = parseWindowsBrokerDocument(canonicalFrame(validOutput[0]));
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
