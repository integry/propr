import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  crashWindowsLockedArtifactForTest,
  ensureWindowsPrivateDirectory,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  protectWindowsPrivateFile,
  smokeWindowsUpdateAuthority,
} from './windows-update-authority';

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' };

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
          await execFileAsync('cmd.exe', ['/d', '/s', '/c', `mklink /J "${junction}" "${target}"`]);
          await assert.rejects(inspectWindowsPrivatePath(junction, true), /authority inspection failed/);
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
    const locked = await openWindowsLockedArtifact(artifact);
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
      openWindowsLockedArtifact(artifact),
      error => error instanceof Error
        && /^Verified update cache authority inspection failed \[win-authority:type_link_size:5\]$/.test(error.message)
        && !error.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows capability survives clean broker restart without accepting pathname B', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-restart-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const first = await openWindowsLockedArtifact(artifact);
    assert.equal((await first.read(0, 9)).toString(), 'trusted-A');
    await first.close();
    const second = await openWindowsLockedArtifact(artifact);
    try {
      assert.deepEqual(second.inspection.identity, first.inspection.identity);
      assert.equal((await second.read(0, 9)).toString(), 'trusted-A');
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
    const crashed = await openWindowsLockedArtifact(artifact);
    await crashWindowsLockedArtifactForTest(crashed);
    await assert.rejects(crashed.read(0, 1), /win-authority:(?:clean_shutdown|process_exit)/);
    const restarted = await openWindowsLockedArtifact(artifact);
    try {
      assert.deepEqual(restarted.inspection.identity, crashed.inspection.identity);
      assert.equal((await restarted.read(0, 9)).toString(), 'trusted-A');
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
