import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMcpHttpHarness, type Json, type McpHttpHarness } from './fixtures/mcpHttpHarness.js';

// GHSA-46jr-4wx8-v453: one request within the SDK's 4 MiB default could exhaust
// memory during validation. /api/mcp bounds the body before authentication and
// the McpServer bounds tool-argument elements before schema validation. Every
// payload here is a bounded synthetic one; nothing tries to exhaust a process.

let h: McpHttpHarness;
before(async () => { h = await startMcpHttpHarness(); });
after(async () => {
  await h?.close();
  const { closeConnection } = await import('@propr/core');
  await closeConnection();
});

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const accessRows = () => h.db('mcp_access_log').orderBy('id').select<Json[]>('kind', 'name', 'outcome', 'error_code', 'status');

/** A get_connection call whose serialized body is exactly `bytes` long. */
function paddedCall(bytes: number): string {
  const empty = JSON.stringify(call(1, 'get_connection', { pad: '' }));
  const body = JSON.stringify(call(1, 'get_connection', { pad: 'x'.repeat(bytes - Buffer.byteLength(empty)) }));
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

async function assertServed(): Promise<void> {
  const response = await h.post(h.alpha.token, call(2, 'get_connection', {}));
  assert.equal(response.status, 200, response.text);
  assert.equal(response.messages[0].result.structuredContent.data.identity.id, h.alpha.id);
}

test('an MCP body over the documented bound is answered 413 before authentication or the SDK', async () => {
  const { MCP_MAX_REQUEST_BODY_BYTES } = await import('../mcp/config.js');
  const { MCP_CONNECT_CONTRACT } = await import('../mcp/connect.js');
  const authenticated = h.githubUserCalls();
  const rows = (await accessRows()).length;

  const response = await fetch(`${h.origin}/api/mcp`, {
    method: 'POST', body: paddedCall(MCP_MAX_REQUEST_BODY_BYTES + 1),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${h.alpha.token}` },
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
  assert.equal(response.headers.get('x-propr-mcp-contract'), MCP_CONNECT_CONTRACT);
  assert.equal(h.githubUserCalls(), authenticated, 'no credential lookup for a rejected body');
  assert.equal((await accessRows()).length, rows, 'nothing reached the MCP dispatch');

  // A body of exactly the bound is still parsed and dispatched; the schema
  // then rejects the unknown argument as for any other invalid call.
  const atLimit = await h.post(h.alpha.token, paddedCall(MCP_MAX_REQUEST_BODY_BYTES));
  assert.equal(atLimit.status, 200, atLimit.text);
  assert.equal(atLimit.messages[0].result.isError, true);
  assert.equal(h.githubUserCalls(), authenticated + 1);
  await assertServed();
});

test('tool arguments over the element budget are rejected before the tool runs or writes anything', async () => {
  const { MCP_MAX_TOOL_INPUT_ELEMENTS } = await import('../mcp/config.js');
  const before = await accessRows();
  const tables = ['task_drafts', 'mcp_operations', 'goals'] as const;
  const counts = async () => Promise.all(tables.map(async table => Number((await h.db(table).count({ count: '*' }).first())?.count)));
  const initial = await counts();

  // 2,600 four-key plan tasks: about 13,000 elements in a ~120 KiB body, well
  // under the size bound, so only the element budget can stop it here.
  const plan = Array.from({ length: 2_600 }, (_, index) => ({ title: `t${index}`, body: 'b', implementation: 'i' }));
  const body = call(3, 'create_plan', { repository: 'acme/alpha', name: 'Oversized plan', prompt: 'Fixture prompt', plan, idempotencyKey: 'element-budget-fixture' });
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 256 * 1024);
  const response = await h.post(h.alpha.token, body);
  assert.equal(response.status, 200, response.text);
  const result = response.messages[0].result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, new RegExp(`more than the maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`));

  assert.deepEqual(await counts(), initial, 'no plan, operation receipt or goal was written');
  // The SDK refused it before the tool wrapper, so the dispatch records the
  // rejection itself, without the arguments.
  const rows = (await accessRows()).slice(before.length);
  assert.deepEqual(rows, [{ kind: 'tool', name: 'create_plan', outcome: 'denied', error_code: 'INVALID_INPUT', status: 400 }]);
  await assertServed();
});
