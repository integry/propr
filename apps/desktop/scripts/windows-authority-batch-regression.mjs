#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
  process.stderr.write('Windows authority batch regression requires native win32-x64 or win32-arm64.\n');
  process.exit(1);
}

const {
  parseWindowsBrokerDocument,
  runWindowsReadOnlyInspection,
  runWindowsInspectionBrokerBatch,
  WindowsNativeStageError,
} = await import('../../../packages/cli/dist/connectWindowsAuthority.js');

const systemRoot = process.env.SystemRoot;
assert.match(systemRoot ?? '', /^[A-Za-z]:\\/u);
const directory = mkdtempSync(join(tmpdir(), 'propr-authority-batch-'));
const descriptors = [];
const livePids = new Set();

const portableSupervisorFixture = String.raw`
const mode=process.argv[1];const value=process.argv[2]??'';const delay=Number(process.argv[3]??0);
if(mode==='hang'){setInterval(()=>{},60000)}
else if(mode==='status'){process.exit(70)}
else setTimeout(()=>{
  if(mode==='stderr')process.stderr.write('fixed-fixture-stderr');
  else if(mode==='overflow')process.stdout.write('x'.repeat(2048));
  else process.stdout.write(value);
},delay);
`;

const startPortableFixture = (mode, value = '', delay = 0) => {
  const child = spawn(process.execPath, ['-e', portableSupervisorFixture, mode, String(value), String(delay)], {
    shell: false,
    windowsHide: true,
    env: { SystemRoot: systemRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
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

const fixedEvidence = (count, outcome, stage, diagnostics) => ({
  brokers: count,
  outcome,
  stage,
  results: diagnostics,
});

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
  let validEntry;
  for (const count of [1, 2, 4]) {
    const targets = descriptors.slice(0, count).map(targetFor);
    const started = performance.now();
    const inspections = await runWindowsReadOnlyInspection(targets);
    assert.equal(inspections.length, count);
    assert.ok(performance.now() - started < 60_000, `one-broker ${count}-handle batch exceeded its wall bound`);
    if (count === 1) {
      const { index: _index, kind: _kind, authorityKind: _authorityKind, ...entry } = inspections[0];
      validEntry = entry;
    }
  }

  // Supervisor concurrency is process-level behavior, so prove it with a
  // deterministic portable child instead of recreating a PS5.1 cold-start
  // storm after the dedicated sequential native proofs above.
  for (const count of [1, 2, 4]) {
    const diagnostics = [];
    const outputs = await runWindowsInspectionBrokerBatch({
      entryCount: count,
      startBroker: index => startPortableFixture('output', index, 40 - index),
      deadlineMs: 10_000,
      cleanupTimeoutMs: 5_000,
      maxOutputBytes: 128 * 1024,
      onBrokerResult: diagnostic => diagnostics.push(diagnostic),
    });
    assert.deepEqual(outputs.map(output => output.toString('utf8')), Array.from({ length: count }, (_, i) => String(i)));
    assert.equal(diagnostics.length, count);
    assert.equal(livePids.size, 0, `${count}-child supervisor evidence left a process alive`);
    process.stdout.write(`Windows authority supervisor evidence ${JSON.stringify(
      fixedEvidence(count, 'passed', 'ok', diagnostics),
    )}\n`);
  }

  const reorderedDelays = [80, 10, 45];
  const reordered = await runWindowsInspectionBrokerBatch({
    entryCount: reorderedDelays.length,
    startBroker: index => startPortableFixture('output', index, reorderedDelays[index]),
    deadlineMs: 10_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  });
  assert.deepEqual(reordered.map(output => output.toString('utf8')), ['0', '1', '2']);
  assert.equal(livePids.size, 0, 'reordered batch left a broker process alive');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 2,
    startBroker: index => startPortableFixture(index === 0 ? 'hang' : 'output', 'sibling'),
    deadlineMs: 1_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  }), 'spawn:timeout');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 3,
    startBroker: index => startPortableFixture(index === 0 ? 'status' : 'hang'),
    deadlineMs: 10_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 128,
  }), 'spawn:status');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 2,
    startBroker: index => startPortableFixture(index === 0 ? 'overflow' : 'hang'),
    deadlineMs: 10_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  }), 'parent:utf8');

  await assertStage(runWindowsInspectionBrokerBatch({
    entryCount: 2,
    startBroker: index => startPortableFixture(index === 0 ? 'stderr' : 'hang'),
    deadlineMs: 10_000,
    cleanupTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  }), 'spawn:stderr');

  assert.ok(validEntry);
  assert.deepEqual(parseWindowsBrokerDocument(JSON.stringify({ version: 1, entries: [validEntry] })), validEntry);
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
