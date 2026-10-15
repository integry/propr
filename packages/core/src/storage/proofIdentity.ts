import sync, { constants } from 'node:fs';
import path from 'node:path';
import { instanceSelectionChanged } from './cleanupRequest.js';

/** Synchronous durable identity observation under the authority proof barrier. */
export function proofIdentitySync(root: string, identityRoot: { dev: number; ino: number } | undefined): string {
  let directory = path.resolve(root);
  for (;;) {
    const stat = sync.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw instanceSelectionChanged();
    if (directory === path.resolve(root) && (stat.dev !== identityRoot?.dev || stat.ino !== identityRoot?.ino)) throw instanceSelectionChanged();
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  const file = sync.openSync(path.join(root, 'instance.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = sync.fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128) throw instanceSelectionChanged();
    const bytes = Buffer.alloc(129); const length = sync.readSync(file, bytes, 0, bytes.length, 0);
    if (length > 128) throw instanceSelectionChanged();
    const instanceId = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (typeof instanceId !== 'string') throw instanceSelectionChanged();
    return instanceId;
  } finally { sync.closeSync(file); }
}
