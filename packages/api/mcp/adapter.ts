import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { McpPrincipal } from './policy.js';
import { McpError } from './config.js';
import type { OperationResult } from './operations.js';

export type WorkflowHandler = (req: Request<never>, res: Response) => unknown;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[depth limit]';
  if (typeof value === 'string' && (value.trim().startsWith('[') || value.trim().startsWith('{'))) {
    try { return JSON.stringify(redact(JSON.parse(value), depth + 1)); } catch { /* ordinary text */ }
  }
  if (typeof value === 'string') return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|propr_mcp_[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]');
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key === 'pr_review_max_context_tokens' || !/(?:token|secret|password|credential|private.?key|api.?key|access.?key|cookie|authorization|worktree.?path|stored.?path|job_data|container_env)/i.test(key))
    .map(([key, item]) => [key, redact(item, depth + 1)]));
  return value;
}

/** Calls a fixed existing workflow handler with a verified GitHub principal.
 * No URL dispatch, HTTP loopback, synthetic session, or client-controlled headers.
 */
export async function callWorkflow(handler: WorkflowHandler, principal: McpPrincipal, input: {
  body?: Record<string, unknown>; params?: Record<string, unknown>; query?: Record<string, unknown>; idempotencyKey?: string;
  file?: Express.Multer.File; files?: Express.Multer.File[];
  projectResult?: (data: unknown) => unknown;
}): Promise<OperationResult> {
  let status = 200;
  let data: unknown;
  const headers = new Map<string, string>();
  const req = {
    user: principal.user, authorization: principal.authorization,
    params: input.params || {}, query: input.query || {}, body: input.body || {}, file: input.file, files: input.files,
    get: (name: string) => name.toLowerCase() === 'idempotency-key' ? input.idempotencyKey : undefined,
  } as unknown as Request<never>;
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    status(code: number) { status = code; return res; },
    json(body: unknown) { data = body; res.headersSent = true; return res; },
    send(body: unknown) { data = body; res.headersSent = true; return res; },
    end() { res.headersSent = true; return res; },
    set(name: string, value: string) { headers.set(name, value); return res; },
    setHeader(name: string, value: string) { headers.set(name, value); return res; },
    type(value: string) { headers.set('Content-Type', value); return res; },
  });
  await handler(req, res as unknown as Response);
  if (status >= 400) {
    const message = typeof data === 'object' && data !== null && 'error' in data ? String(data.error) : 'Workflow rejected the request.';
    throw new McpError(status === 409 ? 'PRECONDITION_FAILED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'WORKFLOW_REJECTED', status >= 500 ? 'Workflow failed; inspect the operation and target before retrying.' : String(redact(message)), status);
  }
  const safe = redact(input.projectResult ? input.projectResult(data ?? {}) : data ?? {});
  if (Buffer.byteLength(JSON.stringify(safe)) > 256 * 1024) throw new McpError('RESULT_TOO_LARGE', 'Result exceeds 256 KiB. Request a smaller page or a specific artifact.');
  return { status, data: safe };
}
