/**
 * The cache hit rate is only right if `loadCacheUsage` reads `input_tokens`
 * by the convention the execution producer actually persists. This runs the
 * production producer, `recordLLMMetrics`, over a representative run on the
 * real `llm_executions` schema and reads the result back through the
 * aggregation, so the two cannot drift apart unnoticed.
 */

import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as initialSchema } from '../../core/src/db/migrations/20251216000000_initial_sqlite_schema.js';
import { up as addTokenUsage } from '../../core/src/db/migrations/20260204000000_add_token_usage_to_llm_executions.js';
import { up as nullableTaskId } from '../../core/src/db/migrations/20260415000000_make_llm_executions_task_id_nullable.js';

// Imported after NODE_ENV, so core's modules do not decide this process is a
// misconfigured server.
process.env.NODE_ENV ??= 'test';

const database: Knex = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const log = { info() {}, warn() {}, error() {}, debug() {}, withCorrelation: () => log };
/** A Redis that accepts every command: the producer's counters are not under test. */
class SilentRedis {
  constructor() {
    return new Proxy(this, { get: (_target, property) => (property === 'then' ? undefined : async () => null) });
  }
}
await mock.module('../../core/src/db/connection.js', { namedExports: { db: database, closeConnection: async () => {} } });
await mock.module('../../core/src/utils/logger.js', { defaultExport: log });
await mock.module('../../core/src/services/pricingService.js', { namedExports: { getModelPricing: async () => null } });
await mock.module('../../core/src/config/modelAliases.js', { namedExports: { getOpenRouterId: (model: string) => model } });
await mock.module('../../core/src/utils/tokenCalculation.js', { namedExports: { calculateCostWithCachePricing: () => 0 } });
const ioredis = { Redis: SilentRedis };
await mock.module('ioredis', { namedExports: ioredis, defaultExport: ioredis });

const { recordLLMMetrics } = await import('../../core/src/utils/llmMetrics.js');
const { loadCacheUsage } = await import('../routes/analyticsAggregates.js');
/** Claude Opus 5.5's prompt and cache-read prices per token; the official lookup has its own test. */
const opusPrice = () => ({ prompt: 4 / 1_000_000, cacheRead: 0.2 / 1_000_000 });

before(async () => {
  await initialSchema(database);
  await addTokenUsage(database);
  await nullableTaskId(database);
  await database('tasks').insert({ task_id: 'task-1', repository: 'acme/repo', issue_number: 1, task_type: 'issue' });
});
after(async () => database.destroy());

/** One assistant message's usage, as the Claude CLI reports it in the conversation log. */
const message = (id: string, usage: { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }) => ({
  type: 'assistant', timestamp: new Date().toISOString(), message: { id, usage: { ...usage, output_tokens: 100 } },
});

test('the persisted input count includes cached tokens, and the hit rate divides by it once', async () => {
  // 2,000 uncached tokens, 8,000 written to the cache and 150,000 read back from it.
  await recordLLMMetrics({
    model: 'claude-opus-5-5', success: true, executionTime: 1_000, sessionId: 's1', finalResult: { num_turns: 3 },
    conversationLog: [
      message('m1', { input_tokens: 1_000, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 0 }),
      message('m2', { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 75_000 }),
      message('m3', { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 75_000 }),
    ],
  }, { repoOwner: 'acme', repoName: 'repo', number: 1 }, { correlationId: 'c1', taskId: 'task-1' });

  const stored = await database('llm_executions')
    .select('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')
    .first() as { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  // `input_tokens` is the whole prompt, not the uncached portion beside the cache counts.
  assert.deepEqual(stored, { input_tokens: 160_000, cache_creation_input_tokens: 8_000, cache_read_input_tokens: 150_000 });
  assert.ok(stored.input_tokens >= stored.cache_creation_input_tokens + stored.cache_read_input_tokens);

  const usage = await loadCacheUsage(database, null, opusPrice);
  assert.deepEqual(usage, {
    input_tokens: 160_000,
    cache_read_tokens: 150_000,
    // 150k of 160k, not 150k of 318k: the cached tokens enter the denominator once.
    hit_rate: 0.9375,
    // 150k cached reads at $3.80/M below Claude Opus 5.5's full prompt price.
    saved_usd: 0.57,
  });
  // The percentage the token pane prints from those two counts.
  assert.equal(Math.round((usage!.cache_read_tokens / usage!.input_tokens) * 1000) / 10, 93.8);
});
