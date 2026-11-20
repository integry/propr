import type { PluginContext, PluginEventInput } from '@propr/shared';

/**
 * Test fixture handlers for packages/core/test/pluginDispatcher.test.ts. Each
 * delivery is appended to `ctx.state` key `seen` (delivery id, seq, attempt),
 * so a test sees what was delivered, in which order and how often. Imports
 * only @propr/shared types.
 */
type Seen = { id: string; seq: number; repository: string; attempt: number }[];

async function remember(input: PluginEventInput, ctx: PluginContext) {
  const seen = (await ctx.state.get<Seen>('seen')) ?? [];
  seen.push({ id: input.deliveryId, seq: input.event.seq, repository: input.event.repository, attempt: input.attempt });
  await ctx.state.set('seen', seen);
}

export async function record(input: PluginEventInput, ctx: PluginContext) {
  await remember(input, ctx);
  ctx.log.info(`received ${input.event.domain}.${input.event.type}`, { seq: input.event.seq });
}

/** Behaves as the `mode` state key says: `ok`, `throw` or `hang` (past the time limit). */
export async function onMerged(input: PluginEventInput, ctx: PluginContext) {
  const mode = (await ctx.state.get<string>('mode')) ?? 'ok';
  await remember(input, ctx);
  if (mode === 'throw') throw new Error(`merge handler failure for ${input.deliveryId}`);
  if (mode === 'hang') return new Promise<never>(() => undefined);
}

/** Fails while `fail` (a count of attempts still to fail) is above zero. */
export async function flaky(input: PluginEventInput, ctx: PluginContext) {
  await remember(input, ctx);
  const remaining = (await ctx.state.get<number>('fail')) ?? 0;
  if (remaining > 0) {
    await ctx.state.set('fail', remaining - 1);
    ctx.log.warn('failing on purpose', { remaining });
    throw new Error(`flaky failure, attempt ${input.attempt}`);
  }
}
