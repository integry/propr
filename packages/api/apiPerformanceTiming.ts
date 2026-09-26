import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const MAX_RECORDED_STAGES = 24;
const STAGE_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

interface StageTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface ApiTimingContext {
  startedAt: number;
  stages: Map<string, StageTiming>;
  route?: string;
  sharedMiddlewareMs?: number;
  eventLoopProbeMs?: number;
}

export interface ApiPerformanceTimingRecord {
  method: string;
  route: string;
  status: number;
  totalMs: number;
  sharedMiddlewareMs?: number;
  eventLoopProbeMs?: number;
  stages: Record<string, { count: number; totalMs: number; maxMs: number }>;
}

interface ApiPerformanceMiddlewareOptions {
  sampleRate?: number;
  random?: () => number;
  log?: (record: ApiPerformanceTimingRecord) => void;
}

const timingStorage = new AsyncLocalStorage<ApiTimingContext>();

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function configuredSampleRate(): number {
  const raw = process.env.PROPR_API_TIMING_SAMPLE_RATE?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

function recordStage(context: ApiTimingContext, name: string, elapsedMs: number): void {
  if (!STAGE_NAME_PATTERN.test(name)) return;
  let timing = context.stages.get(name);
  if (!timing) {
    if (context.stages.size >= MAX_RECORDED_STAGES) return;
    timing = { count: 0, totalMs: 0, maxMs: 0 };
    context.stages.set(name, timing);
  }
  timing.count += 1;
  timing.totalMs += elapsedMs;
  timing.maxMs = Math.max(timing.maxMs, elapsedMs);
}

function reserveStage(context: ApiTimingContext, name: string): void {
  if (!STAGE_NAME_PATTERN.test(name) || context.stages.has(name)
    || context.stages.size >= MAX_RECORDED_STAGES) return;
  context.stages.set(name, { count: 0, totalMs: 0, maxMs: 0 });
}

/** Time a named operation only when the current request was selected for profiling. */
export async function timeApiStage<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
  const context = timingStorage.getStore();
  if (!context) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordStage(context, name, performance.now() - startedAt);
  }
}

/** Attribute an Express middleware without changing its success or error behavior. */
export function timeApiMiddleware(name: string, middleware: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const context = timingStorage.getStore();
    if (!context) {
      return middleware(req, res, next);
    }
    if (name === 'authentication' && context.sharedMiddlewareMs === undefined) {
      context.sharedMiddlewareMs = performance.now() - context.startedAt;
    }
    const startedAt = performance.now();
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      recordStage(context, name, performance.now() - startedAt);
    };
    const timedNext: NextFunction = error => {
      complete();
      next(error);
    };
    try {
      const result = middleware(req, res, timedNext);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return Promise.resolve(result).then(() => {
          if (res.headersSent) complete();
        }, timedNext);
      } else if (res.headersSent) {
        complete();
      }
      return result;
    } catch (error) {
      timedNext(error);
      return undefined;
    }
  };
}

/** Attach the static Express route template and time its terminal handler. */
export function timeApiRouteHandler(method: string, route: string, handler: RequestHandler): RequestHandler {
  return timeApiMiddleware('route', (req, res, next) => {
    const context = timingStorage.getStore();
    if (context) {
      context.route = `${method.toUpperCase()} ${route}`;
      // Reserve this high-level stage before detailed route work can consume
      // the bounded stage budget.
      reserveStage(context, 'route');
    }
    return handler(req, res, next);
  });
}

function defaultLog(record: ApiPerformanceTimingRecord): void {
  // The record contains static route/stage labels and aggregate durations only.
  // It deliberately excludes URLs, query strings, headers, bodies and SQL.
  console.info('[api-performance]', record);
}

/**
 * Opt-in, sampled API attribution. A zero sample rate (the default) allocates no
 * request context and emits no logs. PROPR_API_TIMING_SAMPLE_RATE accepts 0..1.
 */
export function createApiPerformanceTimingMiddleware(
  options: ApiPerformanceMiddlewareOptions = {},
): RequestHandler {
  const sampleRate = options.sampleRate ?? configuredSampleRate();
  const random = options.random ?? Math.random;
  const log = options.log ?? defaultLog;
  if (!(sampleRate > 0)) return (_req, _res, next) => next();

  return (req, res, next): void => {
    if (random() >= sampleRate) {
      next();
      return;
    }
    const context: ApiTimingContext = { startedAt: performance.now(), stages: new Map() };
    let logged = false;
    let completionScheduled = false;
    const complete = (): void => {
      if (logged) return;
      logged = true;
      const stages = Object.fromEntries(Array.from(context.stages.entries()).map(([name, timing]) => [
        name,
        { count: timing.count, totalMs: rounded(timing.totalMs), maxMs: rounded(timing.maxMs) },
      ]));
      log({
        method: req.method,
        route: context.route ?? 'unmatched',
        status: res.statusCode,
        totalMs: rounded(performance.now() - context.startedAt),
        ...(context.sharedMiddlewareMs === undefined
          ? {}
          : { sharedMiddlewareMs: rounded(context.sharedMiddlewareMs) }),
        ...(context.eventLoopProbeMs === undefined
          ? {}
          : { eventLoopProbeMs: rounded(context.eventLoopProbeMs) }),
        stages,
      });
    };
    const scheduleComplete = (): void => {
      if (completionScheduled) return;
      completionScheduled = true;
      // Express can emit `finish` from inside res.json(). Let the terminal
      // handler's promise/finalizer record its stage before snapshotting.
      setImmediate(complete);
    };
    res.once('finish', scheduleComplete);
    res.once('close', scheduleComplete);
    timingStorage.run(context, () => {
      setImmediate(() => {
        context.eventLoopProbeMs = performance.now() - context.startedAt;
      });
      next();
    });
  };
}
