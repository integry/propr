import { randomUUID } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { Octokit } from '@octokit/core';
import type { Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import {
  AttachmentService, getAuthenticatedOctokit, loadMonitoredReposRaw, loadPrimaryProcessingLabels,
  type MulterFile, type SubmissionAttachment, type SubmissionPayload, type TaskSubmission,
} from '@propr/core';
import { resolveGitHubMetadataToken, handleGitHubRepositoryAccessError } from '../githubMetadataAuth.js';
import { isDemoMode } from '../demoMode.js';
import type { enqueueIssueImplementationJob } from './planIssueHelpers.js';
import { goalAttachmentUpload } from './plannerRoutes.js';
import { goalUploadIdentity, removeTemporaryGoalUploads } from '../services/goalAttachmentService.js';
import { MAX_RUN_COST_CAP_USD } from '@propr/shared';
import {
  invalidCostCap, invalidSubmissionOptions, prepareTaskSubmission, publicSubmission, resolveSubmissionRouting, startTaskSubmission,
  type SubmissionImageUploadServices, type SubmissionRequest, type TaskSubmissionServices,
} from '../services/taskSubmissionCreation.js';

export {
  submissionIssueBody, submissionIssueTitle, uploadSubmissionImages, type SubmissionImageUploadServices,
} from '../services/taskSubmissionCreation.js';

export const taskSubmissionUpload: RequestHandler = (req, res, next) => {
  goalAttachmentUpload(req, res, error => {
    if (!error) { next(); return; }
    const files = (Array.isArray(req.files) ? req.files : []) as MulterFile[];
    void removeTemporaryGoalUploads(files).finally(() => res.status(400).json({ error: (error as Error).message }));
  });
};

async function userRepository(req: Request, repository: string) {
  const token = await resolveGitHubMetadataToken(req);
  const [owner, repo] = repository.split('/');
  return (await new Octokit({ auth: token }).request('GET /repos/{owner}/{repo}', { owner, repo })).data;
}

export async function authorizeTaskSubmissionRepository(req: Request, repository: string, lookup = userRepository, repositories = loadMonitoredReposRaw) {
  if (!req.user) throw Object.assign(new Error('Authentication required'), { status: 401 });
  if (isDemoMode()) throw Object.assign(new Error('Demo mode is read-only'), { status: 403 });
  const data = await lookup(req, repository);
  if (!data.permissions?.push && !data.permissions?.admin && !data.permissions?.maintain) {
    throw Object.assign(new Error('Repository implementation requires write access'), { status: 403 });
  }
  const config = (await repositories()).find(candidate => candidate.enabled && candidate.name.toLowerCase() === repository.toLowerCase());
  if (!config) throw Object.assign(new Error('Select an enabled repository configured for this instance'), { status: 400 });
  return config;
}

async function storeUploads(files: MulterFile[]): Promise<SubmissionAttachment[]> {
  const stored: SubmissionAttachment[] = [];
  for (const file of files) {
    // Reuse the supported image/text processing contract. Persist bytes with the
    // submission so delivery does not depend on an API host's temporary disk.
    const uploadId = randomUUID();
    const attachment = await AttachmentService.processUpload(file, uploadId, { storageRoot: path.join(process.cwd(), 'storage', 'task-submissions'), persistAttachment: async () => undefined });
    try {
      stored.push({ id: attachment.id, originalName: attachment.originalName, mimeType: attachment.mimeType,
        extension: path.extname(attachment.storedPath), content: (await fs.readFile(attachment.storedPath)).toString('base64') });
    } finally { await fs.remove(path.dirname(path.resolve(attachment.storedPath))); }
  }
  return stored;
}

function parseSubmissionRequest(req: Request): { body: SubmissionRequest; key: string } {
  const body = typeof req.body?.payload === 'string' ? JSON.parse(req.body.payload) : (req.body || {});
  const key = req.get('Idempotency-Key');
  if (!body || typeof body !== 'object' || !key || key.length > 255 || typeof body.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(body.repository)
    || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 50_000
    || invalidSubmissionOptions(body)) {
    throw Object.assign(new Error('A submission identity, repository and instruction (up to 50,000 characters) are required'), { status: 400 });
  }
  if (invalidCostCap(body.maxCostUsd)) {
    throw Object.assign(new Error(`maxCostUsd must be a USD amount from 0 to ${MAX_RUN_COST_CAP_USD}`), { status: 400 });
  }
  if (body.runUltrafix !== true && (body.ultrafixGoal !== undefined || body.ultrafixMaxCycles !== undefined)) {
    throw Object.assign(new Error('runUltrafix must be true when ultrafixGoal or ultrafixMaxCycles is set'), { status: 400 });
  }
  return { body, key };
}

export function createTaskSubmissionRoutes({ db, services = {} }: { db: Knex; services?: Partial<{
  authorize: typeof authorizeTaskSubmissionRepository;
  routing: typeof resolveSubmissionRouting;
  getOctokit: typeof getAuthenticatedOctokit;
  processingLabels: typeof loadPrimaryProcessingLabels;
  enqueue: typeof enqueueIssueImplementationJob;
  images: SubmissionImageUploadServices;
}> }) {
  const checkAccess = services.authorize ?? authorizeTaskSubmissionRepository;
  const submissionServices: TaskSubmissionServices = {
    routing: services.routing ?? resolveSubmissionRouting,
    getOctokit: services.getOctokit ?? getAuthenticatedOctokit,
    processingLabels: services.processingLabels ?? loadPrimaryProcessingLabels,
    enqueue: services.enqueue,
    images: services.images,
  };
  const sendError = async (req: Request, res: Response, error: unknown) => {
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid request payload' }); return; }
    if (await handleGitHubRepositoryAccessError(req, res, error)) return;
    res.status((error as { status?: number }).status || 500).json({ error: (error as Error).message });
  };
  const submit = async (req: Request, res: Response) => {
    const files = (Array.isArray(req.files) ? req.files : []) as MulterFile[];
    try {
      if (!req.user) { res.status(401).json({ error: 'Authentication required' }); return; }
      if (isDemoMode()) { res.status(403).json({ error: 'Demo mode is read-only' }); return; }
      const { body, key } = parseSubmissionRequest(req);
      const repository = body.repository.toLowerCase();
      const config = await checkAccess(req, repository);
      const row = await prepareTaskSubmission(db, {
        actor: { id: String(req.user!.id), username: req.user!.username }, key, repository, baseBranch: config.baseBranch, body,
        fileIdentity: await goalUploadIdentity(files), storeFiles: () => storeUploads(files),
      }, submissionServices);
      const result = await startTaskSubmission(db, row, submissionServices);
      res.status(result.state === 'queued' ? 200 : 202).json(publicSubmission(result));
    } catch (error) { await sendError(req, res, error); }
    finally { await removeTemporaryGoalUploads(files); }
  };
  const get = async (req: Request, res: Response) => {
    const row = await db<TaskSubmission>('task_submissions').where({ submission_key: String(req.params.key), user_id: String(req.user?.id) }).first();
    if (!row) { res.status(404).json({ error: 'Submission not found' }); return; }
    res.json(publicSubmission(row));
  };
  const retry = async (req: Request, res: Response) => {
    try {
      const row = await db<TaskSubmission>('task_submissions').where({ submission_key: String(req.params.key), user_id: String(req.user?.id) }).first();
      if (!row) { res.status(404).json({ error: 'Submission not found' }); return; }
      await checkAccess(req, row.repository);
      const payload = JSON.parse(row.payload) as SubmissionPayload;
      await submissionServices.routing(payload);
      res.json(publicSubmission(await startTaskSubmission(db, row, submissionServices)));
    } catch (error) { await sendError(req, res, error); }
  };
  return { submit, get, retry };
}
