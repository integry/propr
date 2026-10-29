import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Knex } from 'knex';
import { proprInstanceProxyUrl } from '@propr/shared';
import { instanceDataDirectory } from '../services/instanceWebPushConfiguration.js';

/**
 * Hosted UI tunnel mode: `propr tunnel setup` enabled the managed tunnel and
 * wrote the Connect registry id to PROPR_INSTANCE_ID, so this stack is
 * reachable at `https://t-<PROPR_INSTANCE_ID>.propr.dev`. In this mode every
 * MCP-through-Connect setting is derived unless set explicitly.
 */
export function hostedTunnelInstanceId(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PROPR_UI_TUNNEL_ENABLED?.trim().toLowerCase() !== 'true') return undefined;
  const id = env.PROPR_INSTANCE_ID?.trim();
  return id && proprInstanceProxyUrl(id) ? id : undefined;
}

export function isHostedTunnelMode(env: NodeJS.ProcessEnv): boolean {
  return hostedTunnelInstanceId(env) !== undefined;
}

/** `connect_mcp` on health and status surfaces. Never carries secrets. */
export type ConnectMcpState = 'registered' | 'pending' | 'disabled' | `failed:${string}`;
let connectMcpState: ConnectMcpState = 'disabled';
export function getConnectMcpState(): ConnectMcpState { return connectMcpState; }
export function setConnectMcpState(state: ConnectMcpState): void { connectMcpState = state; }

/** A tunnel-mode setup problem. The code is safe to show; the message never contains secrets. */
export class McpSetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpSetupError';
  }
}

/**
 * The effective MCP environment in hosted UI tunnel mode. Explicit values win;
 * an unset (or empty) variable is derived:
 * - MCP_PUBLIC_ORIGIN: the tunnel API origin, the same derivation as the
 *   tunnel-mode API_PUBLIC_URL (proprInstanceProxyUrl).
 * - MCP_INSTANCE_ID: PROPR_INSTANCE_ID, the tunnel id Connect has on record.
 * - MCP_CONNECT_TRUST: true, because Connect is the authorization server.
 * - MCP_ENCRYPTION_KEY: the persisted instance key, when one is supplied.
 */
export function deriveTunnelMcpEnvironment(env: NodeJS.ProcessEnv, encryptionKey?: Buffer): NodeJS.ProcessEnv {
  const instanceId = hostedTunnelInstanceId(env);
  if (!instanceId) return env;
  return {
    ...env,
    PROPR_UI_TUNNEL_ENABLED: 'true',
    MCP_ENABLED: 'true',
    MCP_PUBLIC_ORIGIN: env.MCP_PUBLIC_ORIGIN || proprInstanceProxyUrl(instanceId),
    MCP_INSTANCE_ID: env.MCP_INSTANCE_ID || instanceId,
    MCP_CONNECT_TRUST: env.MCP_CONNECT_TRUST || 'true',
    MCP_ENCRYPTION_KEY: env.MCP_ENCRYPTION_KEY || encryptionKey?.toString('base64') || '',
  };
}

/** Whether the MCP instance id is derived from the tunnel id rather than set explicitly. */
export function isTunnelDerivedInstanceId(env: NodeJS.ProcessEnv): boolean {
  return isHostedTunnelMode(env) && !env.MCP_INSTANCE_ID;
}

const KEY_MARKER = 'connect_key_check_value';
const KEY_FILENAME = 'encryption-key';
const keyCache = new Map<string, Buffer>();

/** Drop the in-memory key cache. The persisted file is untouched. */
export function clearTunnelMcpKeyCache(): void {
  keyCache.clear();
}

export function tunnelMcpKeyPath(env: NodeJS.ProcessEnv): string {
  try {
    return join(instanceDataDirectory(env, 'MCP through ProPR Connect'), 'mcp', KEY_FILENAME);
  } catch {
    throw new McpSetupError('KEY_STORAGE_UNAVAILABLE', 'MCP through ProPR Connect requires a durable data directory for its encryption key.');
  }
}

function fingerprint(key: Buffer): string {
  return createHash('sha256').update('propr:mcp:connect-key-check').update('\0').update(key).digest('hex');
}

class InvalidKeyFile extends Error {}

function readKeyFile(filename: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 128) throw new InvalidKeyFile();
    const key = Buffer.from(readFileSync(fd, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new InvalidKeyFile();
    return key;
  } finally { closeSync(fd); }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Write a fresh key next to the target and publish it with a hard link, which never overwrites a concurrent winner. */
function publishNewKey(filename: string): void {
  const directory = dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new InvalidKeyFile();
  const temporary = join(directory, `.${KEY_FILENAME}-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, `${randomBytes(32).toString('base64')}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    syncDirectory(directory);
  } finally {
    try { unlinkSync(temporary); } catch { /* A private orphan is never used as the key. */ }
  }
}

async function readMarker(database: Knex): Promise<string | undefined> {
  const row = await database('mcp_admin_settings').where({ key: KEY_MARKER }).first<{ value: string } | undefined>('value');
  return row?.value;
}

async function hasConnectIdentity(database: Knex): Promise<boolean> {
  if (!await database.schema.hasTable('mcp_records')) return false;
  return !!await database('mcp_records').where({ kind: 'connect_identity' }).first('id');
}

/**
 * Load the persisted MCP encryption key, generating it only on first use.
 *
 * The key lives with the stack's other persistent secrets in the durable data
 * directory (owner-only file in an owner-only directory). Its fingerprint is
 * recorded in the instance database the first time it is used. A missing file
 * after that, or a file that no longer matches, is a setup error: a new key
 * would silently orphan every connection and the Connect registration.
 */
export async function loadTunnelMcpEncryptionKey(env: NodeJS.ProcessEnv, database: Knex): Promise<Buffer> {
  const filename = tunnelMcpKeyPath(env);
  const cached = keyCache.get(filename);
  if (cached) return cached;
  let marker = await readMarker(database);
  let key: Buffer | undefined;
  try {
    key = readKeyFile(filename);
    if (!key) {
      if (marker || await hasConnectIdentity(database)) {
        throw new McpSetupError('KEY_MISSING', `The persisted MCP encryption key (${filename}) is missing. Restore it from backup or set MCP_ENCRYPTION_KEY to the original value. A new key is not generated because existing MCP connections and the Connect registration depend on it.`);
      }
      publishNewKey(filename);
      key = readKeyFile(filename);
      if (!key) throw new InvalidKeyFile();
    }
  } catch (error) {
    if (error instanceof McpSetupError) throw error;
    // Never include filesystem errors: the key file contents must not reach a log.
    if (error instanceof InvalidKeyFile || (error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new McpSetupError('KEY_STORAGE_INVALID', `The persisted MCP encryption key (${filename}) is not a private file holding 32 base64 bytes.`);
    }
    throw new McpSetupError('KEY_STORAGE_UNAVAILABLE', `The persisted MCP encryption key (${filename}) could not be read or created.`);
  }
  const check = fingerprint(key);
  if (!marker) {
    await database('mcp_admin_settings').insert({ key: KEY_MARKER, value: check, updated_at: Date.now() }).onConflict('key').ignore();
    marker = await readMarker(database);
  }
  if (marker !== check) {
    throw new McpSetupError('KEY_CHANGED', `The persisted MCP encryption key (${filename}) differs from the key this instance first used. Restore the original file or set MCP_ENCRYPTION_KEY to the original value.`);
  }
  keyCache.set(filename, key);
  return key;
}
