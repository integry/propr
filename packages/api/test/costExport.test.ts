import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import knex, { type Knex } from 'knex';
import { costExportCsv, createCostExportRoutes, loadCostExport, parseCostGroupBy, type CostExport } from '../routes/costExport.js';
import { addStatsTools } from '../mcp/toolsStats.js';
import type { McpPrincipal } from '../mcp/policy.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const daysAgo = (days: number, hour = 10): string =>
  new Date(Date.UTC(2026, 10, 12 - days, hour)).toISOString();

let db: Knex;

interface ExecutionSeed {
  task: string | null;
  at: string;
  model: string;
  success?: boolean;
  cost?: number | null;
  input?: number | null;
  output?: number | null;
  cacheWrite?: number | null;
  cacheRead?: number | null;
  effort?: string | null;
  session?: string | null;
  /** Defaults to `at`. */
  end?: string;
}

async function seedExecution(seed: ExecutionSeed): Promise<number> {
  const [row] = await db('llm_executions').insert({
    task_id: seed.task, session_id: seed.session ?? null, start_time: seed.at, end_time: seed.end ?? seed.at, duration_ms: 1000,
    model_name: seed.model, success: seed.success ?? true, num_turns: 1, cost_usd: seed.cost === undefined ? 1 : seed.cost,
    input_tokens: seed.input === undefined ? 100 : seed.input, output_tokens: seed.output === undefined ? 10 : seed.output,
    cache_creation_input_tokens: seed.cacheWrite ?? null, cache_read_input_tokens: seed.cacheRead ?? null,
    reasoning_level: seed.effort ?? null,
  }).returning('execution_id');
  return Number((row as { execution_id: number }).execution_id ?? row);
}

async function seedLog(log: {
  task?: string | null; session?: string | null; model: string; at: string; end?: string; type: string; agent: string | null;
}): Promise<void> {
  await db('llm_logs').insert({
    execution_type: log.type, model_name: log.model, start_time: log.at, end_time: log.end ?? null, success: true,
    session_id: log.session ?? null, task_id: log.task ?? null, agent_alias: log.agent,
  });
}

before(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  for (const [taskId, repository] of [['alpha-1', 'acme/alpha'], ['alpha-2', 'acme/alpha'], ['beta-1', 'acme/beta']]) {
    await db('tasks').insert({ task_id: taskId, repository, task_type: 'issue', created_at: daysAgo(5) });
  }
  // alpha-1: an implementation on Opus (high effort) and a failed review on GPT.
  await seedExecution({ task: 'alpha-1', at: daysAgo(2), model: 'opus', cost: 2.5, input: 1000, output: 200, cacheWrite: 300, cacheRead: 400, effort: 'high', session: 's-impl' });
  await seedExecution({ task: 'alpha-1', at: daysAgo(2, 11), model: 'gpt', success: false, cost: 0.5, input: 50, output: 5, effort: 'medium' });
  // alpha-2: Opus again, a day later; its token totals come only from step details.
  const detailed = await seedExecution({ task: 'alpha-2', at: daysAgo(1), model: 'opus', cost: 1.25, input: null, output: null });
  await db('llm_execution_details').insert([
    { execution_id: detailed, sequence_number: 0, event_timestamp: daysAgo(1), event_type: 'assistant', token_count_input: 70, token_count_output: 7 },
    { execution_id: detailed, sequence_number: 1, event_timestamp: daysAgo(1), event_type: 'assistant', token_count_input: 30, token_count_output: 3 },
  ]);
  // beta-1: no recorded cost.
  await seedExecution({ task: 'beta-1', at: daysAgo(1), model: 'opus', cost: null, input: 10, output: 1 });
  // A plan call with no task, attributed through its session, and an execution outside every short window.
  await seedExecution({ task: null, at: daysAgo(1), model: 'opus', cost: 0.75, session: 's-plan' });
  await seedExecution({ task: 'alpha-1', at: daysAgo(60), model: 'opus', cost: 9 });

  // The same task logged an analysis call on another model; the session-matched log wins.
  await seedLog({ task: 'alpha-1', session: 's-impl', model: 'opus', at: daysAgo(2), type: 'implementation', agent: 'claude' });
  await seedLog({ task: 'alpha-1', model: 'haiku', at: daysAgo(2), type: 'context-analysis', agent: 'claude' });
  await seedLog({ task: 'alpha-1', model: 'gpt', at: daysAgo(2, 11), type: 'review', agent: 'codex' });
  await seedLog({ session: 's-plan', model: 'opus', at: daysAgo(1), type: 'plan-generation', agent: 'claude' });
});

