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

/** Counts every non-probe request until its response closes; the first one may be the wake. */
export function createIdleActivityMiddleware(getRedis: () => Pick<Redis, 'set'> | null): RequestHandler {
  let firstRequestSeen = false;
  return (req: Request, res: Response, next: NextFunction) => {
    const kind = classifyIdleRequest(req.path);
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

/** Start publishing activity and listening for the daemon's shutdown request. */
export function startApiIdleShutdown(options: {
  redis: Redis;
  countSessions: () => number;
  log?: { info(obj: object, msg: string): void };
}): () => Promise<void> {
  idleActivity.setSessionCounter(options.countSessions);
  const stopPublisher = startIdleActivityPublisher(options.redis, { role: 'api', id: `${hostname()}:${process.pid}` });
  // A duplicate keeps the API's Redis URL and credentials for the subscriber connection.
  const stopListener = startIdleShutdownListener({ redis: options.redis.duplicate(), log: options.log });
  return async () => {
    await stopPublisher();
    await stopListener();
  };
}
