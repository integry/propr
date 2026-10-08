import { createHash, randomUUID } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { Octokit } from '@octokit/core';
import type { Request, RequestHandler, Response } from 'express';
import type { Knex } from 'knex';
import {
  AttachmentService, AgentRegistry, getAuthenticatedOctokit, loadMonitoredReposRaw,
  loadPrimaryProcessingLabels, resolvePlanIssueDefaultSelection, safeAddLabel, logger,
  insertTaskSubmission, resumeTaskSubmission, completeTodosForIssue, submissionMarker, submissionAssetPath, resolveVisualPreviewUploadToken,
  type MulterFile, type SubmissionAttachment, type SubmissionPayload, type TaskSubmission,
} from '@propr/core';
import { resolveGitHubMetadataToken, handleGitHubRepositoryAccessError } from '../githubMetadataAuth.js';
import { isDemoMode } from '../demoMode.js';
import { getLlmLabel, enqueueIssueImplementationJob } from './planIssueHelpers.js';
import { goalAttachmentUpload } from './plannerRoutes.js';
import { goalUploadIdentity, removeTemporaryGoalUploads } from '../services/goalAttachmentService.js';
import { githubInlineEligibility, MAX_RUN_COST_CAP_USD, VISUAL_PREVIEW_CONTENT_TYPES } from '@propr/shared';
import { uploadGitHubAttachment } from '../../../src/github/visualPreviewAttachments.js';

export const taskSubmissionUpload: RequestHandler = (req, res, next) => {
  goalAttachmentUpload(req, res, error => {
    if (!error) { next(); return; }
    const files = (Array.isArray(req.files) ? req.files : []) as MulterFile[];
    void removeTemporaryGoalUploads(files).finally(() => res.status(400).json({ error: (error as Error).message }));
  });
};

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicSubmission = (row: TaskSubmission) => ({
  id: row.id, state: row.state, issueNumber: row.issue_number, issueUrl: row.issue_url,
  taskId: row.task_id, error: row.error,
});

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

async function routing(body: { agentAlias?: string; model?: string }) {
  const registry = AgentRegistry.getInstance();
  await registry.ensureInitialized();
  const defaults = !body.agentAlias ? await resolvePlanIssueDefaultSelection() : null;
  const agentAlias = body.agentAlias || defaults?.agent_alias;
  const agent = agentAlias ? registry.getAgentByAlias(agentAlias) : undefined;
  const model = body.model || (body.agentAlias ? agent?.config.defaultModel : defaults?.model_name);
  if (!agent?.config.enabled || !model || !agent.config.supportedModels.includes(model)) {
    throw Object.assign(new Error('Selected agent or model is no longer available. Choose a supported selection in Options.'), { status: 400 });
  }
  const label = await getLlmLabel(model, agent.config.alias);
  if (!label) throw Object.assign(new Error('Selected agent/model cannot be routed through GitHub issues'), { status: 400 });
  return { agentAlias: agent.config.alias, model, routingLabel: label };
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

type SubmissionOctokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
type SubmissionCoordinates = { owner: string; repo: string };

export interface SubmissionImageUploadServices {
  resolveToken?: () => Promise<string>;
  upload?: typeof uploadGitHubAttachment;
}

/**
 * Hosts submitted images as GitHub attachments, the same way pull request
 * previews are published, so the issue renders them inline. This is best
 * effort: the worktree delivery stays authoritative when uploads fail.
 */
export async function uploadSubmissionImages(octokit: SubmissionOctokit, coordinates: SubmissionCoordinates, files: SubmissionAttachment[],
  { resolveToken = resolveVisualPreviewUploadToken, upload = uploadGitHubAttachment }: SubmissionImageUploadServices = {}): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const images = files.flatMap(file => {
    const contentType = VISUAL_PREVIEW_CONTENT_TYPES[file.extension.toLowerCase()];
    if (!contentType?.startsWith('image/')) return [];
    const body = Buffer.from(file.content, 'base64');
    return githubInlineEligibility(contentType, body.byteLength).eligible ? [{ file, contentType, body }] : [];
  });
  if (!images.length) return urls;
  const repository = `${coordinates.owner}/${coordinates.repo}`;
  let authToken: string;
  let repositoryId: number;
  try {
    authToken = await resolveToken();
    repositoryId = (await octokit.request('GET /repos/{owner}/{repo}', coordinates)).data.id;
  } catch (error) {
    logger.warn({ error: (error as Error).message, repository }, 'Submitted images will not be embedded in the issue');
    return urls;
  }
  for (const { file, contentType, body } of images) {
    try {
      urls.set(file.id, await upload({ name: `${file.id}${file.extension}`, contentType, body, authToken, repositoryId }));
    } catch (error) {
      logger.warn({ error: (error as Error).message, repository, attachmentId: file.id }, 'Could not embed a submitted image in the issue');
    }
  }
  return urls;
}

