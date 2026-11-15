import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Knex } from 'knex';
import {
  PLUGIN_WEBHOOK_CREDENTIAL_HEADERS, PLUGIN_WEBHOOK_LIMITS, pluginWebhookVerificationHeaders,
  type PluginManifest, type PluginWebhook, type PluginWebhookScheme, type PluginWebhookVerification,
} from '@propr/shared';
import { PluginError, installationRecord, type PluginInstallationRow } from './pluginState.js';
import type { PluginInstallationTarget } from './pluginContext.js';

/**
 * Inbound plugin webhooks: the verification schemes, the installation key in
 * the webhook URL and the lookup of a request's installation. ProPR verifies a
 * request before any plugin code runs; request bodies and signature headers
 * are never stored or logged (only a count of rejected requests is kept).
 */

/** The public path of a plugin webhook. */
export const PLUGIN_WEBHOOK_ROUTE = '/api/plugins/:installationKey/hooks/:webhookName' as const;
export const pluginWebhookPath = (key: string, name: string) => `/api/plugins/${key}/hooks/${name}`;

/** 32 random bytes, base64url: 43 characters. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WEBHOOK_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
export const generatePluginWebhookKey = () => randomBytes(32).toString('base64url');
export const pluginWebhookKeyHash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Why a request failed verification; counted, never logged with the request. */
export type PluginWebhookRejection = 'missing_signature' | 'bad_signature' | 'stale_timestamp' | 'no_secret';
export type PluginWebhookVerdict = { ok: true } | { ok: false; reason: PluginWebhookRejection };

/** One header value as text; a repeated header is not a valid signature. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Equal bytes, in time independent of where they differ. Different lengths are unequal (lengths are public: digests). */
const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
/** Equal strings in constant time: SHA-256 of both, so neither length nor content leaks. */
const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const hmac = (secret: string, ...parts: (string | Buffer)[]) => {
  const mac = createHmac('sha256', secret);
  for (const part of parts) mac.update(part);
  return mac.digest();
};
/** The digest a header carries in `encoding`; null when it is not that encoding. */
function decodeDigest(text: string, encoding: 'hex' | 'base64'): Buffer | null {
  if (encoding === 'hex') return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : null;
  return /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : null;
}

export interface VerifyPluginWebhookInput {
  verification: PluginWebhookVerification;
  /** The `signing_secret` connection's value. */
  secret: string;
  headers: IncomingHttpHeaders;
  /** The raw request body, exactly as received. */
  body: Buffer;
  /** Wall clock, for the timestamp tolerance. */
  now: number;
}

/**
 * Verify a request against one of the built-in schemes:
 * - `hmac-sha256`: `<header>: <prefix><HMAC-SHA256(secret, body)>` in hex or base64.
 * - `slack-v0`: `X-Slack-Signature: v0=<hex HMAC-SHA256(secret, "v0:" + X-Slack-Request-Timestamp + ":" + body)>`,
 *   with the timestamp within `PLUGIN_WEBHOOK_LIMITS.timestampToleranceSeconds` of now.
 * - `token-header`: `<header>: <prefix><secret>`, compared in constant time.
 */
export function verifyPluginWebhook({ verification, secret, headers, body, now }: VerifyPluginWebhookInput): PluginWebhookVerdict {
  const fail = (reason: PluginWebhookRejection): PluginWebhookVerdict => ({ ok: false, reason });
  if (verification.scheme === 'slack-v0') {
    const timestamp = headerValue(headers, 'x-slack-request-timestamp');
    const signature = headerValue(headers, 'x-slack-signature');
    if (!timestamp || !signature) return fail('missing_signature');
    if (!/^[0-9]{1,12}$/.test(timestamp)) return fail('bad_signature');
    if (Math.abs(now / 1000 - Number(timestamp)) > PLUGIN_WEBHOOK_LIMITS.timestampToleranceSeconds) return fail('stale_timestamp');
    const given = signature.startsWith('v0=') ? decodeDigest(signature.slice(3), 'hex') : null;
    return given && sameBytes(given, hmac(secret, `v0:${timestamp}:`, body)) ? { ok: true } : fail('bad_signature');
  }
  const value = headerValue(headers, verification.header);
  if (value === undefined) return fail('missing_signature');
  const prefix = verification.prefix ?? '';
  if (verification.scheme === 'token-header') return sameSecret(value, prefix + secret) ? { ok: true } : fail('bad_signature');
  if (!value.startsWith(prefix)) return fail('bad_signature');
  const given = decodeDigest(value.slice(prefix.length), verification.encoding);
  return given && sameBytes(given, hmac(secret, body)) ? { ok: true } : fail('bad_signature');
}

