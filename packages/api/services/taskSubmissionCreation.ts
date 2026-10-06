import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
  AgentRegistry, getAuthenticatedOctokit, loadPrimaryProcessingLabels, resolvePlanIssueDefaultSelection, safeAddLabel, logger,
  insertTaskSubmission, resumeTaskSubmission, submissionMarker, submissionAssetPath, resolveVisualPreviewUploadToken,
  type SubmissionAttachment, type SubmissionPayload, type TaskSubmission,
} from '@propr/core';
import { getLlmLabel, enqueueIssueImplementationJob } from '../routes/planIssueHelpers.js';
import { githubInlineEligibility, MAX_RUN_COST_CAP_USD, VISUAL_PREVIEW_CONTENT_TYPES } from '@propr/shared';
import { uploadGitHubAttachment } from '../../../src/github/visualPreviewAttachments.js';

/**
 * The task submission path shared by the REST route, MCP and scheduled tasks:
 * resolve routing, persist an idempotent submission, create the GitHub issue
 * and dispatch it to a worker. Callers own authentication and authorization.
 */

export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const publicSubmission = (row: TaskSubmission) => ({
  id: row.id, state: row.state, issueNumber: row.issue_number, issueUrl: row.issue_url,
  taskId: row.task_id, error: row.error,
});

export async function resolveSubmissionRouting(body: { agentAlias?: string; model?: string }) {
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

export type SubmissionOctokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
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

// Schedule names are user input; keep them on one line of plain text.
const scheduleLabel = (name: string) => name.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>]/g, '\\$&');

// Attachment names are user input; keep them inert inside Markdown image text.
const imageAltText = (name: string) => name.replace(/\s+/g, ' ').replace(/[\\[\]<>]/g, '\\$&');

