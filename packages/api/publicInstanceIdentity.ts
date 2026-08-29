import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getOrCreatePublicInstanceIdentity as getOrCreateSharedIdentity } from '@propr/local-setup';

/** API access to the same validated, durable creation algorithm as the host CLI. */
export function getOrCreatePublicInstanceIdentity(
  dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data'),
  generate: () => string = randomUUID,
): string {
  return getOrCreateSharedIdentity(dataDir, {
    generate,
    role: 'root-container',
  });
}