// Attachment names are user input; keep them inert inside Markdown image text.
const imageAltText = (name: string) => name.replace(/\s+/g, ' ').replace(/[\\[\]<>]/g, '\\$&');

export function submissionIssueBody(row: TaskSubmission, payload: SubmissionPayload, files: SubmissionAttachment[], imageUrls: ReadonlyMap<string, string> = new Map()): string {
  const references = files.map(file => `- ${JSON.stringify(file.originalName)}: ${submissionAssetPath(file, row.id)}`).join('\n');
  const previews = files.flatMap(file => imageUrls.has(file.id) ? [`![${imageAltText(file.originalName)}](${imageUrls.get(file.id)})`] : []).join('\n\n');
  const attachments = references ? `\n\nAttachments (delivered to the task worktree):\n${references}${previews ? `\n\n${previews}` : ''}` : '';
  return `${payload.instruction}\n\n---\nSubmitted by @${payload.username} through ProPR.${attachments}\n${submissionMarker(row.id)}`;
}

// Preserve the instruction's first line up to the issue-title limit used by
// the planner. Longer instructions need an explicit ellipsis, not a cut word.
export function submissionIssueTitle(instruction: string): string {
  const title = instruction.trim().split('\n')[0].trim();
  if (!title) return 'New task';
  if (title.length <= 256) return title;
  const words = title.match(/\S+/g) ?? [];
  let shortened = '';
  for (const word of words) {
    const next = shortened ? `${shortened} ${word}` : word;
    if (next.length > 253) break;
    shortened = next;
  }
  if (!shortened) {
    // A single long word still needs to fit without splitting a surrogate pair.
    for (const character of title) {
      if (shortened.length + character.length > 253) break;
      shortened += character;
    }
  }
  return `${shortened}...`;
}

