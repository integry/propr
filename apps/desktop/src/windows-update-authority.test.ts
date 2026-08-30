import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import {
  ensureWindowsPrivateDirectory,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  protectWindowsPrivateFile,
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
      await assert.rejects(rename(artifact, join(cache, 'displaced')));
      await assert.rejects(writeFile(artifact, 'attacker-B'));
      await assert.rejects(rm(artifact));
      assert.equal((await locked.read(0, 9)).toString(), 'trusted-A');
    } finally {
      await locked.close();
    }
    assert.equal((await readFile(artifact)).toString(), 'trusted-A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
