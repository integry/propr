import type { PluginContext, PluginHandlerInput, PluginHttpRequestInit, PluginJsonValue, PluginProprClient } from '@propr/shared';

/** Test fixture handlers for packages/core/test/pluginHandlerRunner.test.ts. Imports only @propr/shared types. */
type Payload = Record<string, PluginJsonValue>;
const payload = (input: PluginHandlerInput): Payload => (input.kind === 'invoke' ? input.payload as Payload : {});

export async function succeed(input: PluginHandlerInput, ctx: PluginContext) {
  ctx.log.info('fixture handler ran', { kind: input.kind, greeting: ctx.settings.greeting as string });
  ctx.log.debug('a GitHub token in a log line is redacted: ghp_0123456789abcdefghijABCDEFGHIJ012345');
  return { greeting: ctx.settings.greeting as string, repositories: ctx.repositories };
}

export async function throws(_input: PluginHandlerInput, ctx: PluginContext) {
  ctx.log.warn('about to fail');
  throw new Error('fixture handler failure');
}

/** Never settles; once aborted it tries to keep working through ctx. */
export async function hangs(_input: PluginHandlerInput, ctx: PluginContext) {
  ctx.log.info('hanging');
  ctx.signal.addEventListener('abort', () => {
    ctx.log.info('after the time limit');
    ctx.state.set('late', true).catch(() => undefined);
  });
  return new Promise<never>(() => undefined);
}

export async function callPropr(input: PluginHandlerInput, ctx: PluginContext) {
  const { operation, args } = payload(input) as { operation: keyof PluginProprClient; args: PluginJsonValue[] };
  const method = ctx.propr[operation] as (...values: PluginJsonValue[]) => Promise<unknown>;
  try {
    return { ok: true, value: (await method(...args)) as PluginJsonValue ?? null };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message };
  }
}

/** Fetch through ctx.http and return everything the handler can see: ctx, the response status, headers and body. */
export async function fetchUrl(input: PluginHandlerInput, ctx: PluginContext) {
  const { url, connection, init } = payload(input) as { url: string; connection?: string; init?: PluginHttpRequestInit };
  try {
    const response = await ctx.http(connection)(url, init);
    const body = await response.text();
    ctx.log.info('fetched', { status: response.status, headers: response.headers, body });
    return { ok: true, status: response.status, headers: response.headers, body, ctx: JSON.parse(JSON.stringify(ctx)) as PluginJsonValue };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message };
  }
}

export async function useState(input: PluginHandlerInput, ctx: PluginContext) {
  const { op, key, value, prefix } = payload(input) as { op: 'get' | 'set' | 'delete' | 'keys'; key: string; value?: PluginJsonValue; prefix?: string };
  try {
    if (op === 'set') { await ctx.state.set(key, value ?? null); return { ok: true }; }
    if (op === 'get') return { ok: true, value: (await ctx.state.get(key)) ?? null };
    if (op === 'delete') return { ok: true, value: await ctx.state.delete(key) };
    return { ok: true, value: await ctx.state.keys(prefix) };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message };
  }
}

export async function returnsTooMuch() {
  return { data: 'x'.repeat(20_000) };
}

/** Not a handler: only exported functions are. */
export const notAFunction = 42;
