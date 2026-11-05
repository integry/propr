import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExtensionCatalogEntry } from '@propr/shared';
import { ExtensionError } from './extensionProfileStore.js';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const base = { id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), tools: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).max(64), capability: z.enum(['read', 'write']) };
const schema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('stdio'), executable: z.string().regex(/^\/(usr\/local\/bin|usr\/bin|opt\/propr)\/[A-Za-z0-9_./-]+$/).refine(s => !s.split('/').includes('..')), args: z.array(z.string().max(2048)).max(64), secretEnv: z.record(envName, envName) }),
  z.strictObject({ ...base, kind: z.literal('https'), url: z.string().max(2048), addresses: z.array(z.ipv4().or(z.ipv6())).min(1).max(16), bearerSecretRef: envName.optional() }),
]);
export type OperatorCatalogEntry = z.infer<typeof schema>;
// Canonical ordering makes the immutable digest independent of JSON formatting.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const operatorCatalogDigest = (entry: OperatorCatalogEntry) => createHash('sha256').update(canonical(entry)).digest('hex');
export class OperatorCatalog {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  async entries(): Promise<OperatorCatalogEntry[]> {
    const filename = this.environment.PROPR_EXTENSION_CATALOG_FILE;
    if (!filename) return [];
    let file;
    try {
      file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || ![0, process.getuid?.()].includes(stat.uid) || stat.size > 256 * 1024 || (stat.mode & 0o022)) throw new Error('Unsafe catalog');
      const entries = z.array(schema).max(64).parse(JSON.parse(await file.readFile('utf8')));
      if (new Set(entries.map(e => e.id)).size !== entries.length) throw new Error('Duplicate identity');
      for (const e of entries) {
        if (e.kind === 'https') {
          const url = new URL(e.url);
          if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(e.url) || (url.port && url.port !== '443')) throw new Error('Invalid internal endpoint');
        }
        // Secret values must never occur in the catalog's command/argument fields.
        const values = Object.values(this.secrets(e)).filter(Boolean).flatMap(v => [v, Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex'), encodeURIComponent(v), JSON.stringify(v).slice(1, -1)]);
        if (values.some(v => v && canonical(e).includes(v))) throw new Error('Catalog contains secret material');
      }
      return entries;
    } catch { throw new ExtensionError(503, 'Operator extension catalog unavailable'); }
    finally { await file?.close(); }
  }
  secrets(entry: OperatorCatalogEntry): Record<string, string> {
    const refs = entry.kind === 'stdio' ? entry.secretEnv : entry.bearerSecretRef ? { bearerToken: entry.bearerSecretRef } : {};
    return Object.fromEntries(Object.entries(refs).map(([field, ref]) => [field, this.environment[ref] ?? '']));
  }
  async publicEntries(): Promise<ExtensionCatalogEntry[]> {
    return (await this.entries()).map(e => ({ id: e.id, digest: operatorCatalogDigest(e), tools: e.tools, capability: e.capability, secrets: { count: Object.keys(this.secrets(e)).length, configured: Object.values(this.secrets(e)).every(Boolean) } }));
  }
  // eslint-disable-next-line max-params -- catalog identity, digest, tool selection, capability and launch validation are explicit inputs
  async resolve(id: string, digest: string, tools: string[], capability: 'read' | 'write', requireSecrets = true): Promise<OperatorCatalogEntry> {
    const entry = (await this.entries()).find(e => e.id === id);
    if (!entry || operatorCatalogDigest(entry) !== digest) throw new ExtensionError(409, 'Operator catalog entry unavailable or digest changed');
    if (tools.some(t => !entry.tools.includes(t)) || entry.capability !== capability) throw new ExtensionError(403, 'Operator catalog capability unavailable');
    if (requireSecrets && Object.values(this.secrets(entry)).some(v => !v)) throw new ExtensionError(409, 'Operator catalog secrets are not configured');
    return entry;
  }
}
