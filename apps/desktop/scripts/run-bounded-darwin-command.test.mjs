import assert from 'node:assert/strict';
import { execFile as nodeExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BoundedProcessError, runBoundedProcess } from './run-bounded-darwin-command.mjs';

const helperPath = join(dirname(fileURLToPath(import.meta.url)), 'run-bounded-darwin-command.mjs');

const waitForFixtureProcessId = pidPath => {
  const waitState = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const processId = Number(readFileSync(pidPath, 'utf8'));
      if (Number.isInteger(processId) && processId > 0) return processId;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    Atomics.wait(waitState, 0, 0, 20);
  }
  assert.fail('timed-out waiting for descendant fixture readiness');
};

const waitForProcessExit = async (processId, {
  killProcess = process.kill,
  platform = process.platform,
  readProcessStat = id => readFile(`/proc/${id}/stat`, 'utf8'),
  wait = delay,
} = {}) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      killProcess(processId, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    if (platform === 'linux') {
      try {
        const processState = (await readProcessStat(processId)).split(' ')[2];
        if (processState === 'Z') return;
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
        throw error;
      }
    }
    await wait(20);
  }
  assert.fail('timed-out descendant process remained alive');
};

test('observes Linux process exit when proc stat disappears after the liveness check', async () => {
  const processId = 2173;
  let livenessChecked = false;
  let procStatReads = 0;
  await waitForProcessExit(processId, {
    platform: 'linux',
    killProcess: (observedProcessId, signal) => {
      assert.equal(observedProcessId, processId);
      assert.equal(signal, 0);
      livenessChecked = true;
    },
    readProcessStat: async observedProcessId => {
      assert.equal(observedProcessId, processId);
      assert.equal(livenessChecked, true);
      procStatReads += 1;
      throw Object.assign(new Error('proc stat disappeared'), { code: 'ENOENT' });
    },
    wait: async () => assert.fail('missing proc stat should observe process exit without retrying'),
  });
  assert.equal(procStatReads, 1);
});

test('observes Linux process exit when proc stat read reports ESRCH after the liveness check', async () => {
  const processId = 2178;
  let livenessChecked = false;
  let procStatReads = 0;
  await waitForProcessExit(processId, {
    platform: 'linux',
    killProcess: (observedProcessId, signal) => {
      assert.equal(observedProcessId, processId);
      assert.equal(signal, 0);
      livenessChecked = true;
    },
    readProcessStat: async observedProcessId => {
      assert.equal(observedProcessId, processId);
      assert.equal(livenessChecked, true);
      procStatReads += 1;
      throw Object.assign(new Error('proc stat process disappeared'), { code: 'ESRCH' });
    },
    wait: async () => assert.fail('ESRCH proc stat read should observe process exit without retrying'),
  });
  assert.equal(procStatReads, 1);
});

