import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { McpError } from './config.js';
import { digest } from './store.js';
import type { McpPrincipal } from './policy.js';

export interface OperationResult { status: number; data: unknown }
export interface Operation {
  id: string; owner_id: string; grant_id: string; idempotency_key: string; tool: string; repository: string | null;
  state: string; result: string | null; created_at: number; updated_at: number; payload_hash: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class McpOperations {
  constructor(readonly db: Knex) {}

  async replay(principal: McpPrincipal, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const previous = await this.db<Operation>('mcp_operations').where({ owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: String(args.idempotencyKey) }).first();
    if (!previous) return undefined;
    if (previous.payload_hash !== digest(canonical({ tool, args }))) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
    return this.project(previous);
  }

  async run(principal: McpPrincipal, { tool, args, repository }: { tool: string; args: Record<string, unknown>; repository?: string }, invoke: (operationId: string) => Promise<OperationResult>): Promise<Record<string, unknown>> {
    const key = String(args.idempotencyKey || '');
    if (!/^[\w.-]{8,128}$/.test(key)) throw new McpError('IDEMPOTENCY_KEY_REQUIRED', 'Provide a stable 8–128 character idempotencyKey for this action.');
    const identity = { owner_id: principal.user.id, grant_id: principal.grant.id, idempotency_key: key };
    const payloadHash = digest(canonical({ tool, args }));
    const id = randomUUID();
    const inserted = await this.db('mcp_operations').insert({ ...identity, id, tool, repository: repository || null,
      payload_hash: payloadHash, state: 'running', created_at: Date.now(), updated_at: Date.now() }).onConflict(['owner_id', 'grant_id', 'idempotency_key']).ignore().returning('id');
    if (!inserted.length) {
      const previous = await this.db<Operation>('mcp_operations').where(identity).first();
      if (!previous || previous.payload_hash !== payloadHash) throw new McpError('IDEMPOTENCY_CONFLICT', 'This key was already used with different arguments.', 409);
      return this.project(previous);
    }
    try {
      const result = await invoke(id);
      const reported = (result.data as { state?: string })?.state;
      const state = reported === 'browser_required' ? reported : result.status === 202 && ['posted', 'queued', 'unknown', 'failed'].includes(reported || '') ? reported! : result.status === 202 ? 'accepted' : 'completed';
      await this.db('mcp_operations').where({ id }).update({ state, result: JSON.stringify(result.data), updated_at: Date.now() });
    } catch (error) {
      // A transport failure can follow an external side effect. Never replay it
      // automatically or claim it was rolled back. The handle remains durable.
      const code = error instanceof McpError && error.status < 500 ? error.code : 'OUTCOME_UNKNOWN';
      await this.db('mcp_operations').where({ id }).update({ state: code === 'OUTCOME_UNKNOWN' ? 'unknown' : 'failed',
        result: JSON.stringify({ error: { code, message: error instanceof McpError ? error.message : 'Outcome uncertain. Inspect the target before issuing a new action.' } }), updated_at: Date.now() });
    }
    return this.project((await this.db<Operation>('mcp_operations').where({ id }).first())!);
  }

  async get(principal: McpPrincipal, id: string): Promise<Operation> {
    const row = await this.db<Operation>('mcp_operations').where({ id, owner_id: principal.user.id, grant_id: principal.grant.id }).first();
    if (!row) throw new McpError('NOT_FOUND', 'Operation not found.', 404);
    return row;
  }

  project(row: Operation): Record<string, unknown> {
    const stale = row.state === 'running' && Date.now() - Number(row.updated_at) > 120_000;
    const state = stale ? 'unknown' : row.state;
    return { operationId: row.id, tool: row.tool, state, result: row.result ? JSON.parse(row.result) : null,
      ...(['accepted', 'posted', 'queued', 'running'].includes(state) ? { retryAfterSeconds: 3 } : {}),
      ...(stale ? { message: 'Execution may have been interrupted. Inspect the target; this action will not be replayed automatically.' } : {}) };
  }
}
