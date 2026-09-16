import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { closeConnection, db, saveAgents, type AgentConfig } from '@propr/core';
import { addConfigurationTools } from '../mcp/toolsConfiguration.js';
import type { McpTool, ToolDeps } from '../mcp/tools.js';
import type { McpPrincipal } from '../mcp/policy.js';
import type { createConfigRoutes } from '../routes/configRoutes.js';

after(async () => {
  await closeConnection();
});

const museAgent: AgentConfig = {
  id: 'mcp-muse',
  type: 'muse',
  alias: 'muse',
  enabled: true,
  dockerImage: 'propr/agent:latest',
  configPath: '~/.config/muse',
  supportedModels: ['muse-spark-1.3'],
  defaultModel: 'muse-spark-1.3',
};

async function setupTools(seededAgents: AgentConfig[]) {
  await db.migrate.latest();
  await saveAgents(seededAgents);
  const tools: McpTool[] = [];
  const forwarded: Array<Record<string, unknown>> = [];
  const config = {
    postAgents: ((req: Request, res: Response) => {
      forwarded.push(req.body as Record<string, unknown>);
      res.json({ warnings: [] });
    }),
  } as unknown as ReturnType<typeof createConfigRoutes>;
  const deps = { policy: { config: { origin: 'http://test.invalid' } } } as unknown as ToolDeps;
  addConfigurationTools(tools, deps, config);
  const principal = { user: { id: 'tester', username: 'tester' }, authorization: {} } as unknown as McpPrincipal;
  return { tools, forwarded, principal };
}

function findTool(tools: McpTool[], name: string): McpTool {
  const tool = tools.find(candidate => candidate.name === name);
  assert.ok(tool, `expected tool ${name}`);
  return tool;
}

test('update_agent_configuration forwards patches without requiring a type', async () => {
  const { tools, forwarded, principal } = await setupTools([museAgent]);
  const tool = findTool(tools, 'update_agent_configuration');
  const args = tool.schema.parse({ idempotencyKey: 'update-key-1', agentId: 'mcp-muse', alias: 'muse-renamed' });

  const result = await tool.run({ principal, args });

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, 1);
  const agents = forwarded[0]?.agents as AgentConfig[];
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.alias, 'muse-renamed');
});

test('remove_agent_configuration forwards the filtered agent list', async () => {
  const { tools, forwarded, principal } = await setupTools([museAgent]);
  const tool = findTool(tools, 'remove_agent_configuration');
  const args = tool.schema.parse({ idempotencyKey: 'remove-key-1', agentId: 'mcp-muse' });

  const result = await tool.run({ principal, args });

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0]?.agents, []);
});

test('create_agent_configuration uses the new agent type default config path', async () => {
  const { tools, forwarded, principal } = await setupTools([]);
  const tool = findTool(tools, 'create_agent_configuration');
  const args = tool.schema.parse({
    idempotencyKey: 'create-key-1',
    agentId: 'mcp-muse-2',
    type: 'muse',
    alias: 'muse-2',
    supportedModels: ['muse-spark-1.3'],
    defaultModel: 'muse-spark-1.3',
  });

  const result = await tool.run({ principal, args });

  assert.equal(result.status, 200);
  assert.equal(forwarded.length, 1);
  const agents = forwarded[0]?.agents as AgentConfig[];
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.configPath, '~/.config/muse');
});
