import { z } from 'zod';
import { component } from './schemas.js';
import type { RouteDoc } from './types.js';

const InstanceSprite = z.object({
  name: z.string().describe('Starts with the instance prefix `propr-<marker>-`.'),
  status: z.string().nullable(),
  createdAt: z.string().meta({ format: 'date-time' }).nullable(),
});

export const InstanceSprites = component('InstanceSprites', z.object({
  configured: z.boolean().describe('A Sprites token (`SPRITES_TOKEN` or `PROPR_SPRITES_TOKEN`) is set on this instance.'),
  prefix: z.string().nullable().describe('Name prefix of this instance\'s Sprites; null until the agent pool has a marker.'),
  count: z.number().int(),
  busy: z.number().int().describe('Pool Sprites running an agent or being provisioned; these block removal.'),
  sprites: z.array(InstanceSprite),
}), 'The Sprites this instance created, from the Sprites organization of its token.');

export const InstanceSpritesRemoveRequest = component('InstanceSpritesRemoveRequest', z.object({
  count: z.number().int().min(1).describe('The number of Sprites the administrator confirmed.'),
}).strict(), 'Remove every Sprite of this instance.');

export const InstanceSpritesRemoved = component('InstanceSpritesRemoved', z.object({
  deleted: z.number().int(),
  failed: z.array(z.string()).describe('Names that could not be deleted.'),
}).loose(), 'Result of removing this instance\'s Sprites.');

/** Instance Sprites cleanup before deleting a deployment (issue #3827 follow-up). */
export const INSTANCE_SPRITES_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/admin/sprites': {
    operationId: 'listInstanceSprites',
    summary: 'List the Sprites this instance created',
    description: 'Sprites belong to the Sprites organization, not the Fly app, so they outlive a deleted app. Lists Sprites named `propr-<marker>-*` with the instance\'s Sprites token.',
    tags: ['Administration'],
    responses: {
      200: { description: 'The instance\'s Sprites; `configured: false` without a Sprites token.', schema: InstanceSprites },
      502: { description: 'The Sprites API refused or could not be reached; code `SPRITES_UNAVAILABLE`.' },
      503: { description: 'The agent pool activity could not be read, so `busy` is unknown; code `SPRITES_ACTIVITY_UNAVAILABLE`.' },
    },
  },
  'POST /api/admin/sprites/remove': {
    operationId: 'removeInstanceSprites',
    summary: 'Remove all Sprites of this instance',
    description: 'Run before deleting the deployment. Deletes nothing when the current count differs from the confirmed one, while a Sprite runs an agent, or when that activity cannot be read.',
    tags: ['Administration'],
    requestBody: { schema: InstanceSpritesRemoveRequest },
    responses: {
      200: { description: 'Every Sprite was deleted.', schema: InstanceSpritesRemoved },
      400: { description: 'The body is not `{ count }` with a positive integer.' },
      409: { description: 'Code `COUNT_CHANGED` (with the current `count`), `SPRITES_BUSY` or `SPRITES_NOT_CONFIGURED`.' },
      502: { description: 'Some Sprites could not be deleted (`PARTIAL_FAILURE`, with `failed`), or the Sprites API failed (`SPRITES_UNAVAILABLE`).' },
      503: { description: 'The agent pool activity could not be read; nothing is deleted. Code `SPRITES_ACTIVITY_UNAVAILABLE`.' },
    },
  },
};
