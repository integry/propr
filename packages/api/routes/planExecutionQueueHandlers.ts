import type { Response } from 'express';
import type { FlatRequest } from '../requestTypes.js';
import { getEpicExecutionQueue, summarizeEpicQueue } from '@propr/core';
import { parseProjectSlug } from '@propr/shared';
import { parseContextConfig, parseImplementationSettingsOverrides, resolveImplementationSettings } from './planIssueRouteUtils.js';
import { enqueueRemainingBehindRunning } from './planIssueEpicQueue.js';
import { sendImplementIssueError, type PlanIssueDeps } from './planIssueHandlers.js';
/** Reports which issues the plan's sequential execution queue still owns, so the UI can mark them queued. */
export function createGetExecutionQueueHandler(deps: PlanIssueDeps) {
  return async function getExecutionQueue(req: FlatRequest, res: Response): Promise<void> {
    try {
      const ownership = await deps.verifyOwnership(req.params.id, req.user!.id, ['user_id']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      res.json({ queue: summarizeEpicQueue(await getEpicExecutionQueue(req.params.id)) });
    } catch (error) {
      console.error('Get execution queue error:', error);
      res.status(500).json({ error: 'Failed to fetch execution queue' });
    }
  };
}
/** Queues the remaining pending issues behind the running ones; the queue starts each as its predecessor finishes. */
export function createQueueRemainingHandler(deps: PlanIssueDeps) {
  return async function queueRemaining(req: FlatRequest, res: Response): Promise<void> {
    const draftId = req.params.id;
    try {
      const ownership = await deps.verifyOwnership(draftId, req.user!.id, ['user_id', 'repository', 'context_config']);
      if (!ownership.authorized) { res.status(ownership.status!).json({ error: ownership.error }); return; }
      const repositoryParts = parseProjectSlug(ownership.draft!.repository as string);
      if (!repositoryParts) { res.status(400).json({ error: 'Invalid repository format' }); return; }
      const { settings, error } = parseImplementationSettingsOverrides(req.body ?? {});
      if (error) { res.status(400).json({ error }); return; }
      const contextConfig = parseContextConfig(ownership.draft!.context_config);
      const { useEpic, autoMerge } = resolveImplementationSettings(settings, contextConfig);
      const result = await enqueueRemainingBehindRunning({ draftId, repository: `${repositoryParts.owner}/${repositoryParts.repo}`,
        useEpic, autoMerge, contextConfig });
      res.json({ ...result, queue: summarizeEpicQueue(await getEpicExecutionQueue(draftId)) });
    } catch (error) {
      sendImplementIssueError(res, error);
    }
  };
}