after(async () => {
  await db.destroy();
  // Importing the MCP catalog opens the core database connection.
  await (await import('@propr/core')).closeConnection();
});

const window30d = { timeframe: '30d' as const, from: new Date(NOW.getTime() - 30 * 86_400_000), to: NOW };

test('group_by parses lists and repeats into column order, and names an unknown key', () => {
  assert.deepEqual(parseCostGroupBy(undefined), { keys: ['day'] });
  assert.deepEqual(parseCostGroupBy('outcome, model,day'), { keys: ['day', 'model', 'outcome'] });
  assert.deepEqual(parseCostGroupBy(['model', 'repository,model']), { keys: ['repository', 'model'] });
  assert.deepEqual(parseCostGroupBy('model,cost'), { invalid: 'cost' });
});

test('groups by day with totals that reconcile, and leaves out executions outside the window', async () => {
  const result = await loadCostExport(db, window30d, ['day']);
  assert.deepEqual(result.group_by, ['day']);
  assert.deepEqual(result.rows.map(row => [row.day, row.executions, row.tasks, row.cost_usd]), [
    ['2026-11-10', 2, 1, 3],
    ['2026-11-11', 3, 2, 2],
  ]);
  assert.equal(result.totals.executions, 5);
  assert.equal(result.totals.tasks, 3);
  assert.equal(result.totals.cost_usd, 5);
  // Detail rows stand in for missing execution totals; cache counts are reported as recorded.
  assert.equal(result.totals.input_tokens, 1000 + 50 + 100 + 10 + 100);
  assert.equal(result.totals.output_tokens, 200 + 5 + 10 + 1 + 10);
  assert.equal(result.totals.cache_creation_input_tokens, 300);
  assert.equal(result.totals.cache_read_input_tokens, 400);

  const allTime = await loadCostExport(db, null, ['day']);
  assert.equal(allTime.totals.executions, 6);
  assert.equal(allTime.period, null);
});

test('groups by repository, model, effort and outcome; an uncosted group has null cost', async () => {
  const result = await loadCostExport(db, window30d, ['outcome', 'reasoning_level', 'model', 'repository']);
  assert.deepEqual(result.group_by, ['repository', 'model', 'reasoning_level', 'outcome']);
  assert.deepEqual(result.rows.map(row => [row.repository, row.model, row.reasoning_level, row.outcome, row.executions, row.cost_usd]), [
    ['acme/alpha', 'gpt', 'medium', 'failed', 1, 0.5],
    ['acme/alpha', 'opus', 'high', 'success', 1, 2.5],
    ['acme/alpha', 'opus', null, 'success', 1, 1.25],
    ['acme/beta', 'opus', null, 'success', 1, null],
    [null, 'opus', null, 'success', 1, 0.75],
  ]);
});

test('agent and execution type come from the matching LLM log call', async () => {
  const result = await loadCostExport(db, window30d, ['agent', 'execution_type']);
  assert.deepEqual(result.rows.map(row => [row.agent, row.execution_type, row.executions]), [
    ['claude', 'implementation', 1],
    ['claude', 'plan-generation', 1],
    ['codex', 'review', 1],
    [null, null, 2],
  ]);
});