function submissionServices(octokit: SubmissionOctokit, enqueue = enqueueIssueImplementationJob, images?: SubmissionImageUploadServices) {
  const coordinates = (row: TaskSubmission) => { const [owner, repo] = row.repository.split('/'); return { owner, repo }; };
  return {
    async createIssue(row: TaskSubmission) {
      const payload = JSON.parse(row.payload) as SubmissionPayload;
      const files = JSON.parse(row.attachments) as SubmissionAttachment[];
      const body = submissionIssueBody(row, payload, files, await uploadSubmissionImages(octokit, coordinates(row), files, images));
      const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
        ...coordinates(row), title: submissionIssueTitle(payload.instruction), body,
        // No trigger label until the durable association and all routing are ready.
        labels: [],
      });
      return { number: data.number, url: data.html_url };
    },
    async reconcileIssue(row: TaskSubmission) {
      // Use the repository listing, not the eventually indexed search API.
      for (let page = 1; ; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues', { ...coordinates(row), state: 'all', per_page: 100, page });
        const found = data.find(issue => !issue.pull_request && issue.body?.includes(submissionMarker(row.id)));
        if (found) return { number: found.number, url: found.html_url };
        if (data.length < 100) return null;
      }
    },
    async dispatch(row: TaskSubmission, recovering: boolean) {
      const payload = JSON.parse(row.payload) as SubmissionPayload;
      // A trigger can already have been consumed and removed by a worker. Check
      // the timeline, not just current labels, before replaying an interrupted write.
      let triggered = false;
      if (recovering) {
        for (let page = 1; ; page++) {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
            ...coordinates(row), issue_number: row.issue_number!, per_page: 100, page,
          });
          triggered = data.some(event => event.event === 'labeled' && 'label' in event && event.label?.name === payload.trigger);
          if (triggered || data.length < 100) break;
        }
      }
      const context = { octokit, ...coordinates(row), issueNumber: row.issue_number!, logger: logger.withCorrelation(row.id) };
      if (!triggered) {
        // Automation labels precede the trigger so the worker sees every opt-in
        // through the same labelling path a planned issue uses.
        for (const label of [payload.routingLabel, ...(payload.baseBranch ? [`base-${payload.baseBranch}`] : []),
          ...(payload.autoMerge ? ['auto-merge'] : []), ...(payload.runUltrafix ? ['ultrafix'] : [])]) {
          if (!await safeAddLabel(context, label)) throw new Error('Could not apply task routing. Retry to start the existing issue.');
        }
        if (!await safeAddLabel(context, payload.trigger)) throw new Error('Could not trigger implementation. Retry to start the existing issue.');
      }
      await enqueue({ ...coordinates(row), issueNumber: row.issue_number!, userId: row.user_id, triggeringLabel: payload.trigger, correlationId: row.id });
    },
  };
}

interface SubmissionRequest {
  repository: string;
  instruction: string;
  agentAlias?: string;
  model?: string;
  todoIds?: string[];
  autoMerge?: boolean;
  runUltrafix?: boolean;
  ultrafixGoal?: number;
  ultrafixMaxCycles?: number;
  /** Per-task spend cap in USD; 0 or omitted uses the repository/instance cap. */
  maxCostUsd?: number;
}

// Keep the bounds identical to the plan implementation contract.
const ULTRAFIX_GOAL_RANGE = [1, 10] as const;
const ULTRAFIX_MAX_CYCLES_RANGE = [1, 10] as const;

const invalidFlag = (value: unknown) => value !== undefined && typeof value !== 'boolean';
const invalidCostCap = (value: unknown) => value !== undefined
  && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RUN_COST_CAP_USD);
const invalidBound = (value: unknown, [min, max]: readonly [number, number]) =>
  value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max);

function invalidSubmissionOptions(body: SubmissionRequest) {
  return (body.agentAlias !== undefined && typeof body.agentAlias !== 'string')
    || (body.model !== undefined && typeof body.model !== 'string')
    || (body.todoIds !== undefined && (!Array.isArray(body.todoIds) || body.todoIds.some((id: unknown) => typeof id !== 'string')))
    || invalidFlag(body.autoMerge) || invalidFlag(body.runUltrafix)
    || invalidBound(body.ultrafixGoal, ULTRAFIX_GOAL_RANGE) || invalidBound(body.ultrafixMaxCycles, ULTRAFIX_MAX_CYCLES_RANGE);
}

/** A spend cap is part of the submission identity only when one is set, so existing fingerprints are unchanged. */
function submissionBudget(body: SubmissionRequest) {
  return body.maxCostUsd ? { maxCostUsd: body.maxCostUsd } : {};
}

/**
 * Automation opt-ins reuse the shared issue labels, so they are also part of the
 * submission identity. Absent options keep an existing submission's fingerprint.
 */
