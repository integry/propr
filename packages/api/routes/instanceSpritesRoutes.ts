import type { Request, Response } from 'express';
import type { RedisClientType } from 'redis';
import { createInstanceSprites, type InstanceSpritesDeps } from '../services/instanceSprites.js';
import { readSpritePoolStatus } from '../services/spritePoolStatus.js';
import { createRedisSpriteRemovalFence, type SpriteRemovalFence, type SpriteRemovalRedis } from '../services/spriteRemovalFence.js';

/**
 * Settings → Maintenance → Agent runtime: list and remove the Sprites this
 * instance created. Removing them is the step before deleting the Fly app,
 * since Sprites belong to the Sprites organization and outlive the app.
 *
 * The removal names the count the admin confirmed; if the list changed since,
 * nothing is deleted and the new count is returned. A Sprite that is running
 * an agent or being provisioned blocks removal, and so does failing to read
 * that activity: an unknown busy count never authorizes deletion.
 *
 * The busy count is only a snapshot. Before deleting, the removal reserves the
 * Sprites in the pool's inventory in one atomic step that also refuses a busy
 * Sprite, so an idle Sprite cannot be handed to an agent run while it is deleted
 * (services/spriteRemovalFence.ts).
 */

class ActivityUnavailableError extends Error {}

function sendFailure(res: Response, error: unknown, listMessage: string): void {
  if (error instanceof ActivityUnavailableError) {
    res.status(503).json({ error: 'Could not check whether an agent run is using a Sprite; try again', code: 'SPRITES_ACTIVITY_UNAVAILABLE' });
    return;
  }
  res.status(502).json({ error: listMessage, code: 'SPRITES_UNAVAILABLE' });
}

function sendBusy(res: Response, busy: number): void {
  res.status(409).json({ error: 'An agent run is using a Sprite; wait for it to finish, then try again', code: 'SPRITES_BUSY', busy });
}

const LIST_FAILED = 'Could not list Sprites with the configured Sprites token';

export interface InstanceSpritesRouteDeps extends InstanceSpritesDeps {
  /** Busy pool Sprites (in use or provisioning); defaults to the worker's Redis inventory. */
  readBusy?: () => Promise<number>;
  /** Takes the Sprites out of the pool while they are deleted; defaults to the worker's Redis inventory. */
  fence?: SpriteRemovalFence;
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
  const fence = deps.fence ?? createRedisSpriteRemovalFence(deps.redis as unknown as SpriteRemovalRedis, deps.env);

  async function describe(): Promise<InstanceSpritesResponse> {
    const listed = await sprites.list();
    if (!listed) return { configured: false, prefix: null, count: 0, busy: 0, sprites: [] };
    let busy = 0;
    if (listed.sprites.length) {
      try { busy = await readBusy(); }
      catch { throw new ActivityUnavailableError(); }
      if (!Number.isSafeInteger(busy) || busy < 0) throw new ActivityUnavailableError();
    }
    return { configured: true, prefix: listed.prefix ?? null, count: listed.sprites.length, busy, sprites: listed.sprites };
  }

  async function getSprites(_req: Request, res: Response): Promise<void> {
    try {
      res.json(await describe());
    } catch (error) {
      sendFailure(res, error, LIST_FAILED);
    }
  }

  /** Reserves the Sprites against allocation, deletes them, then releases the reservation. */
  async function removeReserved(res: Response, names: string[]): Promise<void> {
    let reservation: Awaited<ReturnType<SpriteRemovalFence['reserve']>>;
    try { reservation = await fence.reserve(names); }
    catch {
      sendFailure(res, new ActivityUnavailableError(), LIST_FAILED);
      return;
    }
    if (!('token' in reservation)) {
      sendBusy(res, reservation.busy);
      return;
    }
    let result: { deleted: string[]; failed: string[] } | undefined;
    try { result = await sprites.remove(names); }
    catch { result = undefined; }
    // Best effort: an unreleased reservation expires and the pool's sweep reconciles the Sprites.
    await fence.release(reservation, result?.deleted ?? [], result?.failed ?? names).catch(() => undefined);
    if (!result) {
      res.status(502).json({ error: 'Could not delete Sprites with the configured Sprites token', code: 'SPRITES_UNAVAILABLE' });
      return;
    }
    res.status(result.failed.length ? 502 : 200).json({
      deleted: result.deleted.length,
      failed: result.failed,
      ...(result.failed.length ? { error: `Could not delete ${result.failed.length} Sprite${result.failed.length === 1 ? '' : 's'}`, code: 'PARTIAL_FAILURE' } : {}),
    });
  }

  async function removeSprites(req: Request, res: Response): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (Object.keys(body).some(key => key !== 'count') || !Number.isSafeInteger(body.count) || (body.count as number) < 1) {
      res.status(400).json({ error: 'Body must be { count: number }, the number of Sprites you confirmed', code: 'INVALID_INPUT' });
      return;
    }
    let current: InstanceSpritesResponse;
    try { current = await describe(); }
    catch (error) {
      sendFailure(res, error, LIST_FAILED);
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
      sendBusy(res, current.busy);
      return;
    }
    await removeReserved(res, current.sprites.map(sprite => sprite.name));
  }

  return { getSprites, removeSprites };
}
