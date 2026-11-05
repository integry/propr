import type { Request, RequestHandler, Response } from 'express';
import { REPOSITORY_REGEX } from './validation.js';

/** Identifies one PR follow-up publication handoff; repository is lowercase `owner/repo`. */
export interface FollowupHandoffKey {
  repository: string;
  pull_request: number;
}

export interface FollowupHandoffRecoverySummary {
  inspected: number;
  published: number;
  noChanges: number;
  settled: number;
  cleanupPending: number;
  skippedLiveAgent: number;
  failedClosed: number;
  awaitingOperator: number;
  lockedByOtherWriter: number;
  errors: number;
}

/** The record fields this admin surface exposes; the stored row carries more. */
export interface FollowupHandoffRecordFields {
  repository: string;
  pull_request: number;
  task_id: string;
  phase: string;
  status: string;
  status_reason: string | null;
  settlement?: string | null;
  operator_authorized: number;
  branch_name: string;
  worktree_path: string;
  commit_hash: string | null;
  completion_comment_url: string | null;
  updated_at: number;
}

export interface FollowupHandoffStatus {
  record: FollowupHandoffRecordFields;
  liveness: string;
  nextAction: string;
  predecessorTaskIds: string[];
  successorTaskId: string | null;
}

/**
 * The five backend recovery entry points (src/jobs/followupHandoffRecovery.ts),
 * injectable so tests stub them. Production wiring loads the real module
 * lazily via `createDefaultFollowupHandoffDeps`; the functions self-provision
 * their database and Redis connections when called with an empty deps object.
 */
export interface FollowupHandoffRouteDeps {
  recoverInterruptedFollowupHandoffs(deps?: object, key?: FollowupHandoffKey): Promise<FollowupHandoffRecoverySummary>;
  inspectFollowupHandoffs(deps?: object, key?: FollowupHandoffKey): Promise<FollowupHandoffStatus[]>;
  authorizeCancelledFollowupHandoff(key: FollowupHandoffKey, deps?: object): Promise<FollowupHandoffRecordFields | null>;
  resumeOperatorHeldFollowupHandoff(key: FollowupHandoffKey, deps?: object): Promise<{ resumed: boolean; reason?: string }>;
  releaseFollowupHandoffRecord(key: FollowupHandoffKey, options: { force?: boolean }, deps?: object): Promise<{ released: boolean; reason?: string }>;
}

/**
 * Kept as a value (not an import literal) so the root jobs tree stays out of
 * the packages/api TypeScript program; the admin routes compile against the
 * local `FollowupHandoffRouteDeps` contract and bind to the real module at
 * call time. followupHandoffRoutes.test.ts asserts the path resolves.
 */
export const FOLLOWUP_HANDOFF_RECOVERY_MODULE = '../../../src/jobs/followupHandoffRecovery.js';

const loadRecoveryModule = async (): Promise<FollowupHandoffRouteDeps> =>
  await import(FOLLOWUP_HANDOFF_RECOVERY_MODULE) as FollowupHandoffRouteDeps;

export function createDefaultFollowupHandoffDeps(): FollowupHandoffRouteDeps {
  return {
    recoverInterruptedFollowupHandoffs: async (deps, key) => (await loadRecoveryModule()).recoverInterruptedFollowupHandoffs(deps, key),
    inspectFollowupHandoffs: async (deps, key) => (await loadRecoveryModule()).inspectFollowupHandoffs(deps, key),
    authorizeCancelledFollowupHandoff: async (key, deps) => (await loadRecoveryModule()).authorizeCancelledFollowupHandoff(key, deps),
    resumeOperatorHeldFollowupHandoff: async (key, deps) => (await loadRecoveryModule()).resumeOperatorHeldFollowupHandoff(key, deps),
    releaseFollowupHandoffRecord: async (key, options, deps) => (await loadRecoveryModule()).releaseFollowupHandoffRecord(key, options, deps),
  };
}

const PULL_REQUEST_NUMBER_REGEX = /^[1-9]\d{0,9}$/;

/** Strictly scoped target from `:owner/:repo/:pr`; null when the params are not a sane PR address. */
export function followupHandoffTargetKey(params: { owner?: string; repo?: string; pr?: string }): FollowupHandoffKey | null {
  const owner = String(params.owner ?? '');
  const repo = String(params.repo ?? '');
  const pr = String(params.pr ?? '');
  if (!REPOSITORY_REGEX.test(`${owner}/${repo}`) || !PULL_REQUEST_NUMBER_REGEX.test(pr)) return null;
  return { repository: `${owner}/${repo}`.toLowerCase(), pull_request: Number(pr) };
}

/**
 * Operator-facing status. The retained worktree host path is exposed
 * deliberately: every route here is admin-only (guarded by
 * `instance.manage_runtime` plus the in-handler defense below). Host paths
 * must never appear on member routes.
 */
