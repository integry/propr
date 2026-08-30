import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  crashWindowsLockedArtifactForTest,
  authenticateWindowsAuthorityHelperForTest,
  decodeWindowsAuthorityFramesForTest,
  encodeWindowsAuthorityFrameForTest,
  inspectWindowsAuthorityHelperPeForTest,
  ensureWindowsPrivateDirectory,
  injectWindowsAuthorityHeldFaultForTest,
  injectWindowsAuthorityProtocolFaultForTest,
  injectWindowsAuthorityTransportFaultForTest,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  parseWindowsAuthorityStartupFailureForTest,
  parseWindowsAuthorityHelperManifestForTest,
  probeWindowsAuthorityCompile,
  probeWindowsAuthorityCompileFailureForTest,
  probeWindowsAuthorityBootstrapStageForTest,
  probeWindowsAuthorityProcessImageMismatchForTest,
  probeWindowsAuthorityStartupFailureForTest,
  protectWindowsPrivateFile,
  shutdownWindowsAuthorityBrokerForTest,
  smokeWindowsUpdateAuthority,
  windowsAuthorityBrokerStatsForTest,
  WINDOWS_AUTHORITY_COMPILE_STAGES,
} from './windows-update-authority';

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' };

test('native Windows exact production C# compile probe reaches ready', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompile(), 'READY');
});

test('native Windows compile probe bounds startup failure to an enumerated non-secret stage', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompileFailureForTest(), 'TYPE_COMPILE');
  assert.equal(await probeWindowsAuthorityStartupFailureForTest(), 'ready_protocol');
});

