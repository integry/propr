import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import knex from 'knex';
import { z } from 'zod';
import { closeConnection, createAgentDefinition, transitionAgentRun, triggerAgentRun, updateAgentDefinition, type AgentRunGate, type StoredAgentRun } from '@propr/core';
import { AGENT_DEFINITION_CONTRACT } from '@propr/shared';
import { createToolCatalog, executeTool, type ToolDeps } from '../mcp/tools.js';
import { McpPolicy, type McpPrincipal } from '../mcp/policy.js';
import { McpError } from '../mcp/config.js';
import { McpStore } from '../mcp/store.js';
import { McpOAuthProvider } from '../mcp/oauth.js';
import { AGENT_RUN_MCP_CLIENT_ID } from '../mcp/agentRunGrants.js';
import { AGENT_RUN_REPORT_MCP_MAX_BYTES } from '../mcp/toolsAgentRuns.js';

after(closeConnection);

const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const AGENT_TOOLS = ['list_agent_definitions', 'get_agent_definition', 'get_agent_definition_contract', 'list_agent_runs',
  'get_agent_run', 'trigger_agent_run', 'approve_agent_run', 'reject_agent_run'];

interface Receipt {
  operationId: string;
  state: string;
  result: { runId: string; state: string; created: boolean; continuation: { agentRunId: string }; error?: { code: string } };
  targetState?: { agentRunId: string; state: string; reportedAt: number | null; finishedAt: number | null };
  retryAfterSeconds?: number;
  lifecycle: { state: string; startedAt: string | null; finishedAt: string | null; failure: { code: string } | null };
}

async function fixture() {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: migrations });
  const config = { origin: 'https://instance.example', resource: 'https://instance.example/api/mcp', instanceId: 'test', encryptionKey: randomBytes(32) };
  const policy = new McpPolicy(new McpOAuthProvider(new McpStore(db, config.encryptionKey), config), config);
  const authorized: Array<{ repository: string; write: boolean }> = [];
  policy.repository = async (principal, repository, write = false) => {
    authorized.push({ repository, write });
    if (!principal.grant.repositories.includes(repository)) throw new McpError('REPOSITORY_FORBIDDEN', 'No repository access', 403);
  };
  const principal = { user: { id: 'alice', username: 'alice' }, authorization: { permissions: [] },
    grant: { id: 'grant-1', clientId: 'chat-client', repositories: ['acme/app', 'acme/lib'] }, scopes: ['read', 'execute'] } as unknown as McpPrincipal;
  const enqueued: string[] = [];
  const acting: Array<{ runId: string; note: string | null }> = [];
  const controls: { gate: AgentRunGate } = { gate: () => null };
  const deps: ToolDeps = { db, policy, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never,
    agentRuns: {
      gate: context => controls.gate(context),
      trigger: input => triggerAgentRun(input, {
        database: db,
        enqueue: async (_name, data) => { enqueued.push(data.runId); },
        loadRepos: async () => ['acme/app', 'acme/lib', 'acme/secret'].map(name => ({ id: name, name, enabled: true }) as never),
        loadAgents: async () => [], loadSyntheticAgents: async () => [], loadDefaultAgentAlias: async () => null,
      }),
      startActing: async (run: StoredAgentRun, note: string | null) => { acting.push({ runId: run.id, note }); return run; },
    },
  };
  const catalog = createToolCatalog(deps);
  const call = (name: string, args: Record<string, unknown>, user = principal) =>
    executeTool(catalog.find(tool => tool.name === name)!, args, user, deps);
  const define = (repositories: string[], extra: Partial<Parameters<typeof createAgentDefinition>[0]> = {}) =>
    createAgentDefinition({ ownerId: 'alice', name: 'Competitor scan', prompt: 'Scan competitors.', repositories, ...extra }, { database: db });
  return { db, principal, deps, catalog, call, define, enqueued, acting, controls, authorized };
}

