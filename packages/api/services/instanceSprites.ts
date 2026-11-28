import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spritePoolKey } from '@propr/shared';

/**
 * The Sprites this instance's agent pool created, found by their name prefix
 * `propr-<marker>-` (issue #3827 follow-up). Sprites belong to the Sprites
 * organization, not the Fly app, so deleting the app leaves them behind;
 * Settings → Maintenance → Agent runtime removes them first.
 *
 * The marker is the one SpriteInventory uses (packages/core sprites/spritesInventory.ts):
 * Redis `<pool key>:deployment` when a worker has opened the pool, else the
 * file it persisted in DATA_DIR, else (with PROPR_INSTANCE_ID set) the first
 * 16 hex of sha256(pool key). Without any of them this instance never made a Sprite.
 */

export interface InstanceSprite {
  name: string;
  status: string | null;
  createdAt: string | null;
}

export interface SpritesProvider {
  listAllSprites(prefix?: string): Promise<Array<{ name: string; status?: string; createdAt?: Date }>>;
  deleteSprite(name: string): Promise<void>;
}

export interface InstanceSpritesDeps {
  redis: { get(key: string): Promise<string | null> };
  env?: NodeJS.ProcessEnv;
  /** Builds the Sprites client for a token; defaults to the @fly/sprites SDK. */
  createProvider?: (token: string) => Promise<SpritesProvider> | SpritesProvider;
}

const MARKER = /^[0-9a-f]{16}$/;

export function spritesToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.PROPR_SPRITES_TOKEN?.trim() || env.SPRITES_TOKEN?.trim() || undefined;
}

/** `propr-<marker>-`, or undefined when this instance has no Sprite marker yet. */
export async function instanceSpritesPrefix(deps: Pick<InstanceSpritesDeps, 'redis' | 'env'>): Promise<string | undefined> {
  const env = deps.env ?? process.env;
  const key = spritePoolKey(env.PROPR_INSTANCE_ID);
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
  let marker: string | null | undefined;
  try { marker = await deps.redis.get(key + ':deployment'); } catch { marker = undefined; }
  if (!marker || !MARKER.test(marker)) {
    const dir = env.DATA_DIR || path.join(process.cwd(), 'data');
    try { marker = (await readFile(path.join(dir, 'sprites-deployment-' + digest), 'utf8')).trim(); } catch { marker = undefined; }
  }
  if (!marker || !MARKER.test(marker)) marker = env.PROPR_INSTANCE_ID?.trim() ? digest : undefined;
  return marker ? `propr-${marker}-` : undefined;
}

async function defaultProvider(token: string): Promise<SpritesProvider> {
  process.env.SPRITES_CLIENT_SIGNALS ??= '0';
  const { SpritesClient } = await import('@fly/sprites');
  return new SpritesClient(token);
}

export function createInstanceSprites(deps: InstanceSpritesDeps) {
  const env = () => deps.env ?? process.env;
  const provider = (token: string) => (deps.createProvider ?? defaultProvider)(token);

  /** The instance's Sprites, or undefined when no Sprites token is configured. */
  async function list(): Promise<{ prefix: string | undefined; sprites: InstanceSprite[] } | undefined> {
    const token = spritesToken(env());
    if (!token) return undefined;
    const prefix = await instanceSpritesPrefix(deps);
    if (!prefix) return { prefix, sprites: [] };
    const client = await provider(token);
    const sprites = (await client.listAllSprites(prefix))
      .filter(sprite => sprite.name.startsWith(prefix))
      .map(sprite => ({
        name: sprite.name,
        status: sprite.status ?? null,
        createdAt: sprite.createdAt instanceof Date && !Number.isNaN(sprite.createdAt.getTime()) ? sprite.createdAt.toISOString() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { prefix, sprites };
  }

  /** Deletes every named Sprite; a 404 counts as removed. */
  async function remove(names: string[]): Promise<{ deleted: string[]; failed: string[] }> {
    const token = spritesToken(env());
    if (!token) return { deleted: [], failed: names };
    const client = await provider(token);
    const results = await Promise.allSettled(names.map(name => client.deleteSprite(name)));
    const deleted: string[] = [];
    const failed: string[] = [];
    results.forEach((result, index) => {
      const gone = result.status === 'fulfilled' || (result.reason as { statusCode?: number })?.statusCode === 404;
      (gone ? deleted : failed).push(names[index]);
    });
    return { deleted, failed };
  }

  return { list, remove };
}
