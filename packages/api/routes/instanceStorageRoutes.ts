import { taskHistoryControl } from '../../core/src/storage/taskHistoryControl.js';
import type { Request, Response, RequestHandler } from 'express';
import path from 'node:path';
import { db, getIndexingQueue, getIssueQueue, getGitHubInstallationToken, loadMonitoredReposRaw } from '@propr/core';
import { InstanceStorageService, StorageContractError } from '../../core/src/storage/service.js';
import { repositoryStorageLifecycle, StorageBusyError, storageControlRoot } from '../../core/src/storage/lifecycle.js';
import { getRescueBundleDirectory, getSalvageRetentionRecordDirectory } from '../../core/src/git/rescueRefs.js';
import type { StorageCategory } from '@propr/shared';

const categories = new Set<StorageCategory>(['database_config', 'repository_caches', 'worktrees', 'salvage', 'logs_artifacts', 'provider_credentials', 'task_history']);

export function createDefaultStorageService(): InstanceStorageService {
  const databaseFile = process.env.DB_FILENAME ?? path.join(process.env.DATA_DIR ?? path.resolve('data'), 'propr.sqlite');
  return new InstanceStorageService({
    lifecycle: repositoryStorageLifecycle,
    storageRoot: storageControlRoot(),
    clonesRoot: process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones',
    roots: [
      { category: 'database_config', path: databaseFile },
      { category: 'database_config', path: `${databaseFile}-wal` },
      { category: 'database_config', path: `${databaseFile}-shm` },
      { category: 'database_config', path: storageControlRoot() },
      { category: 'database_config', path: repositoryStorageLifecycle.root },
      { category: 'repository_caches', path: process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones' },
      { category: 'worktrees', path: process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees' },
      { category: 'salvage', path: getRescueBundleDirectory() },
      { category: 'salvage', path: getSalvageRetentionRecordDirectory() },
    ],
    remoteToken: getGitHubInstallationToken,
    repositoryInventory: async () => [...new Set((await loadMonitoredReposRaw()).map(repository => repository.name))],
    taskHistory: taskHistoryControl(db),
    hasPendingTasks: async () => {
      // Fail closed on either unavailable queue or database. Failed jobs are retained:
      // a recovery/retry may still own their work, even if a terminal row looks idle.
      const queues = await Promise.all([getIssueQueue(), getIndexingQueue()]);
      for (const queue of queues) {
        const counts = await queue.getJobCounts('active', 'wait', 'waiting-children', 'delayed', 'prioritized', 'paused', 'failed');
        if (Object.values(counts).some(count => count > 0)) return true;
      }
      const pending = await db('tasks as t').whereNotExists(function () {
        this.select(db.raw('1')).from('task_history as h').whereRaw('h.task_id = t.task_id')
          .whereIn('h.state', ['completed', 'cancelled'])
          .whereRaw('h.history_id = (SELECT MAX(h2.history_id) FROM task_history h2 WHERE h2.task_id = t.task_id)');
      }).first('t.task_id');
      if (pending) return true;
      return Boolean(await db('task_submissions').where({ dispatch_complete: false }).first('id'));
    },
  });
}

export function createInstanceStorageRoutes(service: InstanceStorageService) {
  const handle = (run: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    // Defense in depth: installation/repository grants do not establish instance authority.
    if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
    if (req.authorization?.role !== 'admin' || !req.authorization.permissions.includes('instance.manage_settings')) { res.status(403).json({ error: 'Instance administration required' }); return; }
    if (req.method !== 'GET' && (req.get('X-ProPR-Storage') !== '1' || !req.is('application/json'))) {
      res.status(403).json({ error: 'Storage mutations require the preflight-protected JSON contract' }); return;
    }
    try { await run(req, res); }
    catch (error) {
      const status = error instanceof StorageContractError ? error.status : error instanceof StorageBusyError ? 409 : 503;
      res.status(status).json({ error: error instanceof StorageContractError ? error.message : 'Storage operation unavailable; data retained' });
    }
  };
  const exactBody = (req: Request, keys: string[]) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !keys.includes(key))) throw new StorageContractError(400, 'Invalid storage request');
  };
  return {
    usage: handle(async (_req, res) => { res.json(await service.usage()); }),
    policy: handle(async (_req, res) => { res.json({ version: 1, instanceId: await service.initialize(), policy: await service.policy() }); }),
    updatePolicy: handle(async (req, res) => {
      exactBody(req, ['instanceId', 'enabled', 'idleHours']);
      const policy = await service.updatePolicy(req.body.instanceId, { enabled: req.body.enabled, idleHours: req.body.idleHours }, req.user!.id);
      res.json({ version: 1, instanceId: req.body.instanceId, policy });
    }),
    preview: handle(async (req, res) => {
      exactBody(req, ['instanceId', 'categories', 'taskIds']);
      if (!Array.isArray(req.body.categories) || req.body.categories.some((value: StorageCategory) => !categories.has(value))) throw new StorageContractError(400, 'Invalid storage categories');
      if (req.body.taskIds !== undefined && !Array.isArray(req.body.taskIds)) throw new StorageContractError(400, 'Invalid task selection');
      res.json(await service.preview(req.body.instanceId, req.body.categories, req.user!.id, req.body.taskIds));
    }),
    execute: handle(async (req, res) => {
      exactBody(req, ['instanceId', 'confirmation']);
      res.json(await service.execute(req.body.instanceId, req.body.confirmation, req.user!.id));
    }),
    result: handle(async (req, res) => {
      res.json(await service.result(String(req.query.instanceId ?? ''), String(req.params.operationId), req.user!.id));
    }),
  };
}