test('agent tools are listed with valid schemas and only for the scopes they need', async () => {
  const f = await fixture();
  try {
    for (const name of AGENT_TOOLS) assert.ok(z.toJSONSchema(f.catalog.find(tool => tool.name === name)!.schema), name);
    const visible = (scopes: string[]) => f.catalog.filter(tool => scopes.includes(tool.scope)).map(tool => tool.name)
      .filter(name => AGENT_TOOLS.includes(name)).sort();
    assert.deepEqual(visible(['read']), ['get_agent_definition', 'get_agent_definition_contract', 'get_agent_run', 'list_agent_definitions', 'list_agent_runs']);
    assert.deepEqual(visible(['read', 'execute']), [...AGENT_TOOLS].sort());
    const trigger = f.catalog.find(tool => tool.name === 'trigger_agent_run')!;
    assert.match(trigger.description, /free-form report/);
    assert.match(trigger.description, /cost-gated/);
    assert.match(trigger.description, /deferred/);
    assert.match(trigger.description, /skipped/);
    assert.match(trigger.description, /autonomy/);
    for (const name of AGENT_TOOLS.filter(name => name.startsWith('get_') || name.startsWith('list_'))) {
      assert.equal(f.catalog.find(tool => tool.name === name)!.readOnly, true, name);
    }
    const readOnly = { ...f.principal, scopes: ['read'] } as McpPrincipal;
    const definition = await f.define(['acme/app']);
    await assert.rejects(f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'scope-check-1' }, readOnly), /requires execute/);
  } finally { await f.db.destroy(); }
});

test('trigger_agent_run creates one run per idempotency key and get_operation completes with the run', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app', 'acme/lib']);
    const args = { definitionId: definition.id, idempotencyKey: 'run-competitor-scan', source: 'chat' };
    const first = (await f.call('trigger_agent_run', args)).data as Receipt;
    assert.equal(first.state, 'queued');
    assert.equal(first.result.state, 'queued');
    assert.equal(first.result.created, true);
    assert.deepEqual(first.result.continuation, { agentRunId: first.result.runId });
    assert.deepEqual((await f.call('trigger_agent_run', args)).data, first);
    assert.deepEqual(f.enqueued, [first.result.runId]);
    const rows = await f.db('agent_runs');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'mcp');
    assert.equal(rows[0].trigger_source, 'chat');
    assert.equal(rows[0].idempotency_key, 'mcp:run-competitor-scan');
    assert.ok(f.authorized.some(entry => entry.repository === 'acme/lib' && entry.write));

    const poll = async () => (await f.call('get_operation', { operationId: first.operationId })).data as Receipt;
    let receipt = await poll();
    assert.equal(receipt.targetState?.state, 'queued');
    assert.equal(receipt.lifecycle.state, 'accepted');
    await transitionAgentRun(first.result.runId, ['queued'], 'running', {}, { database: f.db });
    receipt = await poll();
    assert.equal(receipt.state, 'running');
    assert.equal(receipt.lifecycle.state, 'running');
    assert.ok(receipt.lifecycle.startedAt);
    await transitionAgentRun(first.result.runId, ['running'], 'report_ready', { report: 'Nothing new.' }, { database: f.db });
    await transitionAgentRun(first.result.runId, ['report_ready'], 'completed', {}, { database: f.db });
    receipt = await poll();
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.lifecycle.state, 'completed');
    assert.ok(receipt.lifecycle.finishedAt);
    assert.ok(receipt.targetState?.reportedAt);
    assert.ok(receipt.targetState?.finishedAt);
    assert.equal(receipt.retryAfterSeconds, undefined);
  } finally { await f.db.destroy(); }
});

test('a failed run fails its trigger receipt and a held run is reported as deferred or skipped', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app']);
    const failed = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'failing-run-1' })).data as Receipt;
    await transitionAgentRun(failed.result.runId, ['queued'], 'failed', { failureReason: 'Container crashed' }, { database: f.db });
    const receipt = (await f.call('get_operation', { operationId: failed.operationId })).data as Receipt;
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.lifecycle.state, 'failed');
    assert.equal(receipt.lifecycle.failure?.code, 'AGENT_RUN_FAILED');

    f.controls.gate = () => ({ action: 'skip', reason: 'Weekly usage at 95%' });
    const skipped = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'skipped-run-1' })).data as Receipt;
    assert.equal(skipped.result.state, 'skipped');
    assert.equal((await f.call('get_operation', { operationId: skipped.operationId })).data.lifecycle.state, 'completed');
    f.controls.gate = () => ({ action: 'defer', until: Date.now() + 60_000, reason: 'Session usage at 95%' });
    const deferred = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'deferred-run-1' })).data as Receipt;
    assert.equal(deferred.result.state, 'deferred');
    assert.equal((await f.call('get_operation', { operationId: deferred.operationId })).data.lifecycle.state, 'accepted');
    assert.equal(f.enqueued.length, 1);
  } finally { await f.db.destroy(); }
});

