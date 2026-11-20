import { PluginDeliveryError, PluginSdkError, parsePluginRetryAfter, type PluginContext, type PluginJsonValue } from '@propr/shared';

/**
 * Linear's GraphQL API (https://linear.app/developers/graphql), through
 * `ctx.http('api-key')`: ProPR sends the personal API key as the whole
 * `Authorization` header (Linear's API keys take no `Bearer` scheme; the
 * connection declares `authorization: raw`), and only `api.linear.app` is
 * reachable. A GraphQL error can come with HTTP 200, so the `errors` array is
 * checked on every answer. Rate limits answer HTTP 429 (or 400 with the
 * `RATELIMITED` code); see https://linear.app/developers/rate-limiting.
 */

export const API_KEY = 'api-key';
export const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';

/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'permission_denied']);
/** Linear's error codes (`extensions.code`) that may succeed later. */
const TRANSIENT_CODES = new Set(['RATELIMITED', 'INTERNAL_SERVER_ERROR', 'SERVICE_UNAVAILABLE']);
const code = (value: unknown): string | null => (typeof value === 'string' && /^[A-Z_]{1,64}$/.test(value) ? value : null);

/** What the configure form shows before the API key is set. */
export const NOT_CONNECTED = 'Linear is not connected yet. Set the Linear API key under Connections, then choose Reload choices.';

/** A refusal from Linear; `permanent` unless it may succeed later. Its message holds only Linear's coded reason. */
export class LinearApiError extends Error {
  readonly name = 'LinearApiError';
  constructor(readonly code: string, readonly permanent: boolean, readonly retryAfterMs: number | null = null) { super(`Linear answered ${code}`); }
}

/**
 * One GraphQL request. Throws `LinearApiError` for Linear's answers and
 * `PluginDeliveryError` when the key is not set or Linear cannot be reached.
 * Variables carry ids and ProPR's own text only; Linear's error messages are
 * not repeated (they may quote input), only their codes.
 */
export async function linearGraphql<T>(ctx: PluginContext, query: string, variables: Record<string, PluginJsonValue> = {}): Promise<T> {
  let status: number; let retryAfter: string | undefined; let text: string;
  try {
    const response = await ctx.http(API_KEY)(LINEAR_GRAPHQL, { method: 'POST', json: { query, variables }, headers: { 'content-type': 'application/json' } });
    status = response.status; retryAfter = response.headers['retry-after'];
    text = (await response.text()).slice(0, 512_000);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) throw new PluginDeliveryError(`The Linear API request was refused: ${sdk.message}`, { permanent: true });
    throw new PluginDeliveryError(`Linear could not be reached: ${sdk ? sdk.message : 'the request failed'}`);
  }
  const body = parseBody<T>(text);
  const first = Array.isArray(body?.errors) ? body!.errors[0] : undefined;
  const reason = code(first?.extensions?.code) ?? (status === 429 ? 'RATELIMITED' : status === 401 ? 'AUTHENTICATION_ERROR' : status === 403 ? 'FORBIDDEN' : null);
  if (status === 429 || reason === 'RATELIMITED') throw new LinearApiError('RATELIMITED', false, parsePluginRetryAfter(retryAfter));
  if (status >= 500 || status === 408) throw new LinearApiError(`HTTP_${status}`, false, parsePluginRetryAfter(retryAfter));
  if (reason || status < 200 || status >= 300 || !body?.data) {
    const failure = reason ?? `HTTP_${status}`;
    throw new LinearApiError(failure, !TRANSIENT_CODES.has(failure));
  }
  return body.data;
}

type GraphqlBody<T> = { data?: T; errors?: { extensions?: { code?: unknown } }[] };
function parseBody<T>(text: string): GraphqlBody<T> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as GraphqlBody<T> : null;
  } catch { return null; }
}

/** A `LinearApiError` (or any other error) as the delivery's failure. */
export function deliveryFailure(error: unknown, what: string): Error {
  if (!(error instanceof LinearApiError)) return error instanceof Error ? error : new Error(String(error));
  if (!error.permanent) {
    const wait = error.retryAfterMs === null ? '' : `; it asked to retry after ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} s`;
    return new PluginDeliveryError(`Linear answered ${error.code} for ${what}${wait}`, { retryAfterMs: error.retryAfterMs });
  }
  const hint = error.code === 'AUTHENTICATION_ERROR' ? 'Check the Linear API key under Connections' : 'Check the API key\'s permissions and the plugin\'s settings';
  return new PluginDeliveryError(`Linear refused ${what} with ${error.code}; it is not retried. ${hint}`, { permanent: true });
}

export interface LinearTicket {
  id: string; identifier: string; title: string; description: string | null; url: string;
  team: { id: string; key: string; name: string } | null;
  project: { id: string; name: string } | null;
  labels: { id: string; name: string }[];
}

const TICKET = `query ProprTicket($id: String!) {
  issue(id: $id) { id identifier title description url team { id key name } project { id name } labels(first: 100) { nodes { id name } } }
}`;
/** The ticket as Linear has it now (scope: read). */
export async function getTicket(ctx: PluginContext, id: string): Promise<LinearTicket> {
  const data = await linearGraphql<{ issue: (Omit<LinearTicket, 'labels'> & { labels?: { nodes?: { id: string; name: string }[] } }) | null }>(ctx, TICKET, { id });
  if (!data.issue) throw new LinearApiError('NOT_FOUND', true);
  return { ...data.issue, labels: Array.isArray(data.issue.labels?.nodes) ? data.issue.labels!.nodes : [] };
}

const COMMENT = `mutation ProprComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
/** Comment on the ticket (permission: create comments). `body` is ProPR's own text. */
export async function commentOnTicket(ctx: PluginContext, issueId: string, body: string): Promise<void> {
  const data = await linearGraphql<{ commentCreate?: { success?: boolean } }>(ctx, COMMENT, { issueId, body });
  if (data.commentCreate?.success !== true) throw new LinearApiError('COMMENT_NOT_CREATED', false);
}

const TEAM_STATES = `query ProprTicketStates($id: String!) { issue(id: $id) { team { key states(first: 250) { nodes { id name } } } } }`;
/** The workflow states of the ticket's team, and its key. */
export async function ticketTeamStates(ctx: PluginContext, issueId: string): Promise<{ team: string; states: { id: string; name: string }[] }> {
  const data = await linearGraphql<{ issue: { team: { key: string; states: { nodes: { id: string; name: string }[] } } | null } | null }>(ctx, TEAM_STATES, { id: issueId });
  const team = data.issue?.team;
  if (!team) throw new LinearApiError('NOT_FOUND', true);
  return { team: team.key, states: Array.isArray(team.states?.nodes) ? team.states.nodes : [] };
}

const MOVE = `mutation ProprMove($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
/** Move the ticket to a workflow state (permission: write). */
export async function moveTicket(ctx: PluginContext, issueId: string, stateId: string): Promise<void> {
  const data = await linearGraphql<{ issueUpdate?: { success?: boolean } }>(ctx, MOVE, { id: issueId, stateId });
  if (data.issueUpdate?.success !== true) throw new LinearApiError('UPDATE_NOT_APPLIED', false);
}

export const LIST_TEAMS = `query ProprTeams { teams(first: 250) { nodes { id key name } } }`;
export const LIST_PROJECTS = `query ProprProjects { projects(first: 250) { nodes { id name } } }`;
export const LIST_STATES = `query ProprStates { workflowStates(first: 250) { nodes { id name team { key } } } }`;
