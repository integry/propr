import sharp from 'sharp';
import { z } from 'zod';
import { McpError } from './config.js';
import { applyTaskVisibility } from './taskListing.js';
import type { McpTool, ToolDeps } from './tools.js';
import {
  listPublishedPreviews,
  loadPublishedPreview,
  PreviewMediaError,
  type PreviewAssociation,
} from '../services/previewMediaFetch.js';
import {
  latestCommentMetadata,
  previewMediaReader,
  taskPreviewSource,
} from '../services/previewMediaProjection.js';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_RENDERED_BYTES = 750 * 1024;
const QUALITY_STEPS = [80, 60, 45] as const;
const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(255);
const previewIdSchema = z.string().regex(/^(?:pull|comment):[1-9][0-9]*:[A-Za-z0-9_-]+$/).max(280);
const formatSchema = z.enum(['webp', 'jpeg', 'png']);
type PreviewFormat = z.infer<typeof formatSchema>;

export interface VisualPreviewToolServices {
  reader?: Pick<typeof previewMediaReader, 'enabledRepositories'>;
  fetch?: typeof globalThis.fetch;
}

interface RenderedPreview {
  body: Buffer;
  width: number;
  height: number;
  mimeType: string;
}

function previewError(error: PreviewMediaError): McpError {
  const validation = ['PREVIEW_NOT_FOUND', 'PREVIEWS_DISABLED', 'PREVIEW_NOT_RENDERABLE', 'PREVIEW_TOO_LARGE'].includes(error.code);
  return new McpError(error.code, error.message, error.status, {
    stage: validation ? 'validation' : 'github',
    retryable: error.code === 'PREVIEW_UNAVAILABLE',
  });
}

async function withPreviewErrors<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof PreviewMediaError) throw previewError(error);
    throw error;
  }
}

function parsePreviewId(repository: string, previewId: string): { association: PreviewAssociation; assetId: string } {
  const [kind, numberValue, assetId, extra] = previewId.split(':');
  const number = Number(numberValue);
  if (extra !== undefined || (kind !== 'pull' && kind !== 'comment')
    || !Number.isSafeInteger(number) || number < 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId || '')) {
    throw new McpError('PREVIEW_NOT_FOUND', 'Preview media not found.', 404, { stage: 'validation' });
  }
  return { association: { kind, repository, number }, assetId };
}

async function renderImage(source: Buffer, format: PreviewFormat, requestedDimension: number): Promise<RenderedPreview> {
  let dimension = requestedDimension;
  try {
    while (dimension >= 1) {
      const qualities: ReadonlyArray<number | undefined> = format === 'png' ? [undefined] : QUALITY_STEPS;
      for (const quality of qualities) {
        let pipeline = sharp(source, { animated: false, page: 0, pages: 1 })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
        if (format === 'webp') pipeline = pipeline.webp({ quality });
        else if (format === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality });
        else pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
        const encoded = await pipeline.toBuffer({ resolveWithObject: true });
        if (encoded.data.byteLength <= MAX_RENDERED_BYTES) {
          return {
            body: encoded.data,
            width: encoded.info.width,
            height: encoded.info.height,
            mimeType: `image/${format}`,
          };
        }
      }
      const reduced = Math.max(1, Math.floor(dimension * 0.75));
      if (reduced === dimension) break;
      dimension = reduced;
    }
  } catch {
    throw new PreviewMediaError(422, 'PREVIEW_NOT_RENDERABLE', 'Preview image could not be rendered.');
  }
  throw new PreviewMediaError(413, 'PREVIEW_TOO_LARGE', 'Preview image could not fit within the MCP response limit.');
}