test('a grant without one of the definition repositories can neither read nor trigger it', async () => {
  const f = await fixture();
  try {
    const visible = await f.define(['acme/app']);
    const hidden = await f.define(['acme/app', 'acme/secret'], { name: 'Secret scan' });
    const listed = (await f.call('list_agent_definitions', {})).data as { definitions: Array<{ id: string; prompt?: string }> };
    assert.deepEqual(listed.definitions.map(definition => definition.id), [visible.id]);
    assert.equal(listed.definitions[0].prompt, undefined);
    await assert.rejects(f.call('get_agent_definition', { definitionId: hidden.id }), (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    await assert.rejects(f.call('list_agent_runs', { definitionId: hidden.id }), (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    await assert.rejects(f.call('trigger_agent_run', { definitionId: hidden.id, idempotencyKey: 'hidden-run-1' }), (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    assert.equal((await f.db('agent_runs')).length, 0);
    assert.equal((await f.db('mcp_operations')).length, 0);

    const run = await triggerAgentRun({ definition: hidden, trigger: 'manual', gate: () => null },
      { database: f.db, enqueue: async () => undefined, loadRepos: async () => ['acme/app', 'acme/secret'].map(name => ({ name, enabled: true }) as never) });
    await assert.rejects(f.call('get_agent_run', { runId: run.run.id }), (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');

    const other = await createAgentDefinition({ ownerId: 'bob', name: 'Bob', prompt: 'p', repositories: ['acme/app'] }, { database: f.db });
    await assert.rejects(f.call('get_agent_definition', { definitionId: other.id }), (error: McpError) => error.code === 'NOT_FOUND');
    await assert.rejects(f.call('trigger_agent_run', { definitionId: other.id, idempotencyKey: 'other-run-1' }), (error: McpError) => error.code === 'NOT_FOUND');

    const filtered = (await f.call('list_agent_definitions', { repository: 'acme/lib' })).data as { definitions: unknown[] };
    assert.deepEqual(filtered.definitions, []);
    const detail = (await f.call('get_agent_definition', { definitionId: visible.id })).data as { definition: { prompt: string; repositories: string[] } };
    assert.equal(detail.definition.prompt, 'Scan competitors.');
    assert.deepEqual((await f.call('get_agent_definition_contract', {})).data, JSON.parse(JSON.stringify(AGENT_DEFINITION_CONTRACT)));
  } finally { await f.db.destroy(); }
});

test('runs that captured a repository the grant lacks stay hidden after the definition drops it', async () => {
  const f = await fixture();
  try {
    const grant = (id: string, repositories: string[]) => ({ ...f.principal, grant: { ...f.principal.grant, id, repositories } }) as McpPrincipal;
    const wide = grant('grant-wide', ['acme/app', 'acme/secret']);
    const narrow = grant('grant-narrow', ['acme/app']);
    const definition = await f.define(['acme/app', 'acme/secret']);
    const historic = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'historic-run-1' }, wide)).data as Receipt;
    await transitionAgentRun(historic.result.runId, ['queued'], 'failed', { failureReason: 'Leaked acme/secret detail' }, { database: f.db });
    await updateAgentDefinition(definition.id, 'alice', { repositories: ['acme/app'] }, { database: f.db });
    const current = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'current-run-1' }, narrow)).data as Receipt;

    const listed = (await f.call('list_agent_runs', { definitionId: definition.id }, narrow)).data as { runs: Array<{ id: string }>; total: number; nextOffset: number | null };
    assert.deepEqual(listed.runs.map(run => run.id), [current.result.runId]);
    assert.equal(listed.total, 1);
    assert.equal(listed.nextOffset, null);
    const paged = (await f.call('list_agent_runs', { definitionId: definition.id, offset: 1 }, narrow)).data as { runs: unknown[]; total: number };
    assert.deepEqual(paged.runs, []);
    assert.equal(paged.total, 1);
    assert.equal(((await f.call('list_agent_runs', { definitionId: definition.id }, wide)).data as { total: number }).total, 2);

    // Another grant replaying the key reaches the trigger's own idempotency lookup.
    await assert.rejects(f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'historic-run-1' }, narrow),
      (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    // The original grant, after losing the repository, replays its stored MCP receipt.
    await assert.rejects(f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'historic-run-1' }, grant('grant-wide', ['acme/app'])),
      (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    await assert.rejects(f.call('get_agent_run', { runId: historic.result.runId }, narrow), (error: McpError) => error.code === 'REPOSITORY_FORBIDDEN');
    assert.equal((await f.db('agent_runs')).length, 2);
  } finally { await f.db.destroy(); }
});

test('trigger_agent_run authorizes the definition it triggers, not the one the early check read', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app']);
    const authorize = f.deps.policy.repository.bind(f.deps.policy);
    // Runs once, after the given number of authorizations: the hook authorizes
    // acme/app first and the mutation callback authorizes it again.
    let interleave: { after: number; step: () => Promise<void> } | null = null;
    let calls = 0;
    f.deps.policy.repository = async (principal, repository, write = false) => {
      await authorize(principal, repository, write);
      if (interleave && ++calls === interleave.after) {
        const { step } = interleave;
        interleave = null;
        await step();
      }
    };

    interleave = { after: 1, step: async () => { await updateAgentDefinition(definition.id, 'alice', { repositories: ['acme/app', 'acme/secret'] }, { database: f.db }); } };
    const widened = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'race-widened-1' })).data as Receipt;
    assert.equal(widened.state, 'failed');
    assert.equal(widened.result.error?.code, 'REPOSITORY_FORBIDDEN');
    assert.equal((await f.db('agent_runs')).length, 0);
    assert.deepEqual(f.enqueued, []);

    // A run with a wider snapshot created under the same key in that window is not replayed either.
    await updateAgentDefinition(definition.id, 'alice', { repositories: ['acme/app'] }, { database: f.db });
    calls = 0;
    interleave = { after: 2, step: async () => {
      const wider = await updateAgentDefinition(definition.id, 'alice', { repositories: ['acme/app', 'acme/secret'] }, { database: f.db });
      await triggerAgentRun({ definition: wider!, trigger: 'mcp', idempotencyKey: 'mcp:race-replayed-1', gate: () => null },
        { database: f.db, enqueue: async () => undefined, loadRepos: async () => ['acme/app', 'acme/secret'].map(name => ({ name, enabled: true }) as never) });
      await updateAgentDefinition(definition.id, 'alice', { repositories: ['acme/app'] }, { database: f.db });
    } };
    const replayed = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'race-replayed-1' })).data as Receipt;
    assert.equal(replayed.state, 'failed');
    assert.equal(replayed.result.error?.code, 'REPOSITORY_FORBIDDEN');
    assert.equal(replayed.result.runId, undefined);
  } finally { await f.db.destroy(); }
});

