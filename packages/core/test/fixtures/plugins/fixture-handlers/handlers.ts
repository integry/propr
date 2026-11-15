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

/**
 * Fetch and report whether the handler could see `probe` (the test's credential) in any
 * handler-visible form: the text, the text parsed by the handler, or `json()`.
 */
export async function fetchProbe(input: PluginHandlerInput, ctx: PluginContext) {
  const { url, connection, probe } = payload(input) as { url: string; connection?: string; probe: string };
  try {
    const response = await ctx.http(connection)(url);
    const text = await response.text();
    const parsed = (() => { try { return JSON.parse(text) as PluginJsonValue; } catch { return null; } })();
    // A form or HTML body is not JSON: json() refuses it.
    const json = await response.json<PluginJsonValue>().catch(() => null);
    const decoded = (value: unknown): boolean => typeof value === 'string' ? value.includes(probe) : value !== null && typeof value === 'object' && Object.entries(value).some(([k, v]) => k.includes(probe) || decoded(v));
    // A header value (or one part of a joined value) parsed as JSON by the handler.
    const parsedHeader = (value: string) => [value, ...value.split(', ')].some(part => { try { return decoded(JSON.parse(part)); } catch { return false; } });
    // A header name (lowercased, as names arrive) as is, URL-decoded or JSON-decoded by the handler, compared case-insensitively.
    const attempt = (decode: () => unknown) => { try { return decode(); } catch { return null; } };
    const nameHasProbe = (name: string) => [name, attempt(() => decodeURIComponent(name)), attempt(() => JSON.parse(`"${name}"`))]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(probe.toLowerCase()));
    // Every string the handler can see (the text, each parsed or json() string and key, each header value, also parsed as JSON), URL-decoded again and again.
    const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)]) : [];
    const headerValues = Object.values(response.headers);
    const visible = [text, ...strings(parsed), ...strings(json), ...headerValues, ...headerValues.flatMap(v => [v, ...v.split(', ')].flatMap(part => strings(attempt(() => JSON.parse(part)))))];
    // decodeURIComponent, or each escape alone as unescape() decodes it (`%2f`, `%u002f`) where it refuses the text.
    const urlDecode = (value: string) => (attempt(() => decodeURIComponent(value)) as string | null)
      ?? value.replace(/%(?:u[0-9a-f]{4}|[0-9a-f]{2})/gi, escape => String.fromCharCode(parseInt(escape.replace(/^%u?/i, ''), 16)));
    const urlDecodes = (value: string) => {
      for (let current = value, round = 0; round < 8; round++) {
        const next = urlDecode(current);
        if (next.includes(probe)) return true;
        if (next === current) return false;
        current = next;
      }
      return false;
    };
    return {
      ok: true, textHasProbe: text.includes(probe), parsedHasProbe: decoded(parsed), jsonHasProbe: decoded(json),
      headersHaveProbe: headerValues.some(v => v.includes(probe)), parsedHeadersHaveProbe: headerValues.some(parsedHeader),
      headerNamesHaveProbe: Object.keys(response.headers).some(nameHasProbe), urlDecodedHasProbe: visible.some(urlDecodes),
    };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message };
  }
}

/** Make an authenticated request (the run then holds its credential), then log `note`, a value from the input, and return it. */
export async function fetchThenLog(input: PluginHandlerInput, ctx: PluginContext) {
  const { url, connection, note } = payload(input) as { url: string; connection: string; note: string };
  await ctx.http(connection)(url);
  ctx.log.info(note, { note });
  return { note };
}

/** Log `note` (a value from the input) before the run holds any credential, then make an authenticated request, and return the note. */
export async function logThenFetch(input: PluginHandlerInput, ctx: PluginContext) {
  const { url, connection, note } = payload(input) as { url: string; connection: string; note: string };
  ctx.log.info(note, { note });
  await ctx.http(connection)(url);
  return { note };
}

/**
 * Wait on a ctx.propr read (the test holds it), then use state: a handler still
 * running across an uninstall. `op` defaults to writing `key`.
 */
export async function suspendThenSet(input: PluginHandlerInput, ctx: PluginContext) {
  const { key, op = 'set' } = payload(input) as { key: string; op?: 'set' | 'get' | 'delete' | 'keys' };
  await ctx.propr.getIssue('owner/allowed', 3).catch(() => undefined);
  try {
    if (op === 'get') return { ok: true, value: (await ctx.state.get(key)) ?? null };
    if (op === 'delete') return { ok: true, value: await ctx.state.delete(key) };
    if (op === 'keys') return { ok: true, value: await ctx.state.keys() };
    await ctx.state.set(key, 'written after resuming');
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? null, message: (error as Error).message };
  }
}

/** Make an authenticated request (the run then holds its credential), then fail with `note`, a value from the input, as the error message. */
export async function fetchThenThrow(input: PluginHandlerInput, ctx: PluginContext) {
  const { url, connection, note } = payload(input) as { url: string; connection: string; note: string };
  await ctx.http(connection)(url);
  throw new Error(note);
}

/** Wait on a ctx.propr read (the test holds it), then make one ctx.propr call: a mutation resuming across an uninstall. */
export async function suspendThenPropr(input: PluginHandlerInput, ctx: PluginContext) {
  await ctx.propr.getIssue('owner/allowed', 3).catch(() => undefined);
  return callPropr(input, ctx);
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