function submissionAutomation(body: SubmissionRequest) {
  return {
    ...(body.autoMerge ? { autoMerge: true as const } : {}),
    ...(body.runUltrafix
      ? { runUltrafix: true as const, ultrafixGoal: body.ultrafixGoal ?? null, ultrafixMaxCycles: body.ultrafixMaxCycles ?? null }
      : {}),
  };
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

/**
 * Completes the to-dos a submission was launched from once its issue exists
 * and records that issue on them. The submission's receipt commits with the
 * to-do update, so duplicate POSTs and retries never reapply it over a later
 * reopen or relaunch, while a failed update stays retryable. This is
 * bookkeeping only: the issue and run already exist, so a failure is logged
 * and never reported.
 */
export async function linkSubmissionTodos(db: Knex, row: TaskSubmission, complete: typeof completeTodosForIssue = completeTodosForIssue): Promise<void> {
  if (!row.issue_number || row.todos_linked) return;
  let todoIds: string[] = [];
  try {
    todoIds = (JSON.parse(row.payload) as SubmissionPayload).todoIds ?? [];
    if (!todoIds.length) return;
    await db.transaction(async trx => {
      const claimed = await trx('task_submissions').where({ id: row.id, todos_linked: false }).update({ todos_linked: true });
      if (!claimed) return;
      await complete({ todoIds, userId: row.user_id, repository: row.repository, issueNumber: row.issue_number!, taskId: row.task_id }, trx);
    });
  } catch (error) {
    logger.warn({ error: (error as Error).message, submissionId: row.id, todoIds, issueNumber: row.issue_number }, 'Could not complete to-dos for a launched task');
  }
}

export function createTaskSubmissionRoutes({ db, services = {} }: { db: Knex; services?: Partial<{
  authorize: typeof authorizeTaskSubmissionRepository;
  routing: typeof routing;
  getOctokit: typeof getAuthenticatedOctokit;
  processingLabels: typeof loadPrimaryProcessingLabels;
  enqueue: typeof enqueueIssueImplementationJob;
  images: SubmissionImageUploadServices;
  completeTodos: typeof completeTodosForIssue;
}> }) {
  const checkAccess = services.authorize ?? authorizeTaskSubmissionRepository;
  const resolveRouting = services.routing ?? routing;
  const getOctokit = services.getOctokit ?? getAuthenticatedOctokit;
  const processingLabels = services.processingLabels ?? loadPrimaryProcessingLabels;
  const resume = async (id: string) => {
    const result = await resumeTaskSubmission(db, id, submissionServices(await getOctokit(), services.enqueue, services.images));
    await linkSubmissionTodos(db, result, services.completeTodos);
    return result;
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
      const payloadHash = fingerprint({ repository, instruction: body.instruction, agentAlias: body.agentAlias || '', model: body.model || '', todoIds: body.todoIds || [], files: await goalUploadIdentity(files), ...submissionAutomation(body), ...submissionBudget(body) });
      let row = await db<TaskSubmission>('task_submissions').where({ user_id: String(req.user!.id), submission_key: key }).first();
      if (row && row.payload_hash !== payloadHash) { res.status(409).json({ error: 'Submission identity was already used with different content' }); return; }
      if (!row) {
        const selection = await resolveRouting(body);
        const octokit = await getOctokit();
        const [owner, repo] = repository.split('/');
        await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        const payload: SubmissionPayload = { instruction: body.instruction, ...selection, baseBranch: config.baseBranch,
          trigger: (await processingLabels())[0] || 'AI', username: req.user!.username, todoIds: body.todoIds,
          ...submissionAutomation(body), ...submissionBudget(body) };
        let attachments: SubmissionAttachment[];
        try { attachments = await storeUploads(files); }
        catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
        row = await insertTaskSubmission(db, { user_id: String(req.user!.id), submission_key: key, payload_hash: payloadHash,
          repository, payload: JSON.stringify(payload), attachments: JSON.stringify(attachments) });
      }
      const result = await resume(row.id);
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
      await resolveRouting(payload);
      res.json(publicSubmission(await resume(row.id)));
    } catch (error) { await sendError(req, res, error); }
  };
  return { submit, get, retry };
}
