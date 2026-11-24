import { hostname } from 'node:os';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { IDLE_WAKE_SIGNAL_REDIS_KEY, type IdleWakeSource } from '@propr/shared';
import { idleActivity, startIdleActivityPublisher, startIdleShutdownListener } from '@propr/core';

/**
 * The API's part in opt-in idle shutdown (issue #3770):
 *   - count in-flight HTTP and MCP requests and open Socket.IO sessions and
 *     publish them for the daemon's idle detector;
 *   - remember what woke a stopped instance (the first request this process
 *     serves, or the Connect wake ping at `/wake`);
 *   - drain and exit when the daemon announces an idle shutdown (the
 *     existing SIGTERM path, which exits 0).
 */

/** Probes that must neither count as activity nor as a wake. */
const PASSIVE_PATHS = new Set(['/health', '/wake']);
/** A wake signal older than this no longer describes the current start. */
const WAKE_SIGNAL_TTL_SECONDS = 5 * 60;

function isMcpPath(path: string): boolean {
  return path === '/mcp' || path.startsWith('/mcp/') || path === '/api/mcp' || path.startsWith('/api/mcp/');
}

export function classifyIdleRequest(path: string): 'mcp' | 'http' | null {
  if (PASSIVE_PATHS.has(path)) return null;
  return isMcpPath(path) ? 'mcp' : 'http';
}

/** Record the wake source once; the first writer (this or another process) wins. */
async function recordWakeSignal(redis: Pick<Redis, 'set'>, source: IdleWakeSource): Promise<void> {
  await redis.set(IDLE_WAKE_SIGNAL_REDIS_KEY, source, 'EX', WAKE_SIGNAL_TTL_SECONDS, 'NX').catch(() => undefined);
}

/** How long a quiesced API tells clients to wait before retrying. */
const QUIESCED_RETRY_AFTER_SECONDS = 5;
/** How long the quiesce phase waits for in-flight requests before acknowledging (the daemon then sees them and aborts). */
export const API_QUIESCE_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Counts every non-probe request until its response closes; the first one
 * may be the wake. While the daemon's idle drain has quiesced the API, a new
 * request is turned away with 503 (and recorded as activity, so the daemon
 * aborts the drain and the client's retry is served).
 */
export function createIdleActivityMiddleware(getRedis: () => Pick<Redis, 'set'> | null): RequestHandler {
  let firstRequestSeen = false;
  return (req: Request, res: Response, next: NextFunction) => {
    const kind = classifyIdleRequest(req.path);
    if (kind && idleActivity.quiescedIntent !== null) {
      idleActivity.touch();
      res.setHeader('Retry-After', String(QUIESCED_RETRY_AFTER_SECONDS));
      res.status(503).json({ error: 'ProPR is checking whether it can stop while idle; retry shortly.' });
      return;
    }
    if (kind) {
      const end = idleActivity.begin(kind);
      res.once('close', end);
      res.once('finish', end);
      if (!firstRequestSeen) {
        firstRequestSeen = true;
        const redis = getRedis();
        if (redis) void recordWakeSignal(redis, 'http');
      }
    }
    next();
  };
}

/**
 * `/wake`: the Connect wake ping (integry/propr-routing#335). Reaching the
 * process is the whole point — on Fly the request itself starts the Machine —
 * so it answers at once, records the wake source and has no other effect.
 */
export function createWakeHandler(getRedis: () => Pick<Redis, 'set'> | null): RequestHandler {
  return (_req: Request, res: Response) => {
    const redis = getRedis();
    if (redis) void recordWakeSignal(redis, 'connect_ping');
    res.status(202).json({ status: 'awake' });
  };
}

/**
 * Start publishing activity and follow the daemon's drain requests: quiesce
 * (stop admitting requests, wait for the ones in flight, publish a current
 * record), resume, or stop.
 */
export function startApiIdleShutdown(options: {
  redis: Redis;
  countSessions: () => number;
  log?: { info(obj: object, msg: string): void; warn?(obj: object, msg: string): void };
}): () => Promise<void> {
  idleActivity.setSessionCounter(options.countSessions);
  const id = `${hostname()}:${process.pid}`;
  const publisher = startIdleActivityPublisher(options.redis, { role: 'api', id });
  // Duplicates keep the API's Redis URL and credentials for the listener's connections.
  const listener = startIdleShutdownListener({
    role: 'api',
    id,
    createConnection: () => options.redis.duplicate() as never,
    onQuiesce: async intent => {
      idleActivity.quiesce(intent.id);
      const drained = await idleActivity.waitForDrain(API_QUIESCE_DRAIN_TIMEOUT_MS);
      // The daemon re-checks this record next; a failed write leaves it stale, which aborts the drain.
      const published = await publisher.publish();
      options.log?.info({ drained, published }, 'Idle shutdown: API quiesced');
    },
    onResume: () => {
      idleActivity.resume();
      void publisher.publish();
    },
    log: options.log,
  });
  return async () => {
    idleActivity.resume();
    await publisher.stop();
    await listener.stop();
  };
}
