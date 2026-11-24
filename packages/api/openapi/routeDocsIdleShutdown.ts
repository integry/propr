import { z } from 'zod';
import { IDLE_SIGNALS } from '@propr/shared';
import { component } from './schemas.js';
import type { RouteDoc } from './types.js';

const isoDateTime = z.string().meta({ format: 'date-time' });
const nullableIso = isoDateTime.nullable();

const IdleBlocker = z.object({
  signal: z.enum(IDLE_SIGNALS),
  detail: z.string(),
});

export const IdleShutdownStatus = component('IdleShutdownStatus', z.object({
  enabled: z.boolean(),
  afterMs: z.number().int(),
  source: z.enum(['environment', 'settings', 'default']),
  idle: z.boolean().describe('Whether every signal is quiet and nothing is due within the window.'),
  idleSince: nullableIso,
  shutdownAt: nullableIso.describe('When the instance stops if nothing changes; null while not idle or when disabled.'),
  blockers: z.array(IdleBlocker).describe('What keeps the instance awake right now.'),
  nextDueAt: nullableIso.describe('Next due time of scheduled work: the wake hint published before an idle exit.'),
  checkedAt: isoDateTime,
  lastShutdown: z.object({ shutdownAt: isoDateTime, reason: z.string(), idleForMs: z.number(), nextDueAt: nullableIso }).nullable(),
  lastWake: z.object({
    wokeAt: isoDateTime,
    source: z.enum(['http', 'connect_ping', 'schedule', 'unknown']),
    coldStartMs: z.number().describe('Process start to daemon ready.'),
    sleptMs: z.number().nullable(),
    shutdownAt: nullableIso,
  }).nullable(),
}).loose(), 'The daemon\'s idle detector status, refreshed every 30 seconds.');

export const IdleShutdownSettings = component('IdleShutdownSettings', z.object({
  enabled: z.boolean().describe('Effective switch. Off unless an operator turns it on.'),
  afterMs: z.number().int(),
  after: z.string().describe('The window in `.env` form, for example `15m`.'),
  source: z.enum(['environment', 'settings', 'default']),
  environmentManaged: z.boolean().describe('`PROPR_IDLE_SHUTDOWN` or `PROPR_IDLE_SHUTDOWN_AFTER` is set, so the setting cannot be changed here.'),
  environment: z.record(z.string(), z.string().nullable()),
  warnings: z.array(z.string()),
  status: IdleShutdownStatus.nullable().describe('Null until the daemon has published a status.'),
}), 'Idle shutdown setting and live status.');

export const IdleShutdownSettingsRequest = component('IdleShutdownSettingsRequest', z.object({
  enabled: z.boolean(),
  after: z.string().optional().describe('Duration between `1m` and `24h`, for example `15m` or `1h30m`. Keeps the saved value when omitted.'),
}).strict(), 'Change the idle shutdown instance setting.');

export const IdleWakeAccepted = component('IdleWakeAccepted', z.object({
  status: z.literal('awake'),
}), 'The instance is running.');

/** Opt-in idle shutdown (issue #3770). */
export const IDLE_SHUTDOWN_ROUTE_DOCS: Record<string, RouteDoc> = {
  'GET /api/admin/idle-shutdown': {
    operationId: 'getIdleShutdownSettings',
    summary: 'Read the idle shutdown setting and what keeps the instance awake',
    description: 'Off by default. The environment (`PROPR_IDLE_SHUTDOWN`, `PROPR_IDLE_SHUTDOWN_AFTER`) wins over the instance setting. See docs/operations/idle-shutdown.',
    tags: ['Administration'],
    responses: { 200: { description: 'The effective setting and the daemon\'s latest status.', schema: IdleShutdownSettings } },
  },
  'PUT /api/admin/idle-shutdown': {
    operationId: 'updateIdleShutdownSettings',
    summary: 'Turn idle shutdown on or off and set the idle window',
    description: 'The daemon applies the change on its next check (within 30 seconds).',
    tags: ['Administration'],
    requestBody: { schema: IdleShutdownSettingsRequest },
    responses: {
      200: { description: 'The saved setting.', schema: IdleShutdownSettings },
      400: { description: 'The body is not `{ enabled, after? }` or `after` is not a duration between 1m and 24h.' },
      409: { description: 'The setting is pinned by the environment; code `ENVIRONMENT_MANAGED`.' },
    },
  },
  'POST /wake': {
    operationId: 'wakeInstance',
    summary: 'Wake ping for an instance that stops when idle',
    description: 'Public and side-effect free: reaching the process is the point (on Fly the request starts the Machine). Records `connect_ping` as the wake source.',
    tags: ['System'],
    responses: { 202: { description: 'The instance is running.', schema: IdleWakeAccepted } },
  },
};
