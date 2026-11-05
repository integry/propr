import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { closeConnection } from '@propr/core';
import { syntheticAgentConfigSchema } from '@propr/shared';
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from '../mcp/config.js';
import { createToolCatalog, type ToolDeps } from '../mcp/tools.js';

after(async () => closeConnection());

type Schema = { [key: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Array elements plus object keys, as the SDK counts tool arguments against maxToolInputElements. */
function countElements(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.length + children.reduce((total: number, child) => total + countElements(child), 0);
}

/** The most elements any input valid under this JSON Schema can contain; Infinity when unbounded. */
function maxElements(schema: Schema | undefined, defs: Schema): number {
  if (!schema || typeof schema !== 'object') return 0;
  if (schema.$ref) return maxElements(defs[schema.$ref.split('/').pop()], defs);
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) return Math.max(...branches.map((branch: Schema) => maxElements(branch, defs)));
  if (schema.type === 'array') return schema.maxItems === undefined ? Infinity : schema.maxItems * (1 + maxElements(schema.items, defs));
  if (schema.type !== 'object') return 0;
  const declared = Object.values<Schema>(schema.properties ?? {}).reduce((total, child) => total + 1 + maxElements(child, defs), 0);
  const open = typeof schema.additionalProperties === 'object' || schema.propertyNames;
  return open ? declared + (schema.maxProperties === undefined ? Infinity : schema.maxProperties * (1 + maxElements(schema.additionalProperties, defs))) : declared;
}

const catalog = createToolCatalog({ db: {} as never, taskQueue: {} as never, redisClient: {} as never, runtimeBuildQueue: {} as never, policy: { config: { instanceId: 'budget' } } as never } as ToolDeps);

test('every bounded tool input fits the element budget, and only the known configuration inputs are unbounded', () => {
  const unbounded: string[] = [];
  let largest = 0;
  for (const tool of catalog) {
    const schema = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as Schema;
    const max = maxElements(schema, schema.$defs ?? {});
    if (max === Infinity) { unbounded.push(tool.name); continue; }
    assert.ok(max <= MCP_MAX_TOOL_INPUT_ELEMENTS, `${tool.name} accepts up to ${max} elements, over the budget`);
    largest = Math.max(largest, max);
  }
  // Leave headroom so the budget is never the first limit a valid call meets.
  assert.ok(largest * 10 <= MCP_MAX_TOOL_INPUT_ELEMENTS, `largest bounded input ${largest}`);
  assert.deepEqual(unbounded.sort(), ['create_synthetic_agent', 'update_agent_configuration', 'update_synthetic_agent']);
});

const member = (index: number) => ({ id: randomUUID(), directAgentAlias: `agent-${index % 10}`, model: `model-${index}`, enabled: true, priority: 50, usageLimits: { sessionMaxPercent: 80, weeklyMaxPercent: 90 } });
const composition = (models: number, members: number) => ({
  id: randomUUID(), alias: 'pool', enabled: true, defaultModel: 'model-0',
  models: Array.from({ length: models }, (_, model) => ({ id: `model-${model}`, displayName: `Model ${model}`, enabled: true, strategy: 'usage_based',
    members: Array.from({ length: members }, (_, index) => member(model * members + index)) })),
});

test('the unbounded configuration inputs fit the budget at realistic sizes, and only the budget bounds them', () => {
  // A direct agent supports at most 100 models; its label and reasoning maps key off them.
  const models = Array.from({ length: 100 }, (_, index) => `provider/model-${index}`);
  const agentUpdate = { idempotencyKey: 'budget-fixture', agentId: 'agent', alias: 'agent', enabled: true, supportedModels: models, defaultModel: models[0],
    modelCustomLabels: Object.fromEntries(models.map(model => [model, model])), modelReasoningLevels: Object.fromEntries(models.map(model => [model, 'high'])) };
  assert.ok(countElements(agentUpdate) <= MCP_MAX_TOOL_INPUT_ELEMENTS);

  // A synthetic agent with 30 models of 20 members each still fits.
  const large = composition(30, 20);
  assert.ok(syntheticAgentConfigSchema.safeParse(large).success);
  assert.ok(countElements({ idempotencyKey: 'budget-fixture', agentId: large.id, configuration: large }) <= MCP_MAX_TOOL_INPUT_ELEMENTS);

  // The schema itself accepts a composition far over the budget, so for these
  // inputs the SDK budget is the only bound before the tool runs.
  const oversized = composition(1, 1_200);
  assert.ok(syntheticAgentConfigSchema.safeParse(oversized).success);
  assert.ok(countElements(oversized) > MCP_MAX_TOOL_INPUT_ELEMENTS);
});