test('agent and execution type come from one matching call; nothing is borrowed from other runs of the task', async () => {
  const scratch = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await scratch.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const previous = db;
  db = scratch;
  try {
    await db('tasks').insert({ task_id: 'gamma-1', repository: 'acme/gamma', task_type: 'issue', created_at: daysAgo(5) });
    // A: its matching call recorded the type but no agent; the task's review call recorded codex.
    await seedExecution({ task: 'gamma-1', at: daysAgo(2), model: 'opus', session: 's-a' });
    await seedLog({ task: 'gamma-1', session: 's-a', model: 'opus', at: daysAgo(2), type: 'implementation', agent: null });
    await seedLog({ task: 'gamma-1', session: 's-review', model: 'gpt', at: daysAgo(2), type: 'review', agent: 'codex' });
    // B: a session no call of the task recorded, on a model no session-less call used.
    await seedExecution({ task: 'gamma-1', at: daysAgo(1), model: 'sonnet', session: 's-b' });
    // C: no session; the session-less same-model call whose span covers the run matches, never another session's call.
    await seedExecution({ task: 'gamma-1', at: daysAgo(1, 12), model: 'haiku' });
    await seedLog({ task: 'gamma-1', model: 'haiku', at: daysAgo(3), type: 'summarization', agent: 'claude' });
    await seedLog({ task: 'gamma-1', model: 'haiku', at: daysAgo(1, 11), end: daysAgo(1, 12), type: 'context-analysis', agent: 'claude' });
    await seedLog({ task: 'gamma-1', session: 's-other', model: 'haiku', at: daysAgo(1, 12), type: 'review', agent: 'codex' });

    const result = await loadCostExport(db, window30d, ['agent', 'execution_type']);
    assert.deepEqual(result.rows.map(row => [row.agent, row.execution_type, row.executions]), [
      ['claude', 'context-analysis', 1],
      [null, 'implementation', 1],
      [null, null, 1],
    ]);
    const byAgent = await loadCostExport(db, window30d, ['agent']);
    assert.deepEqual(byAgent.rows.map(row => [row.agent, row.executions]), [['claude', 1], [null, 2]]);
    assert.equal(byAgent.totals.executions, 3);
  } finally {
    db = previous;
    await scratch.destroy();
  }
});

test('a session-less call is evidence for one overlapping run only; other session-less runs stay unknown', async () => {
  const scratch = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await scratch.migrate.latest({ directory: fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url)) });
  const previous = db;
  db = scratch;
  try {
    await db('tasks').insert({ task_id: 'delta-1', repository: 'acme/delta', task_type: 'issue', created_at: daysAgo(5) });
    // Two session-less runs of one task on one model; only the earlier one's call was recorded.
    await seedExecution({ task: 'delta-1', at: daysAgo(2, 10), end: daysAgo(2, 11), model: 'opus', cost: 1 });
    await seedLog({ task: 'delta-1', model: 'opus', at: daysAgo(2, 10), end: daysAgo(2, 11), type: 'implementation', agent: 'claude' });
    await seedExecution({ task: 'delta-1', at: daysAgo(2, 14), end: daysAgo(2, 15), model: 'opus', cost: 4 });
    // Two runs overlapping one call: only the nearer one takes it.
    await seedExecution({ task: 'delta-1', at: daysAgo(1, 10), end: daysAgo(1, 12), model: 'opus', cost: 2 });
    await seedExecution({ task: 'delta-1', at: daysAgo(1, 11), end: daysAgo(1, 12), model: 'opus', cost: 8 });
    await seedLog({ task: 'delta-1', model: 'opus', at: daysAgo(1, 10), end: daysAgo(1, 12), type: 'review', agent: 'codex' });

    const result = await loadCostExport(db, window30d, ['agent', 'execution_type']);
    assert.deepEqual(result.rows.map(row => [row.agent, row.execution_type, row.executions, row.cost_usd]), [
      ['claude', 'implementation', 1, 1],
      ['codex', 'review', 1, 2],
      [null, null, 2, 12],
    ]);
    // A window that leaves out the call's own run does not lend the call to the later run.
    const late = { ...window30d, from: new Date(Date.parse(daysAgo(1, 10)) + 1_800_000) };
    const lateRows = await loadCostExport(db, late, ['agent']);
    assert.deepEqual(lateRows.rows.map(row => [row.agent, row.executions]), [[null, 1]]);
  } finally {
    db = previous;
    await scratch.destroy();
  }
});

test('repository filters leave out executions of other repositories and those without a task', async () => {
  const one = await loadCostExport(db, window30d, ['repository'], { repository: 'acme/beta' });
  assert.deepEqual(one.rows.map(row => [row.repository, row.executions]), [['acme/beta', 1]]);
  assert.equal(one.repository, 'acme/beta');
  const granted = await loadCostExport(db, window30d, ['repository'], { repositories: ['acme/alpha'] });
  assert.deepEqual(granted.rows.map(row => [row.repository, row.executions]), [['acme/alpha', 3]]);
  const none = await loadCostExport(db, window30d, ['repository'], { repositories: [] });
  assert.deepEqual(none.rows, []);
  assert.equal(none.totals.cost_usd, null);
});

