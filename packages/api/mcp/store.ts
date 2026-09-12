import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secret = (): string => randomBytes(32).toString('base64url');

/** Secrets are encrypted; bearer and refresh tokens are only stored as hashes. */
export class McpStore {
  constructor(public readonly db: Knex, private readonly key: Buffer) {}

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  unseal<T>(value: string): T {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as T;
  }

  async get<T>(kind: string, id: string, database: Knex = this.db): Promise<T | undefined> {
    const row = await database('mcp_records').where({ kind, id }).first();
    if (!row || (row.expires_at && Number(row.expires_at) <= Date.now())) return undefined;
    // A row sealed under a superseded encryption key cannot be read back. Treat
    // it as a miss so callers surface an invalid grant instead of a raw crypto
    // exception escaping the OAuth handlers.
    try { return this.unseal<T>(row.value); } catch { return undefined; }
  }

  async put(kind: string, id: string, value: unknown, { expiresAt, database = this.db }: { expiresAt?: number; database?: Knex } = {}): Promise<void> {
    const owner = value && typeof value === 'object' && 'ownerId' in value && typeof value.ownerId === 'string' ? value.ownerId : null;
    await database('mcp_records').insert({ kind, id, value: this.seal(value), owner_id: owner, expires_at: expiresAt ?? null })
      .onConflict(['kind', 'id']).merge();
  }

  async take<T>(kind: string, id: string, database: Knex): Promise<T | undefined> {
    const value = await this.get<T>(kind, id, database);
    const removed = await database('mcp_records').where({ kind, id }).delete();
    return removed ? value : undefined;
  }
}
