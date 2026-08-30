import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  crashWindowsLockedArtifactForTest,
  decodeWindowsAuthorityFramesForTest,
  ensureWindowsPrivateDirectory,
  injectWindowsAuthorityHeldFaultForTest,
  injectWindowsAuthorityProtocolFaultForTest,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  parseWindowsAuthorityStartupFailureForTest,
  probeWindowsAuthorityCompile,
  probeWindowsAuthorityCompileFailureForTest,
  probeWindowsAuthorityStartupFailureForTest,
  protectWindowsPrivateFile,
  shutdownWindowsAuthorityBrokerForTest,
  smokeWindowsUpdateAuthority,
  windowsAuthorityBrokerStatsForTest,
} from './windows-update-authority';

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' };

test('native Windows exact production C# compile probe reaches ready', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompile(), 'ready');
});

test('native Windows compile probe bounds startup failure to an enumerated non-secret stage', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompileFailureForTest(), 'type_compile');
  assert.equal(await probeWindowsAuthorityStartupFailureForTest(), 'ready_protocol');
});

test('Windows broker framing accepts partial JSON and rejects extra frames and strict compile failures', () => {
  const compileFailure = '{"version":1,"type":"error","reason":"compile_load","scenario":0}\n';
  const frames = decodeWindowsAuthorityFramesForTest([
    compileFailure.slice(0, 19),
    compileFailure.slice(19, 47),
    compileFailure.slice(47),
  ]);
  const failure = parseWindowsAuthorityStartupFailureForTest(frames[0]);
  assert.equal(
    failure.message,
    'Verified update cache authority inspection failed [win-authority:compile_load:0]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([compileFailure + compileFailure]),
    error => error instanceof Error
      && error.message === 'Verified update cache authority inspection failed [win-authority:stdio_protocol:16]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([compileFailure.slice(0, -1)]),
    error => error instanceof Error
      && error.message === 'Verified update cache authority inspection failed [win-authority:stdio_protocol:16]',
  );
});

