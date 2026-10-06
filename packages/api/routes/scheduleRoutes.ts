import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  countRunningUnattendedWork, createSchedule, deleteSchedule, getSchedule, listScheduleRuns, listSchedules,
  loadUnattendedAdmissionSettings, runScheduleNow, ScheduleNotFoundError, ScheduleValidationError, updateSchedule,
  type ScheduleDependencies, type ScheduleInput, type TaskSchedule,
} from '@propr/core';
import { hasPermission } from '../authorization.js';
import { isDemoMode } from '../demoMode.js';
import { handleGitHubRepositoryAccessError } from '../githubMetadataAuth.js';
import { createScheduleDependencies } from '../services/scheduledTaskDispatch.js';
import { resolveSubmissionRouting } from '../services/taskSubmissionCreation.js';
import { authorizeTaskSubmissionRepository } from './taskSubmissionRoutes.js';

export interface ScheduleRouteServices {
  authorize: typeof authorizeTaskSubmissionRepository;
  routing: typeof resolveSubmissionRouting;
  dependencies: ScheduleDependencies;
  now: () => Date;
}

// Errors raised by these routes' own checks (owner, demo mode, missing schedule)
// carry their status as is; only repository authorization failures go through
// the GitHub access handler, which reports every 403/404 as an inaccessible repository.
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, scheduleRouteError: true });
const isScheduleError = (error: unknown) => (error as { scheduleRouteError?: boolean })?.scheduleRouteError === true
  || error instanceof ScheduleValidationError || error instanceof ScheduleNotFoundError;

/**
 * Schedules for recurring tasks. Anyone who may submit a task to a repository
 * may schedule one there; the schedule's owner, or an instance settings
 * manager, may change, remove or run it.
 */
export function createScheduleRoutes({ db, services = {} }: { db: Knex; services?: Partial<ScheduleRouteServices> }) {
  const authorize = services.authorize ?? authorizeTaskSubmissionRepository;
  const routing = services.routing ?? resolveSubmissionRouting;
  const dependencies = () => services.dependencies ?? createScheduleDependencies(db);
  const now = services.now ?? (() => new Date());

  const sendError = async (req: Request, res: Response, error: unknown) => {
    if (!isScheduleError(error) && await handleGitHubRepositoryAccessError(req, res, error)) return;
    const status = (error as { status?: number }).status || 500;
    res.status(status).json({ error: (error as Error).message });
  };
  const requireWriter = (req: Request) => {
    if (!req.user) throw httpError(401, 'Authentication required');
    if (isDemoMode()) throw httpError(403, 'Demo mode is read-only');
  };
  const loadOwned = async (req: Request): Promise<TaskSchedule> => {
    requireWriter(req);
    const schedule = await getSchedule(db, String(req.params.id));
    if (!schedule) throw httpError(404, 'Schedule not found');
    if (schedule.owner.userId !== String(req.user!.id) && !hasPermission(req, 'instance.manage_settings')) {
      throw httpError(403, 'Only the schedule owner or an instance administrator can change this schedule');
    }
    return schedule;
  };
  const validateInstruction = async (input: Partial<ScheduleInput>) => {
    // Fail at creation time, not at 3 a.m., when the agent/model cannot be routed.
    if (input.instruction && typeof input.instruction === 'object') await routing(input.instruction);
  };
  const admission = async () => {
    const settings = await loadUnattendedAdmissionSettings();
    return { ...settings, running: await countRunningUnattendedWork(db) };
  };

  return {
    async list(req: Request, res: Response) {
      try {
        const repository = typeof req.query.repository === 'string' ? req.query.repository : undefined;
        res.json({ schedules: await listSchedules(db, { repository }), admission: await admission() });
      } catch (error) { await sendError(req, res, error); }
    },
    async get(req: Request, res: Response) {
      try {
        const schedule = await getSchedule(db, String(req.params.id));
        if (!schedule) { res.status(404).json({ error: 'Schedule not found' }); return; }
        res.json({ schedule, runs: await listScheduleRuns(db, schedule.id, Number(req.query.limit) || 20) });
      } catch (error) { await sendError(req, res, error); }
    },
    async create(req: Request, res: Response) {
      try {
        requireWriter(req);
        const input = (req.body ?? {}) as ScheduleInput;
        if (typeof input.repository !== 'string') throw httpError(400, 'repository must be in owner/name format');
        await authorize(req, input.repository.toLowerCase());
        await validateInstruction(input);
        const schedule = await createSchedule(db, input, { userId: String(req.user!.id), username: req.user!.username }, now());
        res.status(201).json({ schedule });
      } catch (error) { await sendError(req, res, error); }
    },
    async update(req: Request, res: Response) {
      try {
        const current = await loadOwned(req);
        const input = (req.body ?? {}) as Partial<ScheduleInput>;
        if (input.repository !== undefined && (typeof input.repository !== 'string' || input.repository.toLowerCase() !== current.repository)) {
          if (typeof input.repository !== 'string') throw httpError(400, 'repository must be in owner/name format');
          await authorize(req, input.repository.toLowerCase());
        }
        await validateInstruction(input);
        res.json({ schedule: await updateSchedule(db, current.id, input, now()) });
      } catch (error) { await sendError(req, res, error); }
    },
    async remove(req: Request, res: Response) {
      try {
        const schedule = await loadOwned(req);
        await deleteSchedule(db, schedule.id);
        res.status(204).end();
      } catch (error) { await sendError(req, res, error); }
    },
    async runNow(req: Request, res: Response) {
      try {
        const schedule = await loadOwned(req);
        const key = req.get('Idempotency-Key');
        if (key !== undefined && (!key || key.length > 128)) throw httpError(400, 'Idempotency-Key must be 1-128 characters');
        const result = await runScheduleNow(db, { ...dependencies(), now }, schedule.id, key);
        res.json(result);
      } catch (error) { await sendError(req, res, error); }
    },
  };
}