function toStatusPayload(status: FollowupHandoffStatus) {
  return {
    repository: status.record.repository,
    pullRequest: status.record.pull_request,
    taskId: status.record.task_id,
    predecessorTaskIds: status.predecessorTaskIds,
    successorTaskId: status.successorTaskId,
    phase: status.record.phase,
    status: status.record.status,
    statusReason: status.record.status_reason,
    settlement: status.record.settlement ?? null,
    operatorAuthorized: Boolean(status.record.operator_authorized),
    liveness: status.liveness,
    branchName: status.record.branch_name,
    commitHash: status.record.commit_hash,
    completionCommentUrl: status.record.completion_comment_url,
    nextAction: status.nextAction,
    retainedWorktreePath: status.record.worktree_path,
    updatedAt: status.record.updated_at,
  };
}

export function createFollowupHandoffRoutes(deps: FollowupHandoffRouteDeps) {
  // Defense in depth: the route registry already applies requireManageRuntime,
  // but every handler re-checks so a wiring mistake cannot expose host paths.
  const handle = (run: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    if (!req.user?.id) { res.status(401).json({ error: 'Authentication required' }); return; }
    if (req.authorization?.role !== 'admin' || !req.authorization.permissions.includes('instance.manage_runtime')) {
      res.status(403).json({ error: 'Instance runtime administration required' }); return;
    }
    res.set('Cache-Control', 'no-store');
    try { await run(req, res); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'Follow-up handoff operation failed; the record is retained' }); }
  };

  const target = (req: Request, res: Response): FollowupHandoffKey | null => {
    const key = followupHandoffTargetKey(req.params as { owner?: string; repo?: string; pr?: string });
    if (!key) res.status(400).json({ error: 'Invalid follow-up handoff target; expected /:owner/:repo/:pr' });
    return key;
  };

  const flag = (req: Request, res: Response, name: string): boolean | undefined => {
    const body: Record<string, unknown> = req.body && typeof req.body === 'object' ? req.body : {};
    const value = body[name];
    if (value !== undefined && typeof value !== 'boolean') {
      res.status(400).json({ error: `${name} must be a boolean` });
      return undefined;
    }
    return value === true;
  };

  const inspectOne = async (key: FollowupHandoffKey) => {
    const [status] = await deps.inspectFollowupHandoffs({}, key);
    return status ? toStatusPayload(status) : null;
  };

  return {
    list: handle(async (_req, res) => {
      const statuses = await deps.inspectFollowupHandoffs({});
      res.json({ handoffs: statuses.map(toStatusPayload) });
    }),

    get: handle(async (req, res) => {
      const key = target(req, res);
      if (!key) return;
      const status = await inspectOne(key);
      if (!status) { res.status(404).json({ error: 'Follow-up handoff not found' }); return; }
      res.json({ status });
    }),

    resume: handle(async (req, res) => {
      const key = target(req, res);
      if (!key) return;
      const authorizeCancelled = flag(req, res, 'authorizeCancelled');
      if (authorizeCancelled === undefined) return;
      if (authorizeCancelled) {
        const record = await deps.authorizeCancelledFollowupHandoff(key);
        if (!record) {
          res.status(409).json({ error: 'The handoff is missing, not operator-held, changed, or its pull request lease is held by another writer; cancellation authorization was not granted', code: 'cancellation_authorization_unavailable' });
          return;
        }
      } else {
        const resumed = await deps.resumeOperatorHeldFollowupHandoff(key);
        if (!resumed.resumed) {
          if (resumed.reason === 'not_found') { res.status(404).json({ error: 'Follow-up handoff not found', code: 'not_found' }); return; }
          const hint = resumed.reason === 'requires_cancellation_authorization'
            ? 'The work was cancelled by the user; resume with authorizeCancelled to publish it'
            : 'The handoff cannot be resumed';
          res.status(409).json({ error: hint, code: resumed.reason ?? 'not_resumable' });
          return;
        }
      }
      // Strictly keyed: this recovery pass touches only the addressed PR.
      const summary = await deps.recoverInterruptedFollowupHandoffs({}, key);
      res.json({ summary, status: await inspectOne(key) });
    }),

    release: handle(async (req, res) => {
      const key = target(req, res);
      if (!key) return;
      const force = flag(req, res, 'force');
      if (force === undefined) return;
      const result = await deps.releaseFollowupHandoffRecord(key, { force });
      if (result.released) { res.json({ released: true }); return; }
      if (result.reason === 'not_found') { res.status(404).json({ error: 'Follow-up handoff not found', code: 'not_found' }); return; }
      res.status(409).json({ released: false, reason: result.reason });
    }),
  };
}
