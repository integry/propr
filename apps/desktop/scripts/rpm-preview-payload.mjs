import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectArtifactArchitecture } from './release-architecture.mjs';
import { validateDesktopRuntimeManifest } from './desktop-runtime-manifest.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function inspectSignedPreviewPayload({ path, artifact, manifest, sourceDirectory }) {
  if (!sourceDirectory) throw new Error('Signed preview requires the frozen source directory for native pins');
  await inspectArtifactArchitecture({ path, ...artifact, onLinuxExtracted: async root => {
    const resources = join(root, 'usr/lib/propr-desktop/resources');
    const runtime = validateDesktopRuntimeManifest(JSON.parse(await readFile(join(resources, 'manifest.json'), 'utf8')), {
      sourceRevision: manifest.sourceRevision, distribution: 'published', agentImage: manifest.runtime.agentImage,
    });
    if (runtime.images.app !== manifest.runtime.appImage || runtime.images.ui !== manifest.runtime.uiImage) {
      throw new Error('Packaged runtime digests differ from original preview binding');
    }
    const native = join('prebuilds', `linux-${artifact.arch}`, 'directory-operations.node');
    const packaged = join(resources, 'app.asar.unpacked/.vite/native', native);
    const stats = await lstat(packaged);
    const expectedBytes = await readFile(join(sourceDirectory, 'packages/cli/native', native));
    const pinSource = await readFile(join(sourceDirectory, 'packages/cli/src/utils/directoryDescriptor.ts'), 'utf8');
    const pins = /LINUX_DIRECTORY_OPERATION_SHA256[^=]*=\s*\{([^}]+)\}/.exec(pinSource)?.[1];
    const expected = new RegExp(`\\b${artifact.arch}:\\s*["']([a-f0-9]{64})["']`).exec(pins || '')?.[1];
    if (!expected || digest(expectedBytes) !== expected || !stats.isFile() || stats.isSymbolicLink()
      || (stats.mode & 0o022) !== 0 || digest(await readFile(packaged)) !== expected) {
      throw new Error('Packaged native addon differs from frozen source hash pin');
    }
  } });
}
