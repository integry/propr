import { createECDH, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  validVapidSubject, validateWebPushConfiguration, webPushConfigurationFromEnvironment,
  type ValidatedWebPushConfiguration,
} from './webPushConfiguration.js';

// The existing SQLite data mount is durable in native, launcher and Compose runs.
// Do not import the DB connection: resolving paths must not open/migrate a database.
export function instanceWebPushDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.DB_FILENAME === ':memory:' || environment.DB_FILENAME?.startsWith('file:')) {
    throw new Error('Web Push requires a durable data directory');
  }
  const dataDirectory = environment.DB_FILENAME
    ? dirname(resolve(environment.DB_FILENAME))
    : environment.DATA_DIR ?? join(process.cwd(), 'data');
  return join(dataDirectory, 'web-push');
}

export const AUTOMATIC_VAPID_SUBJECT = 'https://propr.dev';

function automaticSubject(environment: NodeJS.ProcessEnv): string {
  for (const candidate of [environment.API_PUBLIC_URL, environment.FRONTEND_URL]) {
    if (validVapidSubject(candidate)) {
      const url = new URL(candidate);
      // Strip query/fragment/path and avoid localhost subjects rejected by Apple.
      if (url.protocol === 'https:' && url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost')) {
        return url.origin;
      }
    }
  }
  return AUTOMATIC_VAPID_SUBJECT;
}

class InvalidStoredIdentity extends Error {}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readIdentity(filename: string, subject: string): ValidatedWebPushConfiguration {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024) {
      throw new InvalidStoredIdentity();
    }
    let document;
    try { document = JSON.parse(readFileSync(fd, 'utf8')); } catch { throw new InvalidStoredIdentity(); }
    if (document?.version !== 1) throw new InvalidStoredIdentity();
    const validated = validateWebPushConfiguration({
      subject, publicKey: document.publicKey, privateKey: document.privateKey,
    });
    if (!validated.configured) throw new InvalidStoredIdentity();
    // Also complete durability after a previous process failed after publication.
    fsyncSync(fd);
    return Object.freeze(validated);
  } finally { closeSync(fd); }
}

export interface InstanceWebPushOptions {
  /** Fault-injection boundary for verifying crash/retry durability. Never receives secrets. */
  onBoundary?: (boundary: 'temporary-synced' | 'published' | 'directory-synced') => void;
}

/** Explicit startup only. No global cache, request-time writes, or import-time effects. */
export function resolveInstanceWebPushConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  options: InstanceWebPushOptions = {},
): ValidatedWebPushConfiguration {
  const explicit = webPushConfigurationFromEnvironment(environment);
  if (!explicit.enabled) return { configured: false, issue: 'disabled' };
  const subject = explicit.subject || automaticSubject(environment);
  // One explicit key is an error, never permission to generate a replacement.
  if (explicit.publicKey || explicit.privateKey) {
    return Object.freeze(validateWebPushConfiguration({ ...explicit, subject }));
  }
  if (!validVapidSubject(subject)) return { configured: false, issue: 'invalid_subject' };

  return resolveStoredIdentity(environment, subject, options);
}

function resolveStoredIdentity(
  environment: NodeJS.ProcessEnv,
  subject: string,
  options: InstanceWebPushOptions,
): ValidatedWebPushConfiguration {
  let temporary: string | undefined;
  try {
    const directory = instanceWebPushDirectory(environment);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
      throw new InvalidStoredIdentity();
    }
    syncDirectory(dirname(directory));
    const filename = join(directory, 'vapid.json');
    let existing: ValidatedWebPushConfiguration | undefined;
    try { existing = readIdentity(filename, subject); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!existing) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const privateKey = Buffer.alloc(32);
      const scalar = ecdh.getPrivateKey();
      scalar.copy(privateKey, 32 - scalar.length);
      temporary = join(directory, `.vapid-${randomUUID()}.tmp`);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(fd, JSON.stringify({
          version: 1,
          publicKey: ecdh.getPublicKey(undefined, 'uncompressed').toString('base64url'),
          privateKey: privateKey.toString('base64url'),
        }) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      options.onBoundary?.('temporary-synced');
      try {
        // Hard-link publication is atomic and never overwrites a concurrent winner.
        linkSync(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      options.onBoundary?.('published');
      existing = readIdentity(filename, subject);
    }
    syncDirectory(directory);
    options.onBoundary?.('directory-synced');
    return existing;
  } catch (error) {
    // Never include filesystem/JSON/crypto errors: they can contain private bytes.
    return {
      configured: false,
      issue: error instanceof InvalidStoredIdentity || (error as NodeJS.ErrnoException).code === 'ELOOP'
        ? 'storage_invalid' : 'storage_unavailable',
    };
  } finally {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* A private orphan is safe; never use it as an identity. */ }
    }
  }
}