/** Request headers never handed to a handler: credentials of the HTTP layer. Verification headers are removed too. */
const WITHHELD_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding']);
/** The headers a handler receives: lower-case names, without the verification headers and HTTP credentials. */
export function handlerHeaders(headers: IncomingHttpHeaders, webhook: PluginWebhook): Record<string, string> {
  const withheld = new Set([...WITHHELD_HEADERS, ...pluginWebhookVerificationHeaders(webhook.verification)]);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || withheld.has(name.toLowerCase())) continue;
    kept[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return kept;
}

/**
 * The sender's delivery id from `deliveryIdHeader`: undefined without one, null when it is not 1 to 200 printable characters.
 * Never a credential or verification header (the manifest schema refuses both): their value would be stored as the delivery id.
 */
export function senderDeliveryId(headers: IncomingHttpHeaders, webhook: PluginWebhook): string | null | undefined {
  const name = webhook.deliveryIdHeader;
  if (!name || PLUGIN_WEBHOOK_CREDENTIAL_HEADERS.includes(name) || pluginWebhookVerificationHeaders(webhook.verification).includes(name)) return undefined;
  const value = headers[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' && new RegExp(`^[\\x21-\\x7e]{1,${PLUGIN_WEBHOOK_LIMITS.deliveryIdChars}}$`).test(value) ? value : null;
}

/** A `plugin_webhook_keys` row as stored. */
interface PluginWebhookKeyRow {
  plugin_id: string; installed_at: number | string; key_hash: string; key: string; created_by: string; created_at: number | string;
  rejected_count: number; last_rejected_at: number | string | null; last_rejected_reason: string | null;
}

export interface PluginWebhookEndpoint {
  name: string; description: string; scheme: PluginWebhookScheme;
  /** `/api/plugins/<installation key>/hooks/<name>`. */
  path: string;
  /** The full URL when the instance has a public base URL; otherwise null. */
  url: string | null;
}
export interface PluginWebhookEndpoints {
  webhooks: PluginWebhookEndpoint[];
  /** Requests refused because they failed verification. */
  rejected: { count: number; lastAt: number | null; lastReason: string | null };
  /** When the current key was created, and by whom. */
  keyCreatedAt: number | null; keyCreatedBy: string | null;
}

async function installedRow(database: Knex, pluginId: string): Promise<PluginInstallationRow> {
  const row = await database('plugin_installations').where({ plugin_id: pluginId }).first() as PluginInstallationRow | undefined;
  if (!row) throw new PluginError(409, 'The plugin is not installed');
  return row;
}

// eslint-disable-next-line max-params -- the transaction, plugin, installation, actor and time are explicit inputs
async function writeKey(trx: Knex, pluginId: string, installedAt: number, actor: string, now: number): Promise<void> {
  const key = generatePluginWebhookKey();
  await trx('plugin_webhook_keys').insert({
    plugin_id: pluginId, installed_at: installedAt, key_hash: pluginWebhookKeyHash(key), key, created_by: actor, created_at: now,
    rejected_count: 0, last_rejected_at: null, last_rejected_reason: null,
  }).onConflict('plugin_id').merge();
}

/** The installation's key row, created on first use; a row left by an earlier installation is replaced. */
async function currentKey(database: Knex, pluginId: string, now: number): Promise<PluginWebhookKeyRow> {
  return database.transaction(async trx => {
    const row = await installedRow(trx, pluginId);
    const existing = await trx('plugin_webhook_keys').where({ plugin_id: pluginId }).first() as PluginWebhookKeyRow | undefined;
    if (!existing || Number(existing.installed_at) !== Number(row.installed_at)) await writeKey(trx, pluginId, Number(row.installed_at), 'system', now);
    return await trx('plugin_webhook_keys').where({ plugin_id: pluginId }).first() as PluginWebhookKeyRow;
  });
}

function endpoints(manifest: PluginManifest | undefined, row: PluginWebhookKeyRow, origin: string | null): PluginWebhookEndpoints {
  return {
    webhooks: (manifest?.contributes.webhooks ?? []).map(webhook => {
      const path = pluginWebhookPath(row.key, webhook.name);
      return { name: webhook.name, description: webhook.description, scheme: webhook.verification.scheme, path, url: origin ? `${origin}${path}` : null };
    }),
    rejected: { count: Number(row.rejected_count), lastAt: row.last_rejected_at === null ? null : Number(row.last_rejected_at), lastReason: row.last_rejected_reason },
    keyCreatedAt: Number(row.created_at), keyCreatedBy: row.created_by,
  };
}

export interface PluginWebhookEndpointOptions { manifest: PluginManifest | undefined; origin: string | null; now?: number }
/** The installed plugin's webhook URLs and its count of rejected requests. Refused (409) when it is not installed. */
export async function pluginWebhookEndpoints(database: Knex, pluginId: string, options: PluginWebhookEndpointOptions): Promise<PluginWebhookEndpoints> {
  return endpoints(options.manifest, await currentKey(database, pluginId, options.now ?? Date.now()), options.origin);
}

/** Replace the installation key: every old webhook URL stops working at once. Recorded in the plugin's audit trail. */
 
export async function regeneratePluginWebhookKey(database: Knex, pluginId: string, actor: string, options: PluginWebhookEndpointOptions): Promise<PluginWebhookEndpoints> {
  const now = options.now ?? Date.now();
  const row = await database.transaction(async trx => {
    const installation = await installedRow(trx, pluginId);
    await writeKey(trx, pluginId, Number(installation.installed_at), actor, now);
    await trx('plugin_audit').insert({ plugin_id: pluginId, action: 'regenerate_webhook_key', actor, at: now, detail: JSON.stringify({ webhooks: options.manifest?.contributes.webhooks.map(w => w.name) ?? [] }) });
    return await trx('plugin_webhook_keys').where({ plugin_id: pluginId }).first() as PluginWebhookKeyRow;
  });
  return endpoints(options.manifest, row, options.origin);
}

/** Delete the installation key (uninstall): the URLs stop working and a reinstall gets a new key. */
export async function deletePluginWebhookKey(trx: Knex, pluginId: string): Promise<number> {
  return trx('plugin_webhook_keys').where({ plugin_id: pluginId }).delete();
}

/** Count a request that failed verification. Never fails the caller. */
export async function recordPluginWebhookRejection(database: Knex, pluginId: string, reason: PluginWebhookRejection, now: number): Promise<void> {
  await database('plugin_webhook_keys').where({ plugin_id: pluginId })
    .update({ rejected_count: database.raw('rejected_count + 1'), last_rejected_at: now, last_rejected_reason: reason }).catch(() => undefined);
}

/** The webhook a request addresses: an enabled installation of a registry plugin, its current key and a declared webhook name. */
export interface ResolvedPluginWebhook { target: PluginInstallationTarget; webhook: PluginWebhook }
/** Null for an unknown or regenerated key, an uninstalled, reinstalled or disabled plugin, or an undeclared webhook: the route answers 404. */
 
export async function resolvePluginWebhook(database: Knex, key: string, name: string, manifests: readonly PluginManifest[]): Promise<ResolvedPluginWebhook | null> {
  if (!KEY_PATTERN.test(key) || !WEBHOOK_NAME.test(name)) return null;
  const keyRow = await database('plugin_webhook_keys').where({ key_hash: pluginWebhookKeyHash(key) }).first() as PluginWebhookKeyRow | undefined;
  if (!keyRow) return null;
  const row = await database('plugin_installations').where({ plugin_id: keyRow.plugin_id }).first() as PluginInstallationRow | undefined;
  if (!row || !row.enabled || Number(row.installed_at) !== Number(keyRow.installed_at)) return null;
  const manifest = manifests.find(m => m.id === row.plugin_id);
  const webhook = manifest?.contributes.webhooks.find(w => w.name === name);
  if (!manifest || !webhook) return null;
  return { target: { pluginId: row.plugin_id, manifest, record: installationRecord(row) }, webhook };
}