test('an agent-run grant cannot trigger, approve or reject agent runs', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app'], { autonomyMode: 'preview' });
    const agent = { ...f.principal, grant: { ...f.principal.grant, clientId: AGENT_RUN_MCP_CLIENT_ID } } as McpPrincipal;
    await assert.rejects(f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'recursive-1' }, agent),
      (error: McpError) => error.code === 'AGENT_RECURSION_FORBIDDEN');
    const triggered = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'owner-run-1' })).data as Receipt;
    for (const name of ['approve_agent_run', 'reject_agent_run']) {
      await assert.rejects(f.call(name, { runId: triggered.result.runId, idempotencyKey: `recursive-${name}` }, agent),
        (error: McpError) => error.code === 'AGENT_RECURSION_FORBIDDEN');
    }
    // Reading stays available to the acting agent.
    assert.ok((await f.call('get_agent_run', { runId: triggered.result.runId }, agent)).data);
    assert.equal((await f.db('agent_runs')).length, 1);
  } finally { await f.db.destroy(); }
});

test('approve and reject decide preview runs once and approval receipts follow the acting step', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app'], { autonomyMode: 'preview' });
    const ready = async (key: string) => {
      const receipt = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: key })).data as Receipt;
      const id = receipt.result.runId;
      await transitionAgentRun(id, ['queued'], 'running', {}, { database: f.db });
      await transitionAgentRun(id, ['running'], 'report_ready', { report: 'Open two issues.' }, { database: f.db });
      await transitionAgentRun(id, ['report_ready'], 'awaiting_approval', {}, { database: f.db });
      return id;
    };
    const approvedId = await ready('preview-run-1');
    const approval = (await f.call('approve_agent_run', { runId: approvedId, note: 'Only the first issue.', idempotencyKey: 'approve-run-1' })).data as Receipt;
    assert.equal(approval.result.state, 'acting');
    assert.deepEqual(f.acting, [{ runId: approvedId, note: 'Only the first issue.' }]);
    assert.deepEqual((await f.call('approve_agent_run', { runId: approvedId, note: 'Only the first issue.', idempotencyKey: 'approve-run-1' })).data, approval);
    assert.equal(f.acting.length, 1);
    await transitionAgentRun(approvedId, ['acting'], 'completed', { actionSummary: 'Opened one issue.' }, { database: f.db });
    const settled = (await f.call('get_operation', { operationId: approval.operationId })).data as Receipt;
    assert.equal(settled.state, 'completed');
    assert.equal(settled.lifecycle.state, 'completed');

    const rejectedId = await ready('preview-run-2');
    const rejection = (await f.call('reject_agent_run', { runId: rejectedId, idempotencyKey: 'reject-run-2' })).data as Receipt;
    assert.equal(rejection.state, 'completed');
    assert.equal(rejection.result.state, 'rejected');
    const again = (await f.call('reject_agent_run', { runId: rejectedId, idempotencyKey: 'reject-run-2b' })).data as Receipt;
    assert.equal(again.state, 'failed');
    assert.equal(again.result.error?.code, 'AGENT_RUN_NOT_AWAITING_APPROVAL');

    const dryRun = await f.define(['acme/app']);
    const dry = (await f.call('trigger_agent_run', { definitionId: dryRun.id, idempotencyKey: 'dry-run-1' })).data as Receipt;
    await assert.rejects(f.call('approve_agent_run', { runId: dry.result.runId, idempotencyKey: 'approve-dry-1' }),
      (error: McpError) => error.code === 'AGENT_RUN_NOT_PREVIEW');
  } finally { await f.db.destroy(); }
});

