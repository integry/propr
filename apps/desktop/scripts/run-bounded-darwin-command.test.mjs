import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BoundedProcessError, runBoundedProcess } from './run-bounded-darwin-command.mjs';

const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'run-bounded-darwin-command.mjs');

const waitForProcessExit = async processId => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(processId, 0);
      if (process.platform === 'linux') {
        const processState = (await readFile(`/proc/${processId}/stat`, 'utf8')).split(' ')[2];
        if (processState === 'Z') return;
      }
      await delay(20);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
  }
  assert.fail('timed-out descendant process remained alive');
};

test('bounds output while continuously draining both child streams', async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    arguments: ['-e', 'process.stdout.write("A".repeat(8192)); process.stderr.write("B".repeat(8192));'],
    timeoutMs: 2_000,
    terminationGraceMs: 100,
    maxOutputBytes: 1_024,
  });
  assert.equal(Buffer.byteLength(result.stdout), 1_024);
  assert.equal(Buffer.byteLength(result.stderr), 1_024);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test('timeout terminates the owned process group including a descendant', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-bound-'));
  const descendantPidPath = join(fixtureRoot, 'descendant.pid');
  try {
    await assert.rejects(runBoundedProcess({
      executable: process.execPath,
      arguments: ['-e', [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'writeFileSync(process.argv[1], String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join(' '), descendantPidPath],
      timeoutMs: 300,
      terminationGraceMs: 100,
      maxOutputBytes: 1_024,
    }), error => error instanceof BoundedProcessError && error.reason === 'timeout');
    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('SIGKILL escalation survives leader close and removes a TERM-ignoring descendant', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-escalation-'));
  const descendantPidPath = join(fixtureRoot, 'descendant.pid');
  try {
    await assert.rejects(runBoundedProcess({
      executable: process.execPath,
      arguments: ['-e', [
        'const { spawn } = require("node:child_process");',
        'process.on("SIGTERM", () => process.exit(0));',
        'spawn(process.execPath, ["-e", [',
        '  "const { writeFileSync } = require(\\"node:fs\\");",',
        '  "process.on(\\"SIGTERM\\", () => {});",',
        '  "writeFileSync(process.argv[1], String(process.pid));",',
        '  "setInterval(() => {}, 1000);",',
        '].join(" "), process.argv[1]], { stdio: "ignore" });',
        'setInterval(() => {}, 1000);',
      ].join(' '), descendantPidPath],
      timeoutMs: 500,
      terminationGraceMs: 150,
      maxOutputBytes: 1_024,
    }), error => error instanceof BoundedProcessError
      && error.reason === 'timeout'
      && error.result.exitCode === 0);
    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('timeout remains primary while TERM runs the wrapper cleanup', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-cleanup-'));
  const cleanupPath = join(fixtureRoot, 'cleanup.txt');
  try {
    await assert.rejects(runBoundedProcess({
      executable: '/bin/bash',
      arguments: ['-c', [
        'trap \"printf CLEANED > \\\"$1\\\"; exit 143\" TERM',
        'sleep 30 &',
        'wait',
      ].join('\n'), 'bash', cleanupPath],
      timeoutMs: 300,
      terminationGraceMs: 1_000,
      maxOutputBytes: 1_024,
    }), error => error instanceof BoundedProcessError
      && error.reason === 'timeout'
      && error.result.exitCode === 143);
    assert.equal(await readFile(cleanupPath, 'utf8'), 'CLEANED');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('a command failure is not replaced by timeout or cleanup status', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-primary-'));
  const cleanupPath = join(fixtureRoot, 'cleanup.txt');
  try {
    await assert.rejects(runBoundedProcess({
      executable: '/bin/bash',
      arguments: ['-c', 'trap \"printf CLEANED > \\\"$1\\\"\" EXIT; exit 23', 'bash', cleanupPath],
      timeoutMs: 2_000,
      terminationGraceMs: 100,
      maxOutputBytes: 1_024,
    }), error => error instanceof BoundedProcessError
      && error.reason === 'exit'
      && error.result.exitCode === 23);
    assert.equal(await readFile(cleanupPath, 'utf8'), 'CLEANED');
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('nonzero exit escalates against a TERM-ignoring descendant before releasing the guard', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-nonzero-'));
  const descendantPidPath = join(fixtureRoot, 'descendant.pid');
  try {
    await assert.rejects(runBoundedProcess({
      executable: process.execPath,
      arguments: ['-e', [
        'const { existsSync } = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", [',
        '  "const { writeFileSync } = require(\\"node:fs\\");",',
        '  "process.on(\\"SIGTERM\\", () => {});",',
        '  "writeFileSync(process.argv[1], String(process.pid));",',
        '  "setInterval(() => {}, 1000);",',
        '].join(" "), process.argv[1]], { stdio: "ignore" });',
        'const waitState = new Int32Array(new SharedArrayBuffer(4));',
        'const deadline = Date.now() + 1000;',
        'while (!existsSync(process.argv[1]) && Date.now() < deadline) Atomics.wait(waitState, 0, 0, 10);',
        'process.exit(existsSync(process.argv[1]) ? 23 : 24);',
      ].join(' '), descendantPidPath],
      timeoutMs: 2_000,
      terminationGraceMs: 150,
      maxOutputBytes: 1_024,
    }), error => error instanceof BoundedProcessError
      && error.reason === 'exit'
      && error.result.exitCode === 23);
    const descendantPid = Number(await readFile(descendantPidPath, 'utf8'));
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('command spawn error retains the guard through SIGKILL escalation', async () => {
  const startedAt = Date.now();
  await assert.rejects(runBoundedProcess({
    executable: join(tmpdir(), 'propr-command-that-does-not-exist'),
    timeoutMs: 2_000,
    terminationGraceMs: 100,
    maxOutputBytes: 1_024,
  }), error => error instanceof BoundedProcessError
    && error.reason === 'spawn-or-io'
    && error.result.exitCode === 1);
  assert.ok(Date.now() - startedAt >= 75, 'spawn failure released the process-group guard early');
});

test('CLI timeout diagnostics never echo command arguments or secret values', async () => {
  const secretArgument = 'DO_NOT_PRINT_THIS_SECRET';
  await assert.rejects(new Promise((resolve, reject) => {
    nodeExecFile(process.execPath, [
      helperPath,
      '--timeout-ms', '200',
      '--termination-grace-ms', '100',
      '--max-output-bytes', '1024',
      '--forward-output', 'false',
      '--', process.execPath, '-e', 'setInterval(() => {}, 1000)', secretArgument,
    ], { encoding: 'utf8', timeout: 2_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve();
    });
  }), error => {
    assert.equal(error.code, 124);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, 'Bounded Darwin operation timed out.\n');
    assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(secretArgument, 'u'));
    return true;
  });
});
