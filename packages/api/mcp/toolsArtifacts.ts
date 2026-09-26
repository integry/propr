import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { createPlannerRoutes } from '../routes/plannerRoutes.js';
import type { createGoalRoutes } from '../routes/goalRoutes.js';
import { McpError } from './config.js';
import { callWorkflow } from './adapter.js';
import { type McpTool, type ToolDeps, mutationShape, repositorySchema, ok } from './tools.js';

export interface Artifact { id: string; ownerId: string; repository: string; parentId: string; parentKind: string; filename: string; mimeType: string; data: string; size: number }
const MIME_EXTENSIONS: Record<string, string[]> = { 'text/plain': ['.txt'], 'text/markdown': ['.md'], 'text/csv': ['.csv'], 'application/json': ['.json'], 'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'] };

export function addArtifactTools(tools: McpTool[], deps: ToolDeps, planner: ReturnType<typeof createPlannerRoutes>, goals: ReturnType<typeof createGoalRoutes>): void {
  tools.push({ name: 'upload_attachment', description: 'Upload at most 192 KiB of base64 data to your plan or send it with input to your goal. Never fetches remote URLs. Goal attachments require execute scope.', scope: 'plan',
    schema: z.object({ ...mutationShape, repository: repositorySchema, parentKind: z.enum(['plan', 'goal']), parentId: z.uuid(), filename: z.string().min(1).max(128).regex(/^[A-Za-z0-9_. -]+$/), mimeType: z.enum(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/pdf', 'image/png', 'image/jpeg', 'image/webp']), data: z.string().max(262144), message: z.string().min(1).max(4096).optional() }).strict(), run: async ({ principal, args }) => {
      const isGoal = args.parentKind === 'goal';
      if (isGoal) deps.policy.requireScope(principal, 'execute');
      const parent = await deps.db(isGoal ? 'goals' : 'task_drafts').where({ [isGoal ? 'goal_id' : 'draft_id']: args.parentId, [isGoal ? 'owner_id' : 'user_id']: principal.user.id, repository: args.repository }).first();
      if (!parent) throw new McpError('NOT_FOUND', 'Attachment parent not found.', 404);
      if (args.filename.includes('..') || !MIME_EXTENSIONS[args.mimeType].includes(path.extname(args.filename).toLowerCase())) throw new McpError('INVALID_ATTACHMENT', 'Filename extension must match the allowed media type.');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw new McpError('INVALID_ATTACHMENT', 'Expected canonical base64 data.');
      const bytes = Buffer.from(args.data, 'base64');
      if (!bytes.length || bytes.length > 192 * 1024) throw new McpError('INVALID_ATTACHMENT', 'Attachment must contain 1–196608 bytes.');
      const id = randomUUID();
      const root = path.join(process.cwd(), 'temp_uploads');
      await mkdir(root, { recursive: true });
      const filename = path.join(root, id);
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      const file = { fieldname: 'file', originalname: args.filename, encoding: '7bit', mimetype: args.mimeType, destination: root, filename: id, path: filename, size: bytes.length } as Express.Multer.File;
      let response;
      try {
        response = isGoal
          ? await callWorkflow(goals.input, principal, { params: { goalId: args.parentId }, body: { message: args.message || `Attachment: ${args.filename}` }, files: [file], idempotencyKey: args.idempotencyKey })
          : await callWorkflow(planner.uploadAttachment, principal, { params: { id: args.parentId }, file });
      } finally { await rm(filename, { force: true }); }
      const artifact: Artifact = { id, ownerId: principal.user.id, repository: args.repository, parentId: args.parentId, parentKind: args.parentKind, filename: args.filename, mimeType: args.mimeType, data: args.data, size: bytes.length };
      await deps.policy.oauth.store.put('artifact', id, artifact);
      return { status: response.status, data: { artifactId: id, parentId: args.parentId, size: bytes.length, resource: `propr://instances/${deps.policy.config.instanceId}/artifacts/${id}`, browserUrl: `${deps.policy.config.origin}/mcp/artifacts/${id}`, attachment: response.data } };
    } });
  tools.push({ name: 'get_artifact', description: 'Read an owned uploaded artifact in bounded base64 chunks. Resource links never grant access.', scope: 'read', readOnly: true,
    schema: z.object({ artifactId: z.uuid(), offset: z.number().int().min(0).max(192 * 1024).default(0), length: z.number().int().min(1).max(48 * 1024).default(48 * 1024) }).strict(), run: async ({ principal, args }) => {
      const artifact = await deps.policy.oauth.store.get<Artifact>('artifact', args.artifactId);
      if (!artifact || artifact.ownerId !== principal.user.id) throw new McpError('NOT_FOUND', 'Artifact not found.', 404);
      await deps.policy.repository(principal, artifact.repository);
      const goal = artifact.parentKind === 'goal';
      const parent = await deps.db(goal ? 'goals' : 'task_drafts').where({ [goal ? 'goal_id' : 'draft_id']: artifact.parentId, [goal ? 'owner_id' : 'user_id']: principal.user.id }).first();
      if (!parent) throw new McpError('NOT_FOUND', 'Artifact parent no longer exists.', 404);
      const bytes = Buffer.from(artifact.data, 'base64');
      return ok({ artifactId: artifact.id, filename: artifact.filename, mimeType: artifact.mimeType, size: bytes.length, data: bytes.subarray(args.offset, args.offset + args.length).toString('base64'), nextOffset: args.offset + args.length < bytes.length ? args.offset + args.length : null });
    } });
  tools.push({ name: 'get_attachment', description: 'Read a bounded chunk of an existing plan/goal attachment, including files uploaded from the browser.', scope: 'read', readOnly: true,
    schema: z.object({ repository: repositorySchema, parentKind: z.enum(['plan', 'goal']), parentId: z.uuid(), attachmentId: z.uuid(), offset: z.number().int().min(0).max(10 * 1024 * 1024).default(0), length: z.number().int().min(1).max(48 * 1024).default(48 * 1024) }).strict(), run: async ({ principal, args }) => {
      const goal = args.parentKind === 'goal';
      const row = await deps.db(goal ? 'goals' : 'task_drafts').where({ [goal ? 'goal_id' : 'draft_id']: args.parentId, [goal ? 'owner_id' : 'user_id']: principal.user.id, repository: args.repository }).first('attachments');
      if (!row) throw new McpError('NOT_FOUND', 'Attachment parent not found.', 404);
      const attachments = typeof row.attachments === 'string' ? JSON.parse(row.attachments) : row.attachments;
      const attachment = Array.isArray(attachments) ? attachments.find(item => item.id === args.attachmentId) : undefined;
      if (!attachment || typeof attachment.storedPath !== 'string') throw new McpError('NOT_FOUND', 'Attachment not found.', 404);
      const root = path.resolve(goal ? '/tmp/git-processor/goal-attachments' : path.join(process.cwd(), 'storage', 'drafts'), args.parentId);
      const filePath = await realpath(path.resolve(process.cwd(), attachment.storedPath));
      if (!filePath.startsWith(`${root}${path.sep}`)) throw new McpError('INVALID_ATTACHMENT', 'Attachment storage path is outside its parent directory.', 403);
      const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new McpError('INVALID_ATTACHMENT', 'Attachment is not a supported bounded file.');
        const buffer = Buffer.alloc(args.length);
        const { bytesRead } = await file.read(buffer, 0, args.length, args.offset);
        return ok({ attachmentId: args.attachmentId, filename: attachment.originalName, mimeType: attachment.mimeType, size: stat.size, data: buffer.subarray(0, bytesRead).toString('base64'), nextOffset: args.offset + bytesRead < stat.size ? args.offset + bytesRead : null });
      } finally { await file.close(); }
    } });
}
