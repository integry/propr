import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyntheticAgentConfig } from "@propr/shared";
import type { ApiClient } from "./client.js";
import {
  deleteSyntheticAgent,
  listSyntheticAgents,
  saveSyntheticAgents,
} from "./syntheticPools.js";

const pool: SyntheticAgentConfig = {
  id: "11111111-1111-4111-8111-111111111111",
  alias: "pool",
  enabled: true,
  defaultModel: "virtual",
  models: [{
    id: "virtual",
    enabled: true,
    strategy: "round_robin",
    members: [{
      id: "22222222-2222-4222-8222-222222222222",
      directAgentAlias: "codex-a",
      model: "gpt-5.6-sol",
      enabled: true,
      priority: 100,
    }],
  }],
};

test("synthetic pool helpers use the complete configuration endpoint", async () => {
  const calls: Array<{ method: string; endpoint: string; options?: unknown }> = [];
  const client = {
    async get(endpoint: string) {
      calls.push({ method: "GET", endpoint });
      return { data: { synthetic_agents: [pool] }, status: 200, headers: new Headers() };
    },
    async post(endpoint: string, options?: unknown) {
      calls.push({ method: "POST", endpoint, options });
      return { data: { success: true, synthetic_agents: [] }, status: 200, headers: new Headers() };
    },
  } as unknown as ApiClient;

  assert.deepEqual(await listSyntheticAgents(client), { synthetic_agents: [pool] });
  await saveSyntheticAgents([pool], client);
  await deleteSyntheticAgent("pool", client);

  assert.deepEqual(calls, [
    { method: "GET", endpoint: "/api/config/synthetic-agents" },
    { method: "POST", endpoint: "/api/config/synthetic-agents", options: { body: { synthetic_agents: [pool] } } },
    { method: "GET", endpoint: "/api/config/synthetic-agents" },
    { method: "POST", endpoint: "/api/config/synthetic-agents", options: { body: { synthetic_agents: [] } } },
  ]);
});

test("delete rejects a selector that matches different pools by ID and alias", async () => {
  const aliasCollision: SyntheticAgentConfig = {
    ...pool,
    id: "33333333-3333-4333-8333-333333333333",
    alias: pool.id,
  };
  let postCalls = 0;
  const client = {
    async get() {
      return { data: { synthetic_agents: [pool, aliasCollision] }, status: 200, headers: new Headers() };
    },
    async post() {
      postCalls += 1;
      return { data: { success: true, synthetic_agents: [] }, status: 200, headers: new Headers() };
    },
  } as unknown as ApiClient;

  await assert.rejects(
    deleteSyntheticAgent(pool.id, client),
    new RegExp(`selector '${pool.id}' is ambiguous`)
  );
  assert.equal(postCalls, 0);
});
