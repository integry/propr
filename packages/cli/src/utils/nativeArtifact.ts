import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

/** Resolve an ASAR-relative native path to the physical, executable unpacked resource. */
export function physicalNativeArtifactCandidate(candidate: string): string {
  const marker = `${sep}app.asar${sep}`;
  const index = candidate.indexOf(marker);
  if (index === -1) return candidate;
  return `${candidate.slice(0, index)}${sep}app.asar.unpacked${sep}${candidate.slice(index + marker.length)}`;
}

/** Require every existing parent of a packaged native candidate to be canonical and non-link. */
export function assertCanonicalNativeArtifactParents(candidate: string): void {
  let parent = dirname(resolve(candidate));
  while (true) {
    const named = lstatSync(parent);
    if (!named.isDirectory() || named.isSymbolicLink() || realpathSync.native(parent) !== parent) {
      throw new Error('packaged native artifact ancestry failed verification');
    }
    const next = dirname(parent);
    if (next === parent) return;
    parent = next;
  }
}
