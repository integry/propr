import type { Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import { createInstanceSprites, type InstanceSpritesDeps } from '../services/instanceSprites.js';
import { readSpritePoolStatus } from '../services/spritePoolStatus.js';

/**
 * Settings → Maintenance → Agent runtime: list and remove the Sprites this
 * instance created. Removing them is the step before deleting the Fly app,
 * since Sprites belong to the Sprites organization and outlive the app.
 *
 * The removal names the count the admin confirmed; if the list changed since,
 * nothing is deleted and the new count is returned. A Sprite that is running
 * an agent or being provisioned blocks removal.
 */

export interface InstanceSpritesRouteDeps extends InstanceSpritesDeps {
  /** Busy pool Sprites (in use or provisioning); defaults to the worker's Redis inventory. */
  readBusy?: () => Promise<number>;
}

export interface InstanceSpritesResponse {
  configured: boolean;
  prefix: string | null;
  count: number;
  busy: number;
  sprites: Array<{ name: string; status: string | null; createdAt: string | null }>;
}

export function createInstanceSpritesRoutes(deps: InstanceSpritesRouteDeps) {
  const sprites = createInstanceSprites(deps);
  const readBusy = deps.readBusy ?? (async () => {
    const status = await readSpritePoolStatus(deps.redis as unknown as Pick<RedisClientType, 'eval'>);
    return status ? status.inUse + status.provisioning : 0;
  });

  async function describe(): Promise<InstanceSpritesResponse> {
    const listed = await sprites.list();
    if (!listed) return { configured: false, prefix: null, count: 0, busy: 0, sprites: [] };
    const busy = listed.sprites.length ? await readBusy().catch(() => 0) : 0;
    return { configured: true, prefix: listed.prefix ?? null, count: listed.sprites.length, busy, sprites: listed.sprites };
  }

  async function getSprites(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await describe());
    } catch {
      res.status(502).json({ error: 'Could not list Sprites with the configured Sprites token', code: 'SPRITES_UNAVAILABLE' });
    }
  }

  async function removeSprites(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== 'count') || !Number.isSafeInteger(body.count) || (body.count as number) < 1) {
      res.status(400).json({ error: 'Body must be { count: number }, the number of Sprites you confirmed', code: 'INVALID_INPUT' });
      return;
    }
    let current: InstanceSpritesResponse;
    try { current = await describe(); }
    catch {
      res.status(502).json({ error: 'Could not list Sprites with the configured Sprites token', code: 'SPRITES_UNAVAILABLE' });
      return;
    }
    if (!current.configured) {
      res.status(409).json({ error: 'No Sprites token is configured on this instance', code: 'SPRITES_NOT_CONFIGURED' });
      return;
    }
    if (current.count !== body.count) {
      res.status(409).json({ error: `This instance now has ${current.count} Sprite${current.count === 1 ? '' : 's'}; confirm again`, code: 'COUNT_CHANGED', count: current.count });
      return;
    }
    if (current.busy > 0) {
      res.status(409).json({ error: 'An agent run is using a Sprite; wait for it to finish, then try again', code: 'SPRITES_BUSY', busy: current.busy });
      return;
    }
    try {
      const result = await sprites.remove(current.sprites.map(sprite => sprite.name));
      res.status(result.failed.length ? 502 : 200).json({
        deleted: result.deleted.length,
        failed: result.failed,
        ...(result.failed.length ? { error: `Could not delete ${result.failed.length} Sprite${result.failed.length === 1 ? '' : 's'}`, code: 'PARTIAL_FAILURE' } : {}),
      });
    } catch {
      res.status(502).json({ error: 'Could not delete Sprites with the configured Sprites token', code: 'SPRITES_UNAVAILABLE' });
    }
  }

  return { getSprites, removeSprites };
}