test('propagates unexpected Linux proc stat read errors', async () => {
  const unexpectedError = Object.assign(new Error('proc stat read failed'), { code: 'EIO' });
  await assert.rejects(waitForProcessExit(2178, {
    platform: 'linux',
    killProcess: () => {},
    readProcessStat: async () => { throw unexpectedError; },
    wait: async () => assert.fail('unexpected proc stat errors should propagate without retrying'),
  }), error => error === unexpectedError);
});

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
  let descendantPid;
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
      // Start the real timeout only after the descendant fixture is ready.
      // This keeps CI scheduling delay out of the behavior the test is measuring.
      onSpawn: () => { descendantPid = waitForFixtureProcessId(descendantPidPath); },
    }), error => error instanceof BoundedProcessError && error.reason === 'timeout');
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('SIGKILL escalation survives leader close and removes a TERM-ignoring descendant', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-escalation-'));
  const descendantPidPath = join(fixtureRoot, 'descendant.pid');
  let descendantPid;
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
      // Start the real timeout only after the descendant has installed its TERM handler.
      // This keeps CI scheduling delay out of the behavior the test is measuring.
      onSpawn: () => { descendantPid = waitForFixtureProcessId(descendantPidPath); },
    }), error => error instanceof BoundedProcessError
      && error.reason === 'timeout'
      && error.result.exitCode === 0);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await waitForProcessExit(descendantPid);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('a throwing readiness hook cleans up the owned process group', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-readiness-'));
  const descendantPidPath = join(fixtureRoot, 'descendant.pid');
  const readinessError = new Error('readiness-hook-failed');
  let groupLeaderPid;
  let descendantPid;
  try {
    await assert.rejects(runBoundedProcess({
      executable: process.execPath,
      arguments: ['-e', [
        'const { spawn } = require("node:child_process");',
        'spawn(process.execPath, ["-e", [',
        '  "const { writeFileSync } = require(\\"node:fs\\");",',
        '  "process.on(\\"SIGTERM\\", () => {});",',
        '  "writeFileSync(process.argv[1], String(process.pid));",',
        '  "setInterval(() => {}, 1000);",',
        '].join(" "), process.argv[1]], { stdio: "ignore" });',
        'setInterval(() => {}, 1000);',
      ].join(' '), descendantPidPath],
      timeoutMs: 2_000,
      terminationGraceMs: 150,
      maxOutputBytes: 1_024,
      onSpawn: child => {
        groupLeaderPid = child.pid;
        descendantPid = waitForFixtureProcessId(descendantPidPath);
        throw readinessError;
      },
    }), error => error instanceof BoundedProcessError
      && error.reason === 'spawn-or-io'
      && error.result.cause === readinessError);
    assert.ok(Number.isInteger(groupLeaderPid) && groupLeaderPid > 0);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await Promise.all([
      waitForProcessExit(groupLeaderPid),
      waitForProcessExit(descendantPid),
    ]);
  } finally {
    if (groupLeaderPid) {
      try { process.kill(-groupLeaderPid, 'SIGKILL'); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('timeout remains primary while TERM runs the wrapper cleanup', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-cleanup-'));
  const cleanupPath = join(fixtureRoot, 'cleanup.txt');
  const readyPath = join(fixtureRoot, 'ready.pid');
  try {
    await assert.rejects(runBoundedProcess({
      executable: '/bin/bash',
      arguments: ['-c', [
        'trap \"printf CLEANED > \\\"$1\\\"; exit 143\" TERM',
        'printf %s \"$$\" > \"$2\"',
        'sleep 30 &',
        'wait',
      ].join('\n'), 'bash', cleanupPath, readyPath],
      timeoutMs: 300,
      terminationGraceMs: 1_000,
      maxOutputBytes: 1_024,
      // Start the timeout only after bash has installed its TERM trap, so a slow
      // runner cannot deliver TERM to a shell that has no cleanup handler yet.
      onSpawn: () => { waitForFixtureProcessId(readyPath); },
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

test('rejects executable substitution before creating a child process', async () => {
  let spawnCalled = false;
  await assert.rejects(runBoundedProcess({
    executable: join(tmpdir(), 'propr-command-that-does-not-exist'),
    timeoutMs: 2_000,
    terminationGraceMs: 100,
    maxOutputBytes: 1_024,
    spawn: () => {
      spawnCalled = true;
      throw new Error('unexpected-spawn');
    },
  }), error => error instanceof BoundedProcessError
    && error.reason === 'invalid-input');
  assert.equal(spawnCalled, false);
});

test('passes shell metacharacters as one inert argument', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-metacharacters-'));
  const injectedPath = join(fixtureRoot, 'injected.txt');
  const argument = `; touch ${injectedPath}; $(printf injected) &`;
  try {
    const result = await runBoundedProcess({
      executable: process.execPath,
      arguments: ['-e', 'process.stdout.write(process.argv[1])', argument],
      timeoutMs: 2_000,
      terminationGraceMs: 100,
      maxOutputBytes: 1_024,
    });
    assert.equal(result.stdout, argument);
    await assert.rejects(readFile(injectedPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('CLI command selection ignores PATH and rejects non-allowlisted executables', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'propr-darwin-environment-'));
  const fakeNodePath = join(fixtureRoot, 'node');
  const maliciousMarker = join(fixtureRoot, 'malicious.txt');
  const intendedMarker = join(fixtureRoot, 'intended.txt');
  const substitutedExecutable = join(fixtureRoot, 'substituted');
  try {
    await writeFile(fakeNodePath, [
      `#!${process.execPath}`,
      `require('node:fs').writeFileSync(${JSON.stringify(maliciousMarker)}, 'MALICIOUS');`,
    ].join('\n'), { mode: 0o700 });
    await chmod(fakeNodePath, 0o700);

    await new Promise((resolve, reject) => {
      nodeExecFile(process.execPath, [
        helperPath,
        '--timeout-ms', '2000',
        '--termination-grace-ms', '100',
        '--max-output-bytes', '1024',
        '--forward-output', 'false',
        '--', 'node', '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(intendedMarker)}, 'INTENDED')`,
      ], { env: { ...process.env, PATH: fixtureRoot } }, error => {
        if (error) reject(error);
        else resolve();
      });
    });
    assert.equal(await readFile(intendedMarker, 'utf8'), 'INTENDED');
    await assert.rejects(readFile(maliciousMarker, 'utf8'), { code: 'ENOENT' });

    await writeFile(substitutedExecutable, `#!${process.execPath}\n`, { mode: 0o700 });
    await assert.rejects(new Promise((resolve, reject) => {
      nodeExecFile(process.execPath, [
        helperPath,
        '--timeout-ms', '2000',
        '--', substitutedExecutable,
      ], { env: { ...process.env, PATH: fixtureRoot } }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve();
      });
    }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, 'Bounded Darwin operation failed.\n');
      return true;
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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
