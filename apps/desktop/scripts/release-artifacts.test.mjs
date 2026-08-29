import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { finalizeArtifacts, stageArtifacts } from './release-artifacts.mjs';

const kinds = {
  'linux-x64': ['deb', 'rpm', 'zip'],
  'linux-arm64': ['deb', 'rpm', 'zip'],
  'darwin-x64': ['dmg', 'zip'],
  'darwin-arm64': ['dmg', 'zip'],
  'win32-x64': ['setup', 'nupkg', 'releases'],
  'win32-arm64': ['setup', 'nupkg', 'releases'],
};

const sourceName = kind => kind === 'setup' ? 'Desktop Setup.exe' : kind === 'nupkg' ? 'desktop-1.2.3-full.nupkg' : kind === 'releases' ? 'RELEASES' : `desktop.${kind}`;

const createFragments = async root => {
  const fragments = join(root, 'fragments');
  for (const [target, targetKinds] of Object.entries(kinds)) {
    const [platform, arch] = target.split('-');
    const makeDirectory = join(root, 'make', target);
    await mkdir(makeDirectory, { recursive: true });
    for (const kind of targetKinds) {
      const contents = kind === 'releases'
        ? `ABCDEF desktop-1.2.3-full.nupkg 123\n`
        : `${target}-${kind}`;
      await writeFile(join(makeDirectory, sourceName(kind)), contents);
    }
    await stageArtifacts({ makeDirectory, outputDirectory: join(fragments, target), platform, arch, version: '1.2.3' });
  }
  return fragments;
};

describe('desktop release artifacts', () => {
  test('stages named artifacts and finalizes checksummed release metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-test-'));
    const fragments = await createFragments(root);
    const output = join(root, 'final');
    const manifest = await finalizeArtifacts({ inputDirectory: fragments, outputDirectory: output, version: '1.2.3', env: {} });
    assert.equal(manifest.artifacts.length, 16);
    assert.equal(manifest.tag, 'desktop-v1.2.3');
    assert.equal(Object.keys(manifest.feeds).length, 0);
    assert.match(await readFile(join(output, 'SHA256SUMS'), 'utf8'), /ProPR-Desktop-1\.2\.3-windows-x64-Setup\.exe/);
    assert.match(
      await readFile(join(output, 'ProPR-Desktop-1.2.3-windows-x64-RELEASES'), 'utf8'),
      /ProPR-Desktop-1\.2\.3-windows-x64-full\.nupkg/,
    );
  });

  test('fails closed when update signing is required without a private key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-release-missing-key-'));
    const fragments = await createFragments(root);
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await assert.rejects(
      finalizeArtifacts({
        inputDirectory: fragments,
        outputDirectory: join(root, 'out'),
        version: '1.2.3',
        env: { PROPR_DESKTOP_PUBLISH_RELEASE: 'true', PROPR_DESKTOP_UPDATE_PUBLIC_KEY: publicKey },
      }),
      /requires PROPR_DESKTOP_UPDATE_PRIVATE_KEY/,
    );
  });
});