async function taskAssociation(deps: ToolDeps, repository: string, taskId: string, userId: string): Promise<PreviewAssociation> {
  const query = deps.db('tasks').where({ 'tasks.task_id': taskId, 'tasks.repository': repository });
  applyTaskVisibility(deps.db, query, userId);
  const task = await query.first('tasks.*');
  if (!task) throw new McpError('NOT_FOUND', 'Task not found.', 404, { stage: 'validation' });
  const history = await deps.db('task_history').where({ task_id: taskId }).orderBy('history_id').select('metadata');
  const source = taskPreviewSource({ ...task, latest_metadata: latestCommentMetadata(history) });
  if (source.isFollowUp && source.commentId) {
    return { kind: 'comment', repository, number: source.commentId };
  }
  const pullRequest = source.prNumbers[0];
  if (!source.isFollowUp && pullRequest) return { kind: 'pull', repository, number: pullRequest };
  throw new McpError('PREVIEW_NOT_FOUND', 'No published preview association was found for this task.', 404, { stage: 'validation' });
}

export function addVisualPreviewTools(tools: McpTool[], deps: ToolDeps): void {
  const reader = deps.visualPreviews?.reader ?? previewMediaReader;
  const fetcher = deps.visualPreviews?.fetch ?? globalThis.fetch;
  const listSchema = z.object({
    repository: repositorySchema,
    taskId: z.string().min(1).max(255).optional(),
    pullRequest: z.number().int().min(1).optional(),
  }).strict().refine(args => Number(args.taskId !== undefined) + Number(args.pullRequest !== undefined) === 1, {
    message: 'Provide exactly one of taskId or pullRequest.',
  });

  tools.push({
    name: 'list_visual_previews',
    description: 'List published visual preview metadata for exactly one task or pull request. Videos are metadata-only.',
    scope: 'read',
    readOnly: true,
    schema: listSchema,
    target: { table: 'tasks', column: 'task_id', arg: 'taskId' },
    run: async ({ principal, args }) => {
      const repository = String(args.repository);
      const association = args.taskId
        ? await taskAssociation(deps, repository, String(args.taskId), principal.user.id)
        : { kind: 'pull' as const, repository, number: Number(args.pullRequest) };
      const enabled = (await reader.enabledRepositories([repository])).has(repository.trim().toLowerCase());
      if (!enabled) return { status: 200, data: { association, previews: [], previewsEnabled: false } };
      const previews = await withPreviewErrors(() => listPublishedPreviews({ association, octokit: principal.github, reader }));
      return { status: 200, data: {
        association,
        previews: previews.map(preview => ({
          previewId: `${association.kind}:${association.number}:${preview.assetId}`,
          type: preview.type,
          title: preview.title,
          description: preview.description ?? '',
          fetchable: preview.type === 'image',
        })),
        previewsEnabled: true,
      } };
    },
  });

  tools.push({
    name: 'get_visual_preview',
    description: 'Fetch one published image preview as bounded, downscaled MCP image content. Video previews must be opened on GitHub.',
    scope: 'read',
    readOnly: true,
    schema: z.object({
      repository: repositorySchema,
      previewId: previewIdSchema,
      maxDimension: z.number().int().min(256).max(1568).default(1024),
      format: formatSchema.default('webp'),
    }).strict(),
    run: async ({ principal, args }) => withPreviewErrors(async () => {
      const repository = String(args.repository);
      const previewId = String(args.previewId);
      const { association, assetId } = parsePreviewId(repository, previewId);
      if (!principal.user.accessToken) {
        throw new McpError('GITHUB_CREDENTIAL_REQUIRED', 'Sign in through the browser to authorize GitHub access.', 401, { stage: 'authorization' });
      }
      const loaded = await loadPublishedPreview({
        association,
        assetId,
        token: principal.user.accessToken,
        octokit: principal.github,
        fetch: fetcher,
        reader,
        maxBytes: MAX_SOURCE_BYTES,
        imagesOnly: true,
      });
      const rendered = await renderImage(loaded.body, args.format as PreviewFormat, Number(args.maxDimension));
      const metadata = {
        previewId,
        title: loaded.preview.title,
        description: loaded.preview.description ?? '',
        width: rendered.width,
        height: rendered.height,
        originalBytes: loaded.body.byteLength,
        bytes: rendered.body.byteLength,
        mimeType: rendered.mimeType,
      };
      return {
        status: 200,
        data: metadata,
        content: [
          { type: 'image' as const, data: rendered.body.toString('base64'), mimeType: rendered.mimeType },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ],
      };
    }),
  });
}
