import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLIC_INSTANCE_IDENTITY_FILENAME,
  PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
  parsePublicInstanceIdentityDocument,
} from '@propr/shared';

const MAX_IDENTITY_FILE_BYTES = 1024;

function readIdentity(filePath: string): string {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_IDENTITY_FILE_BYTES) {
    throw new Error('public instance identity is invalid');
  }
  const parsed = parsePublicInstanceIdentityDocument(JSON.parse(readFileSync(filePath, 'utf8')));
  if (!parsed) throw new Error('public instance identity is invalid');
  return parsed.publicInstanceIdentity;
}

/** API-side access to the same durable file used by the host CLI. */
export function getOrCreatePublicInstanceIdentity(
  dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data'),
  generate: () => string = randomUUID,
): string {
  mkdirSync(dataDir, { recursive: true });
  const filePath = join(dataDir, PUBLIC_INSTANCE_IDENTITY_FILENAME);
  try {
    return readIdentity(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const publicInstanceIdentity = generate();
  const document = `${JSON.stringify({
    schemaVersion: PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
    publicInstanceIdentity,
  })}\n`;
  let descriptor: number | undefined;
  try {
    // This value is explicitly public. 0644 also lets the owning host user read
    // a file first created by the root-running packaged API container.
    descriptor = openSync(filePath, 'wx', 0o644);
    writeFileSync(descriptor, document, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return readIdentity(filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readIdentity(filePath);
    throw error;
  }
}