export function submissionIssueBody(row: TaskSubmission, payload: SubmissionPayload, files: SubmissionAttachment[], imageUrls: ReadonlyMap<string, string> = new Map()): string {
  const references = files.map(file => `- ${JSON.stringify(file.originalName)}: ${submissionAssetPath(file, row.id)}`).join('\n');
  const previews = files.flatMap(file => imageUrls.has(file.id) ? [`![${imageAltText(file.originalName)}](${imageUrls.get(file.id)})`] : []).join('\n\n');
  const attachments = references ? `\n\nAttachments (delivered to the task worktree):\n${references}${previews ? `\n\n${previews}` : ''}` : '';
  const scheduled = payload.scheduleName ? `Scheduled: ${scheduleLabel(payload.scheduleName)}\n` : '';
  return `${payload.instruction}\n\n---\n${scheduled}Submitted by @${payload.username} through ProPR.${attachments}\n${submissionMarker(row.id)}`;
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

export function submissionServices(octokit: SubmissionOctokit, enqueue = enqueueIssueImplementationJob, images?: SubmissionImageUploadServices) {
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

export interface SubmissionRequest {
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
export const invalidCostCap = (value: unknown) => value !== undefined
  && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_RUN_COST_CAP_USD);
const invalidBound = (value: unknown, [min, max]: readonly [number, number]) =>
  value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max);

export function invalidSubmissionOptions(body: SubmissionRequest) {
  return (body.agentAlias !== undefined && typeof body.agentAlias !== 'string')
    || (body.model !== undefined && typeof body.model !== 'string')
    || (body.todoIds !== undefined && (!Array.isArray(body.todoIds) || body.todoIds.some((id: unknown) => typeof id !== 'string')))
    || invalidFlag(body.autoMerge) || invalidFlag(body.runUltrafix)
    || invalidBound(body.ultrafixGoal, ULTRAFIX_GOAL_RANGE) || invalidBound(body.ultrafixMaxCycles, ULTRAFIX_MAX_CYCLES_RANGE);
}

/** A spend cap is part of the submission identity only when one is set, so existing fingerprints are unchanged. */
export function submissionBudget(body: SubmissionRequest) {
  return body.maxCostUsd ? { maxCostUsd: body.maxCostUsd } : {};
}

/**
 * Automation opt-ins reuse the shared issue labels, so they are also part of the
 * submission identity. Absent options keep an existing submission's fingerprint.
 */
export function submissionAutomation(body: SubmissionRequest) {
  return {
    ...(body.autoMerge ? { autoMerge: true as const } : {}),
    ...(body.runUltrafix
      ? { runUltrafix: true as const, ultrafixGoal: body.ultrafixGoal ?? null, ultrafixMaxCycles: body.ultrafixMaxCycles ?? null }
      : {}),
  };
}

export interface TaskSubmissionServices {
  routing: typeof resolveSubmissionRouting;
  getOctokit: typeof getAuthenticatedOctokit;
  processingLabels: typeof loadPrimaryProcessingLabels;
  enqueue?: typeof enqueueIssueImplementationJob;
  images?: SubmissionImageUploadServices;
}

export const defaultTaskSubmissionServices: TaskSubmissionServices = {
  routing: resolveSubmissionRouting,
  getOctokit: getAuthenticatedOctokit,
  processingLabels: loadPrimaryProcessingLabels,
};

export interface PrepareTaskSubmissionInput {
  /** The user the submission is recorded for: the requester, or a schedule's owner. */
  actor: { id: string; username: string };
  /** Submission identity: the request's Idempotency-Key, or `schedule:<id>:<slot>`. */
  key: string;
  /** Lowercased `owner/name` of an enabled, configured repository. */
  repository: string;
  baseBranch?: string;
  body: SubmissionRequest;
  /** Identity of uploaded files, part of the submission fingerprint. */
  fileIdentity?: unknown;
  /** Persists uploaded files; only called when the submission is new. */
  storeFiles?: () => Promise<SubmissionAttachment[]>;
  schedule?: { id: string; name: string };
}

/** Finds or creates the submission for an identity. Reusing an identity with different content is a 409. */
export async function prepareTaskSubmission(db: Knex, input: PrepareTaskSubmissionInput, services: TaskSubmissionServices = defaultTaskSubmissionServices): Promise<TaskSubmission> {
  const { actor, key, repository, body, schedule } = input;
  const payloadHash = fingerprint({ repository, instruction: body.instruction, agentAlias: body.agentAlias || '', model: body.model || '', todoIds: body.todoIds || [], files: input.fileIdentity ?? [], ...submissionAutomation(body), ...submissionBudget(body), ...(schedule ? { scheduleId: schedule.id } : {}) });
  const existing = await db<TaskSubmission>('task_submissions').where({ user_id: actor.id, submission_key: key }).first();
  if (existing && existing.payload_hash !== payloadHash) throw Object.assign(new Error('Submission identity was already used with different content'), { status: 409 });
  if (existing) return existing;
  const selection = await services.routing(body);
  const octokit = await services.getOctokit();
  const [owner, repo] = repository.split('/');
  await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
  const payload: SubmissionPayload = { instruction: body.instruction, ...selection, baseBranch: input.baseBranch,
    trigger: (await services.processingLabels())[0] || 'AI', username: actor.username, todoIds: body.todoIds,
    ...submissionAutomation(body), ...submissionBudget(body),
    ...(schedule ? { scheduleId: schedule.id, scheduleName: schedule.name } : {}) };
  let attachments: SubmissionAttachment[] = [];
  if (input.storeFiles) {
    try { attachments = await input.storeFiles(); }
    catch (error) { throw Object.assign(error as Error, { status: 400 }); }
  }
  return insertTaskSubmission(db, { user_id: actor.id, submission_key: key, payload_hash: payloadHash,
    repository, payload: JSON.stringify(payload), attachments: JSON.stringify(attachments),
    ...(schedule ? { schedule_id: schedule.id } : {}) });
}

/** Creates the issue and dispatches the task, resuming from wherever the submission stopped. */
export async function startTaskSubmission(db: Knex, row: TaskSubmission, services: TaskSubmissionServices = defaultTaskSubmissionServices): Promise<TaskSubmission> {
  return resumeTaskSubmission(db, row.id, submissionServices(await services.getOctokit(), services.enqueue, services.images));
}
