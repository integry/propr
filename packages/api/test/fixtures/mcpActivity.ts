import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import { McpError } from '../../mcp/config.js';
import type { McpPolicy, McpPrincipal } from '../../mcp/policy.js';
import type { ToolDeps } from '../../mcp/tools.js';

/**
 * Fixtures for the MCP operator activity digest. Only the repository
 * configuration and GitHub authorization boundaries are simulated; the schema,
 * catalog, aggregation and persistence under test are the real code.
 */

export interface ConfiguredRepository { id: string; name: string; enabled: boolean; baseBranch: string }

export const owner = '123';

export const mcpConfig = {
  origin: 'https://instance.example', resource: 'https://instance.example/api/mcp',
  instanceId: 'activity-instance', encryptionKey: randomBytes(32),
};

/** Mutable stand-in for the instance's configured repositories. */
export const configuredRepositories: { current: ConfiguredRepository[] } = { current: [] };

export function repositories(...names: Array<string | [string, boolean]>): void {
  configuredRepositories.current = names.map((entry, index) => {
    const [name, enabled] = Array.isArray(entry) ? entry : [entry, true];
    return { id: String(index + 1), name, enabled, baseBranch: 'main' };
  });
}

export function at(millisecondsAgo: number): string {
  return new Date(Date.now() - millisecondsAgo).toISOString();
}

export async function createActivityDatabase(): Promise<Knex> {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../../core/src/db/migrations/', import.meta.url)) });
  return db;
}

export function buildDeps(db: Knex, options: { forbidden?: string[] } = {}): ToolDeps {
  const forbidden = new Set(options.forbidden ?? []);
  const policy = {
    config: mcpConfig,
    repository: async (_principal: McpPrincipal, repository: string) => {
      if (forbidden.has(repository)) throw new McpError('REPOSITORY_FORBIDDEN', 'Denied', 403);
    },
    requireScope: () => {},
    requirePermission: () => {},
  } as unknown as McpPolicy;
  return {
    db, policy, taskQueue: {} as never, runtimeBuildQueue: {} as never,
    redisClient: { get: async () => null } as never,
  };
}

export function buildPrincipal(granted: string[]): McpPrincipal {
  return {
    user: { id: owner, login: 'tester', username: 'tester', displayName: 'Test', email: null, avatarUrl: null, accessToken: 'fixture' },
    authorization: { role: 'member', permissions: [], source: 'local' },
    scopes: ['read'],
    grant: {
      id: 'grant-1', ownerId: owner, clientId: 'client-1', clientName: 'Test', instanceId: mcpConfig.instanceId,
      resource: mcpConfig.resource, scopes: ['read'], repositories: granted, createdAt: Date.now(),
      expiresAt: Date.now() + 60_000, revoked: false, membershipSource: 'local',
    },
    github: {} as never,
  } as McpPrincipal;
}

export async function insertTask(db: Knex, row: {
  taskId: string; repository: string; createdAt: string; taskType?: string;
  issueNumber?: number; prNumber?: number; job?: Record<string, unknown>;
}): Promise<void> {
  await db('tasks').insert({
    task_id: row.taskId, repository: row.repository, task_type: row.taskType ?? 'issue',
    issue_number: row.issueNumber ?? null, pr_number: row.prNumber ?? null,
    initial_job_data: JSON.stringify(row.job ?? {}), created_at: row.createdAt,
  });
}

export async function insertHistory(db: Knex, row: {
  taskId: string; state: string; timestamp: string; reason?: string; metadata?: Record<string, unknown>;
}): Promise<void> {
  await db('task_history').insert({
    task_id: row.taskId, state: row.state, timestamp: row.timestamp,
    reason: row.reason ?? null, metadata: row.metadata ? JSON.stringify(row.metadata) : null,
  });
}

export async function insertGoal(db: Knex, row: Record<string, unknown>): Promise<void> {
  await db('goals').insert({
    owner_id: owner, owner_login: 'tester', objective: 'Fixture objective', launch_strategy: 'direct',
    initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
    requested_model: 'gpt-5.6', desired_state: 'running', ...row,
  });
}

export async function insertNotification(db: Knex, row: {
  id: string; kind: string; severity: string; target: Record<string, unknown>;
  title: string; body: string; occurredAt: string; metadata?: Record<string, unknown>;
}): Promise<void> {
  await db('notification_events').insert({
    event_id: row.id, deduplication_key: `dedupe:${row.id}`, kind: row.kind, severity: row.severity,
    target_json: JSON.stringify(row.target), title: row.title, body: row.body,
    metadata_json: row.metadata ? JSON.stringify(row.metadata) : null,
    occurred_at: row.occurredAt, created_at: row.occurredAt,
  });
  await db('notification_user_states').insert({
    event_id: row.id, user_id: owner, inbox_enabled: true, push_enabled: false, created_at: row.occurredAt,
  });
}

/** Identifiers carried by a digest section or timeline, in returned order. */
export function ids<T>(items: unknown[], select: (item: any) => T): T[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  return items.map(item => select(item));
}

export function assertSectionsConsistent(sections: Record<string, { count: number; items: unknown[]; truncated: boolean }>): void {
  for (const [name, section] of Object.entries(sections)) {
    assert.equal(section.count, section.items.length, `${name} count matches its page`);
  }
}
