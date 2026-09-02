import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { assertArtifactSet, parseArguments } from './test-native-artifact-lifecycle.mjs';

describe('native staged artifact lifecycle authority', () => {
  test('accepts only the exact four native target coordinates', () => {
    assert.deepEqual(parseArguments([
      '--version', '1.2.3',
      '--platform', 'linux',
      '--arch', 'arm64',
      '--artifact-directory', 'artifacts',
    ]), {
      version: '1.2.3',
      platform: 'linux',
      arch: 'arm64',
      artifactDirectory: join(process.cwd(), 'artifacts'),
    });
    for (const args of [
      ['--version', '1.2.3', '--platform', 'win32', '--arch', 'x64', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3', '--platform', 'darwin', '--arch', 'ia32', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3-beta', '--platform', 'darwin', '--arch', 'arm64', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3', '--version', '1.2.4', '--platform', 'linux', '--arch', 'x64'],
    ]) assert.throws(() => parseArguments(args), /invalid|missing|duplicated|malformed/);
  });

  test('fails closed for a missing kind, foreign file, or symlinked canonical artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-artifact-set-'));
    const target = { platform: 'linux', arch: 'x64', version: '1.2.3', artifactDirectory: directory };
    const names = ['deb', 'rpm', 'zip'].map(kind => `ProPR-Desktop-1.2.3-linux-x64.${kind}`);
    try {
      await Promise.all(names.map(name => writeFile(join(directory, name), name)));
      assert.deepEqual(await assertArtifactSet(target), ['deb', 'rpm', 'zip']);

      await writeFile(join(directory, 'foreign.zip'), 'foreign');
      await assert.rejects(assertArtifactSet(target), /unexpected or duplicate identity/);
      await rm(join(directory, 'foreign.zip'));

      await rm(join(directory, names[0]));
      await assert.rejects(assertArtifactSet(target), /canonical staged deb/);
      await symlink(join(directory, names[1]), join(directory, names[0]));
      await assert.rejects(assertArtifactSet(target), /canonical staged deb/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
