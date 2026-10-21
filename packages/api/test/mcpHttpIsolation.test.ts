import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMcpHttpHarness, type HarnessPrincipal, type Json, type McpHttpHarness } from './fixtures/mcpHttpHarness.js';

// GHSA-jm63-cq47-j5jp: SDK clients number JSON-RPC ids from 0, so ids collide
// across clients in normal use, and a transport or McpServer shared between
// requests matched responses to the wrong client. serveMcpRequest builds both
// per request; these tests hold that over the production HTTP route.

let h: McpHttpHarness;
before(async () => { h = await startMcpHttpHarness(); });
after(async () => {
  await h?.close();
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

const alphaGoal = '11111111-1111-4111-8111-111111111111';
const betaGoal = '22222222-2222-4222-8222-222222222222';
const goalDefaults = {
  objective: 'Fixture objective', launch_strategy: 'direct', initial_prompt: 'Fixture prompt', agent_id: 'codex', agent_alias: 'codex', agent_type: 'codex',
  requested_model: 'fixture-model', desired_state: 'running', artifact_refs: '[]', artifact_stats: '{}', run_generation: 1, run_claim: 'claim-1',
  session_id: 'thread-1', paused_ms: 0, resume_requested: false, control_generation: 0, control_ack_generation: 0, checkpoint_count: 0,
  claimed_at: '2026-10-04 10:00:00', started_at: '2026-10-04 10:00:00', created_at: '2026-10-04 10:00:00', updated_at: '2026-10-04 10:00:00',
};

const call = (id: number | string, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** The single JSON-RPC response of one HTTP exchange, after checking nothing else arrived on it. */
function only(response: { status: number; messages: Json[]; text: string }, id: number | string): Json {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.messages.length, 1, `exactly one message per exchange, no foreign results or notifications: ${response.text}`);
  assert.equal(response.messages[0].id, id);
  return response.messages[0];
}

function assertConnection(message: Json, principal: HarnessPrincipal): void {
  assert.notEqual(message.result.isError, true, JSON.stringify(message));
  const data = message.result.structuredContent.data;
  assert.equal(data.identity.id, principal.id);
  assert.equal(data.identity.username, principal.login);
  assert.deepEqual(data.scopes, principal.scopes);
  assert.deepEqual(data.repositories, principal.repositories);
  assert.equal(data.capabilities.includes('create_plan'), principal.scopes.includes('plan'));
}

test('concurrent requests from differently scoped principals with colliding ids each get only their own results', async () => {
  const { alpha, beta } = h;
  const authenticated = h.githubUserCalls();
  const rounds = 6;
  // Every request reaches serveMcpRequest at the same moment, all with id 0.
  const released = h.holdAuthentication(rounds * 2);
  const exchanges = Array.from({ length: rounds }, (_, index) => [alpha, beta].map(principal => ({
    principal, list: index % 2 === 1,
    response: h.post(principal.token, index % 2 === 1 ? { jsonrpc: '2.0', id: 0, method: 'tools/list' } : call(0, 'get_connection')),
  }))).flat();
  await released;
  for (const exchange of exchanges) {
    const message = only(await exchange.response, 0);
    if (!exchange.list) { assertConnection(message, exchange.principal); continue; }
    const names = message.result.tools.map((tool: Json) => tool.name);
    assert.ok(names.includes('get_connection'));
    assert.equal(names.includes('create_plan'), exchange.principal === alpha, 'each grant lists only the tools its scopes allow');
  }
  assert.equal(h.githubUserCalls() - authenticated, rounds * 2, 'every request authenticated its own bearer');
});

test('an open blocking call stays with its client, cancellation releases it, and service continues', async () => {
  const { alpha, beta, db } = h;
  const { activeGoalWaiterCount, notifyGoalWaiters } = await import('../services/goalWait.js');
  await db('goals').insert([
    { ...goalDefaults, goal_id: alphaGoal, owner_id: alpha.id, owner_login: alpha.login, repository: 'acme/alpha', title: 'Alpha goal', current_task_id: 'alpha-task' },
    { ...goalDefaults, goal_id: betaGoal, owner_id: beta.id, owner_login: beta.login, repository: 'acme/beta', title: 'Beta goal', current_task_id: 'beta-task' },
  ]);
  const waitFor = async (condition: () => boolean, what: string) => {
    for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(condition(), what);
  };

  // Alpha's wait stays open inside the SDK while both clients reuse its id.
  const open = h.post(alpha.token, call(1, 'wait_goal', { repository: 'acme/alpha', goalId: alphaGoal, until: 'completed', timeoutSeconds: 30 }));
  await waitFor(() => activeGoalWaiterCount(alphaGoal) === 1, 'the wait is open');
  const during = await Promise.all([alpha, beta, beta, alpha, beta].map(async principal => ({ principal, response: await h.post(principal.token, call(1, 'get_connection')) })));
  for (const { principal, response } of during) assertConnection(only(response, 1), principal);
  const betaWait = only(await h.post(beta.token, call(1, 'wait_goal', { repository: 'acme/beta', goalId: betaGoal, timeoutSeconds: 0 })), 1);
  assert.equal(betaWait.result.structuredContent.data.goal.id, betaGoal);
  // Neither the grant nor the owner reaches the other client's goal.
  for (const args of [{ repository: 'acme/alpha', goalId: alphaGoal }, { repository: 'acme/beta', goalId: alphaGoal }]) {
    const denied = only(await h.post(beta.token, call(1, 'wait_goal', { ...args, timeoutSeconds: 0 })), 1);
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.structuredContent.error.code, /^(REPOSITORY_FORBIDDEN|NOT_FOUND)$/);
  }
  assert.equal(activeGoalWaiterCount(alphaGoal), 1, 'the other requests left the open wait alone');
  await db('goals').where({ goal_id: alphaGoal }).update({ result_state: 'completed' });
  notifyGoalWaiters(alphaGoal);
  const finished = only(await open, 1);
  assert.equal(finished.result.structuredContent.data.outcome, 'matched');
  assert.equal(finished.result.structuredContent.data.goal.id, alphaGoal);
  assert.equal(activeGoalWaiterCount(alphaGoal), 0);

  // A client that hangs up cancels only its own wait; the goal is untouched.
  const before = await db('goals').where({ goal_id: betaGoal }).first();
  const controller = new AbortController();
  const abandoned = h.post(beta.token, call(0, 'wait_goal', { repository: 'acme/beta', goalId: betaGoal, until: 'completed', timeoutSeconds: 30 }), { signal: controller.signal });
  abandoned.catch(() => { /* aborted below */ });
  await waitFor(() => activeGoalWaiterCount(betaGoal) === 1, 'the second wait is open');
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(abandoned);
  await waitFor(() => activeGoalWaiterCount(betaGoal) === 0, 'the disconnect released the wait');
  assert.ok(Date.now() - startedAt < 5_000, 'released by the disconnect, not the timeout');
  assert.deepEqual(await db('goals').where({ goal_id: betaGoal }).first(), before);

  // Both clients are served normally afterwards.
  for (const principal of [beta, alpha]) assertConnection(only(await h.post(principal.token, call(0, 'get_connection')), 0), principal);
});

test('two SDK clients numbering their own ids from 0 interleave without crossing results', async () => {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const connect = async (principal: HarnessPrincipal) => {
    const client = new Client({ name: `isolation-${principal.login}`, version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${h.origin}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${principal.token}` } } }));
    return client;
  };
  const clients = await Promise.all([h.alpha, h.beta].map(async principal => ({ principal, client: await connect(principal) })));
  try {
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(clients.flatMap(({ principal, client }) => [0, 1, 2].map(async () => ({ principal, result: await client.callTool({ name: 'get_connection', arguments: {} }) }))));
      for (const { principal, result } of results) assertConnection({ result }, principal);
      const listed = await Promise.all(clients.map(async ({ principal, client }) => ({ principal, names: (await client.listTools()).tools.map(tool => tool.name) })));
      for (const { principal, names } of listed) assert.equal(names.includes('create_plan'), principal === h.alpha);
    }
  } finally {
    await Promise.all(clients.map(({ client }) => client.close()));
  }
});