test('runs are listed without reports and a large report is truncated under the MCP result bound', async () => {
  const f = await fixture();
  try {
    const definition = await f.define(['acme/app']);
    const triggered = (await f.call('trigger_agent_run', { definitionId: definition.id, idempotencyKey: 'large-report-1' })).data as Receipt;
    const id = triggered.result.runId;
    await transitionAgentRun(id, ['queued'], 'running', {}, { database: f.db });
    await transitionAgentRun(id, ['running'], 'report_ready', { report: 'short' }, { database: f.db });
    // Control characters triple in size when JSON-encoded.
    await f.db('agent_runs').where({ id }).update({ report: '\u0001'.repeat(100_000) });
    const listed = (await f.call('list_agent_runs', { definitionId: definition.id })).data as { runs: Array<Record<string, unknown>>; nextOffset: number | null };
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].report, undefined);
    assert.equal(listed.nextOffset, null);
    const detail = (await f.call('get_agent_run', { runId: id })).data as { run: { report: string; reportTruncated: boolean; url: string } };
    assert.equal(detail.run.reportTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(detail.run.report)) <= AGENT_RUN_REPORT_MCP_MAX_BYTES);
    assert.equal(detail.run.url, `https://instance.example/agents/${definition.id}/runs/${id}`);
  } finally { await f.db.destroy(); }
});