const helperManifest = (overrides: Record<string, unknown> = {}): Buffer => Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  name: 'propr-windows-authority.exe',
  format: 'PE32',
  architecture: 'anycpu',
  machine: 'I386',
  clr: true,
  size: 4096,
  sha256: 'a'.repeat(64),
  sourceSha256: 'b'.repeat(64),
  protocol: 'propr-windows-authority-v1',
  trust: 'unsigned-validation',
  publisher: null,
  compiler: { kind: 'systemroot-dotnet-framework-csc', framework: 'Framework64-v4.0.30319' },
  ...overrides,
})}\n`);

test('Windows helper manifest is fatal-UTF8, exact, architecture-bound, and distinguishes unsigned validation', () => {
  assert.equal(parseWindowsAuthorityHelperManifestForTest(helperManifest()).trust, 'unsigned-validation');
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ sha256: '0'.repeat(63) })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ architecture: 'x64' })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ unexpected: true })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(Buffer.from([0xc3, 0x28, 0x0a])), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest().subarray(0, -1)), /compile_load:4/);
});

test('Windows helper PE inspection requires a managed PE32 AnyCPU-compatible image', () => {
  const pe = Buffer.alloc(1024);
  pe.writeUInt16LE(0x5a4d, 0);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'ascii');
  pe.writeUInt16LE(0x14c, 0x84);
  pe.writeUInt16LE(1, 0x86);
  pe.writeUInt16LE(224, 0x94);
  pe.writeUInt16LE(0x10b, 0x98);
  pe.writeUInt32LE(0x2000, 0x98 + 96 + (14 * 8));
  pe.writeUInt32LE(72, 0x98 + 96 + (14 * 8) + 4);
  pe.writeUInt32LE(0x200, 0x178 + 8);
  pe.writeUInt32LE(0x2000, 0x178 + 12);
  pe.writeUInt32LE(0x200, 0x178 + 16);
  pe.writeUInt32LE(0x200, 0x178 + 20);
  pe.writeUInt32LE(0x1, 0x210);
  assert.doesNotThrow(() => inspectWindowsAuthorityHelperPeForTest(pe));
  const nativeOnly = Buffer.from(pe);
  nativeOnly.writeUInt32LE(0, 0x98 + 96 + (14 * 8));
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(nativeOnly), /compile_load:9/);
  const wrongMachine = Buffer.from(pe);
  wrongMachine.writeUInt16LE(0x8664, 0x84);
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(wrongMachine), /compile_load:9/);
  const required32Bit = Buffer.from(pe);
  required32Bit.writeUInt32LE(0x3, 0x210);
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(required32Bit), /compile_load:9/);
});

test('native Windows bootstrap reports every injected real boundary including early exit', windowsOnly, async () => {
  for (const stage of WINDOWS_AUTHORITY_COMPILE_STAGES) {
    assert.equal(await probeWindowsAuthorityBootstrapStageForTest(stage), stage);
  }
  assert.equal(await probeWindowsAuthorityProcessImageMismatchForTest(), 'HELPER_IDENTITY');
});

test('native Windows helper authentication rejects manifest/output/compiler, link, reparse, and same-name ABA faults', windowsOnly, async t => {
  const source = await authenticateWindowsAuthorityHelperForTest();
  const sourceDirectory = dirname(source.executable);
  await source.executableHandle.close();
  await source.manifestHandle.close();
  await assert.rejects(
    authenticateWindowsAuthorityHelperForTest(sourceDirectory, undefined, 'CN=Expected Production Publisher'),
    /compile_load:4/,
    'an unsigned validation helper must never satisfy a production-publisher expectation',
  );
  const sourceManifest = join(sourceDirectory, 'propr-windows-authority.manifest.json');

  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-win-helper-'));
    const executable = join(root, 'propr-windows-authority.exe');
    const manifest = join(root, 'propr-windows-authority.manifest.json');
    await copyFile(source.executable, executable);
    await copyFile(sourceManifest, manifest);
    return { root, executable, manifest };
  };

  for (const scenario of ['manifest', 'output', 'compiler', 'hardlink', 'reparse', 'same-name-aba'] as const) {
    await t.test(scenario, async () => {
      const current = await fixture();
      try {
        if (scenario === 'manifest') {
          const bytes = await readFile(current.manifest);
          bytes[12] ^= 1;
          await writeFile(current.manifest, bytes);
        } else if (scenario === 'output') {
          const bytes = await readFile(current.executable);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(current.executable, bytes);
        } else if (scenario === 'compiler') {
          const value = JSON.parse(await readFile(current.manifest, 'utf8'));
          value.compiler.kind = 'path-lookup-csc';
          await writeFile(current.manifest, `${JSON.stringify(value)}\n`);
        } else if (scenario === 'hardlink') {
          await link(current.executable, join(current.root, 'alternate.exe'));
        } else if (scenario === 'reparse') {
          await rm(current.executable);
          await symlink(source.executable, current.executable, 'file');
        }
        const barrier = scenario === 'same-name-aba' ? async () => {
          await rename(current.executable, join(current.root, 'displaced.exe'));
          await copyFile(source.executable, current.executable);
        } : undefined;
        await assert.rejects(authenticateWindowsAuthorityHelperForTest(current.root, barrier), /compile_load:(?:4|7|8|9)/);
      } finally { await rm(current.root, { recursive: true, force: true }); }
    });
  }
});

test('native Windows direct broker fails closed on live stderr, slowloris, and response timeout faults', windowsOnly, async () => {
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('stderr'), 'stdio_protocol');
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('slowloris'), 'timeout');
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('timeout'), 'timeout');
});

test('Windows broker framing accepts partial JSON and rejects extra frames and strict compile failures', () => {
  const compileFailure = '{"version":1,"type":"error","reason":"compile_load","scenario":0}\n';
  const encoded = encodeWindowsAuthorityFrameForTest(compileFailure.slice(0, -1));
  const frames = decodeWindowsAuthorityFramesForTest([
    encoded.subarray(0, 3),
    encoded.subarray(3, 19),
    encoded.subarray(19),
  ]);
  const failure = parseWindowsAuthorityStartupFailureForTest(frames[0]);
  assert.equal(
    failure.message,
    'Verified update cache authority inspection failed [win-authority:compile_load:0]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([Buffer.concat([encoded, encoded])]),
    error => error instanceof Error
      && error.message === 'Verified update cache authority inspection failed [win-authority:stdio_protocol:16]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([encoded.subarray(0, -1)]),
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
    assert.equal(stats.compileCount, 1, 'all smoke and authority requests must share one compiled helper process');
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
        'one replacement process must launch exactly one authenticated compiled helper',
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