test('CSV has a stable header, empty cells for unknowns, and escapes quotes, commas and formulas', () => {
  const costExport: CostExport = {
    period: '7d', repository: 'all', group_by: ['repository', 'model'],
    rows: [
      { repository: 'acme/a', model: 'say "hi", ok', executions: 2, tasks: 1, input_tokens: 10, output_tokens: 1,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 1.5 },
      { repository: null, model: '=HYPERLINK("x")', executions: 1, tasks: 0, input_tokens: 0, output_tokens: 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: null },
    ],
    totals: { executions: 3, tasks: 1, input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 1.5 },
  };
  assert.equal(costExportCsv(costExport), [
    'repository,model,executions,tasks,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,cost_usd',
    'acme/a,"say ""hi"", ok",2,1,10,1,0,0,1.5',
    ',"\'=HYPERLINK(""x"")",1,0,0,0,0,0,',
    '',
  ].join('\r\n'));
});

function fakeResponse() {
  const response = { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    status(code: number) { response.statusCode = code; return res; },
    json(body: unknown) { response.body = body; return res; },
    send(body: unknown) { response.body = body; return res; },
    setHeader(name: string, value: string) { response.headers[name.toLowerCase()] = value; return res; },
  };
  return { res: res as unknown as Response, response };
}

test('the routes read the analytics window, repository filter and group_by, and reject bad input', async () => {
  const routes = createCostExportRoutes({ db, now: () => NOW });
  const call = async (handler: 'getCost' | 'getCostCsv', query: Record<string, unknown>) => {
    const { res, response } = fakeResponse();
    await routes[handler]({ query } as unknown as Request, res);
    return response;
  };
  const json = await call('getCost', { period: '7d', repository: 'acme/alpha', group_by: 'model' });
  assert.equal(json.statusCode, 200);
  const body = json.body as CostExport;
  assert.deepEqual(body.rows.map(row => [row.model, row.executions]), [['gpt', 1], ['opus', 2]]);
  assert.equal(body.period, '7d');

  const csv = await call('getCostCsv', { period: '7d', group_by: 'outcome' });
  assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8');
  assert.match(csv.headers['content-disposition'], /filename="cost-7d\.csv"/);
  assert.equal(String(csv.body).split('\r\n')[0], 'outcome,executions,tasks,input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens,cost_usd');

  assert.equal((await call('getCost', { group_by: 'model,price' })).statusCode, 400);
  assert.equal((await call('getCost', { period: '2w' })).statusCode, 400);
  assert.equal((await call('getCostCsv', { repository: 'not a repo' })).statusCode, 400);
});

test('repeated or nested repository parameters are rejected rather than widened to every repository', async () => {
  const routes = createCostExportRoutes({ db, now: () => NOW });
  for (const handler of ['getCost', 'getCostCsv'] as const) {
    for (const repository of [['acme/alpha', 'acme/beta'], ['acme/alpha'], { name: 'acme/alpha' }]) {
      const { res, response } = fakeResponse();
      await routes[handler]({ query: { period: '7d', repository } } as unknown as Request, res);
      assert.equal(response.statusCode, 400, `${handler} ${JSON.stringify(repository)}`);
      assert.deepEqual(response.body, { error: 'Repository must be a string' });
    }
  }
});

test('the MCP tool scopes to the grant without a repository, and to the exact repository with one', async () => {
  const tools: McpTool[] = [];
  addStatsTools(tools, { db } as ToolDeps, async () => ['acme/beta'], () => NOW);
  const tool = tools.find(candidate => candidate.name === 'get_cost_breakdown');
  assert.ok(tool);
  assert.equal(tool.readOnly, true);
  assert.equal(tool.scope, 'read');
  const principal = {} as McpPrincipal;
  const run = async (args: Record<string, unknown>) => (await tool.run({ principal, args: tool.schema.parse(args) })).data as CostExport & { repositories: string[] };

  const granted = await run({ groupBy: ['repository', 'model'] });
  assert.equal(granted.period, '30d');
  assert.deepEqual(granted.repositories, ['acme/beta']);
  assert.deepEqual(granted.rows.map(row => [row.repository, row.model, row.executions]), [['acme/beta', 'opus', 1]]);

  const exact = await run({ repository: 'acme/alpha', period: '7d', groupBy: ['outcome'] });
  assert.deepEqual(exact.rows.map(row => [row.outcome, row.executions, row.cost_usd]), [['failed', 1, 0.5], ['success', 2, 3.75]]);
  assert.deepEqual((await run({})).group_by, ['day']);
  assert.throws(() => tool.schema.parse({ groupBy: ['cost'] }));
  assert.throws(() => tool.schema.parse({ extra: true }));
});
