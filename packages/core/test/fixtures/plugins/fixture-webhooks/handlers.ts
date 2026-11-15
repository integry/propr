import type { PluginContext, PluginWebhookInput, PluginWebhookRequest, PluginWebhookResponse } from '@propr/shared';

/**
 * Test fixture handlers for packages/core/test/pluginWebhooks.test.ts and
 * packages/api/test/pluginWebhookRoutes.test.ts. Each delivery is appended to
 * `ctx.state` key `seen` (delivery id, webhook, attempt, the body's length and
 * the header names it received; never the body itself), so a test sees what
 * ran and how often. Imports only @propr/shared types.
 */
type Seen = { id: string; webhook: string; attempt: number; bodyBytes: number; headers: string[] }[];

export async function onWebhook(input: PluginWebhookInput, ctx: PluginContext) {
  const seen = (await ctx.state.get<Seen>('seen')) ?? [];
  seen.push({ id: input.deliveryId, webhook: input.webhook, attempt: input.attempt, bodyBytes: Buffer.byteLength(input.body), headers: Object.keys(input.headers).sort() });
  await ctx.state.set('seen', seen);
  ctx.log.info(`received webhook ${input.webhook}`, { attempt: input.attempt });
}

/** Fails while `fail` (a count of attempts still to fail) is above zero. */
export async function flakyWebhook(input: PluginWebhookInput, ctx: PluginContext) {
  await onWebhook(input, ctx);
  const remaining = (await ctx.state.get<number>('fail')) ?? 0;
  if (remaining > 0) {
    await ctx.state.set('fail', remaining - 1);
    throw new Error(`webhook failure, attempt ${input.attempt}`);
  }
}

/** Slack's `url_verification`: echo the challenge at once; any other event goes to the handler. */
export function slackChallenge(request: PluginWebhookRequest): PluginWebhookResponse | null {
  let body: { type?: unknown; challenge?: unknown };
  try { body = JSON.parse(request.body) as typeof body; } catch { return null; }
  return body.type === 'url_verification' && typeof body.challenge === 'string' ? { contentType: 'text/plain', body: body.challenge } : null;
}

const probes: { args: number; keys: string[]; frozen: boolean }[] = [];
/** Records what it was called with, then reaches for a `ctx` it never gets. */
export function probeRespond(request: PluginWebhookRequest, ...rest: unknown[]): PluginWebhookResponse {
  probes.push({ args: 1 + rest.length, keys: Object.keys(request).sort(), frozen: Object.isFrozen(request) && Object.isFrozen(request.headers) });
  const ctx = rest[0] as PluginContext;
  void ctx.state.set('respond', true);
  return { body: 'unreachable' };
}
/** What `probeRespond` saw, for the tests. */
export function respondProbes() { return probes; }