test('native Windows authority binds protected owner DACL and complete file identity', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-authority-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted');
    await protectWindowsPrivateFile(artifact);
    const first = await inspectWindowsPrivatePath(artifact);
    const second = await inspectWindowsPrivatePath(artifact);
    assert.match(first.identity.volumeSerial, /^[a-f0-9]{16}$/);
    assert.match(first.identity.fileId128, /^[a-f0-9]{32}$/);
    assert.deepEqual(first.identity, second.identity);
    assert.equal(first.links, '1');
    assert.equal(first.reparseTag, '00000000');
    assert.equal(first.daclProtected, true);
    assert.match(first.ownerSid, /^S-1-/);
    assert.deepEqual(await smokeWindowsUpdateAuthority(artifact), [
      'compile-load',
      'owner-sid',
      'dacl-protection',
      'file-id-info',
      'same-handle-sha256-sha1',
      'reparse-query',
      'no-share-lock',
      'ready-protocol',
      'held-read',
      'clean-shutdown',
    ]);
    const stats = windowsAuthorityBrokerStatsForTest();
    assert.equal(stats.compileCount, 1, 'all smoke and authority requests must share one Add-Type compilation');
    assert.equal(stats.activeProcessCount, 1);
    assert.ok(stats.requestCount >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows purpose policy accepts empty setup files but requires exact non-empty artifacts', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-purpose-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const setupPath = join(cache, 'partial');
    await writeFile(setupPath, Buffer.alloc(0), { flag: 'wx' });
    await protectWindowsPrivateFile(setupPath);
    const empty = await inspectWindowsPrivatePath(setupPath);
    assert.equal(empty.size, '0');
    await assert.rejects(openWindowsLockedArtifact(setupPath, 1), /win-authority:type_link_size:5/);

    await writeFile(setupPath, Buffer.from('A'), { flag: 'r+' });
    const written = await inspectWindowsPrivatePath(setupPath);
    assert.deepEqual(written.identity, empty.identity, 'later setup write must retain the protected file identity');
    const artifactSha256 = createHash('sha256').update('A').digest('hex');
    const held = await openWindowsLockedArtifact(
      setupPath,
      1,
      undefined,
      undefined,
      written.identity,
      artifactSha256,
    );
    await held.close();
    await assert.rejects(
      openWindowsLockedArtifact(setupPath, 1, undefined, undefined, written.identity, '0'.repeat(64)),
      /win-authority:hash_read:11/,
    );

    const oversized = join(cache, 'oversized');
    await writeFile(oversized, Buffer.alloc(0), { flag: 'wx' });
    await protectWindowsPrivateFile(oversized);
    await truncate(oversized, 1024 * 1024 * 1024 + 64 * 1024 + 1);
    await assert.rejects(inspectWindowsPrivatePath(oversized), /win-authority:type_link_size:5/);

    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('wrong-purpose', setupPath, 1), 'request_protocol');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows broker serializes a concurrent queue within one practical aggregate latency budget', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-queue-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const started = Date.now();
    const results = await Promise.all(Array.from(
      { length: 16 },
      () => inspectWindowsPrivatePath(artifact),
    ));
    assert.ok(Date.now() - started < 30_000, '16 warm requests must finish within 30 seconds on hosted Windows');
    assert.ok(results.every(result => result.identity.fileId128 === results[0].identity.fileId128));
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows queued cancellation is bounded and does not disturb the held authority handle', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-cancel-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const held = await openWindowsLockedArtifact(artifact, 9);
    const controller = new AbortController();
    const cancelled = inspectWindowsPrivatePath(artifact, false, controller.signal);
    let queuedResolved = false;
    const queued = inspectWindowsPrivatePath(artifact).then(result => {
      queuedResolved = true;
      return result;
    });
    controller.abort();
    await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queuedResolved, false, 'queued authority work must wait until the held capability closes');
    assert.equal((await held.read(0, 9)).toString(), 'trusted-A');
    assert.equal(windowsAuthorityBrokerStatsForTest().queuedEntries, 1);
    await held.close();
    assert.equal((await queued).identity.fileId128, held.inspection.identity.fileId128);
    assert.equal(windowsAuthorityBrokerStatsForTest().queuedEntries, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows authority rejects foreign owner, broad/inherited ACEs, and junction reparse points', windowsOnly, async t => {
  for (const scenario of ['owner', 'broad', 'inherited', 'junction'] as const) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), 'propr-win-authority-'));
      try {
        const cache = join(root, 'cache');
        if (scenario === 'inherited') {
          await execFileAsync('icacls.exe', [root, '/grant', '*S-1-5-32-545:(OI)(CI)M']);
          await mkdir(cache);
        } else {
          await ensureWindowsPrivateDirectory(cache);
        }
        if (scenario === 'owner') {
          await execFileAsync('icacls.exe', [cache, '/setowner', '*S-1-5-32-544']);
        } else if (scenario === 'broad') {
          await execFileAsync('icacls.exe', [cache, '/grant', '*S-1-5-32-545:(OI)(CI)M']);
        } else if (scenario === 'junction') {
          const target = join(root, 'target');
          await mkdir(target);
          const junction = join(cache, 'junction');
          await symlink(target, junction, 'junction');
          const junctionStats = await lstat(junction);
          assert.equal(junctionStats.isSymbolicLink(), true, 'fixture must be a real junction reparse point');
          await assert.rejects(inspectWindowsPrivatePath(junction, true), /win-authority:reparse_point:4/);
          return;
        }
        await assert.rejects(inspectWindowsPrivatePath(cache, true), /authority inspection failed/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('native Windows held reader denies replace/delete while exact bytes are consumed', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-handoff-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const locked = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.equal(locked.inspection.sha256.length, 64);
      assert.equal(locked.inspection.sha1.length, 40);
      await assert.rejects(rename(artifact, join(cache, 'displaced')));
      await assert.rejects(writeFile(artifact, 'attacker-B'));
      await assert.rejects(rm(artifact));
      assert.equal((await locked.read(0, 9)).toString(), 'trusted-A');
      assert.deepEqual((await locked.verify()).identity, locked.inspection.identity);
    } finally {
      await locked.close();
    }
    assert.equal((await readFile(artifact)).toString(), 'trusted-A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows exact-handle capability rejects hardlinks and emits only bounded reason codes', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-reasons-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    await link(artifact, join(cache, 'second-link'));
    await assert.rejects(
      openWindowsLockedArtifact(artifact, 9),
      error => error instanceof Error
        && /^Verified update cache authority inspection failed \[win-authority:type_link_size:5\]$/.test(error.message)
        && !error.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows capability reuses one compiled broker without accepting pathname B', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-restart-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const first = await openWindowsLockedArtifact(artifact, 9);
    assert.equal((await first.read(0, 9)).toString(), 'trusted-A');
    await first.close();
    const second = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.deepEqual(second.inspection.identity, first.inspection.identity);
      assert.equal((await second.read(0, 9)).toString(), 'trusted-A');
      assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows broker crash releases its exact handle and restart reauthenticates A', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-crash-restart-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const crashed = await openWindowsLockedArtifact(artifact, 9);
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
    const queuedA = inspectWindowsPrivatePath(artifact);
    const queuedB = inspectWindowsPrivatePath(artifact);
    await crashWindowsLockedArtifactForTest(crashed);
    await assert.rejects(queuedA, /win-authority:process_exit:19/);
    await assert.rejects(queuedB, /win-authority:process_exit:19/);
    await assert.rejects(crashed.read(0, 1), /win-authority:(?:clean_shutdown|process_exit)/);
    const restarted = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 2);
      assert.equal(windowsAuthorityBrokerStatsForTest().restartCount, 1);
      assert.deepEqual(restarted.inspection.identity, crashed.inspection.identity);
      assert.equal((await restarted.read(0, 9)).toString(), 'trusted-A');
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows live broker rejects frame, ID, purpose, and identity faults without stale target state', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-live-faults-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifactA = join(cache, 'artifact-A');
    const artifactB = join(cache, 'artifact-B');
    await writeFile(artifactA, 'trusted-A');
    await writeFile(artifactB, 'trusted-B');
    await protectWindowsPrivateFile(artifactA);
    await protectWindowsPrivateFile(artifactB);

    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('partial-frame', artifactA, 9), 'accepted');
    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('wrong-identity', artifactA, 9), 'final_verify');
    const displaced = join(cache, 'displaced');
    await rename(artifactA, displaced);
    await rename(displaced, artifactA);

    for (const fault of ['wrong-id', 'wrong-purpose'] as const) {
      const held = await openWindowsLockedArtifact(artifactA, 9);
      assert.equal(await injectWindowsAuthorityHeldFaultForTest(held, fault), 'request_protocol');
      await rename(artifactA, displaced);
      await rename(displaced, artifactA);
    }

    const identityA = (await inspectWindowsPrivatePath(artifactA)).identity;
    const beforeCancellation = windowsAuthorityBrokerStatsForTest().compileCount;
    const controller = new AbortController();
    await assert.rejects(
      openWindowsLockedArtifact(
        artifactA,
        9,
        async () => controller.abort(),
        controller.signal,
        identityA,
      ),
      error => error instanceof Error && error.name === 'AbortError',
    );
    await rename(artifactA, displaced);
    await rename(displaced, artifactA);
    await inspectWindowsPrivatePath(artifactA);
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, beforeCancellation + 1);

    const beforeExtra = windowsAuthorityBrokerStatsForTest();
    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('extra-frame', artifactA, 9), 'stdio_protocol');
    const restarted = await openWindowsLockedArtifact(artifactB, 9);
    try {
      assert.equal((await restarted.read(0, 9)).toString(), 'trusted-B');
      assert.equal(
        windowsAuthorityBrokerStatsForTest().compileCount,
        beforeExtra.compileCount + 1,
        'one replacement process must perform exactly one production compilation',
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows persistent broker is reaped without a handle or process leak', windowsOnly, async () => {
  await shutdownWindowsAuthorityBrokerForTest();
  const stats = windowsAuthorityBrokerStatsForTest();
  assert.equal(stats.activeProcessCount, 0);
  assert.equal(stats.queuedEntries, 0);
});
