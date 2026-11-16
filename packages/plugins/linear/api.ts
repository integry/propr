import { PluginDeliveryError, PluginSdkError, parsePluginRetryAfter, type PluginContext, type PluginJsonValue } from '@propr/shared';

/**
 * Linear's GraphQL API (https://linear.app/developers/graphql), through
 * `ctx.http('api-key')`: ProPR injects the personal API key as
 * `Authorization: <key>` (Linear's API keys take no `Bearer` scheme; the
 * connection's `authorization: plain`) and only `api.linear.app` is
 * reachable. Linear answers GraphQL errors in `errors`, each with an
 * `extensions.code` such as `RATELIMITED` or `AUTHENTICATION_ERROR`
 * (https://linear.app/developers/rate-limiting).
 *
 * Only ProPR's own fixed text is ever sent: comment bodies built by
 * `_shared/tracker.ts` and ids. No ticket text goes back to Linear.
 */

export const API_KEY = 'api-key';
export const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';

/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'permission_denied']);
const AUTH_CODES = new Set(['AUTHENTICATION_ERROR', 'FORBIDDEN']);

/** A refusal or failure of a Linear call. `notConnected`: the API key is not set, or Linear refused it. */
export class LinearApiError extends Error {
  readonly name = 'LinearApiError';
  constructor(readonly code: string, readonly permanent: boolean, readonly retryAfterMs: number | null = null, readonly notConnected = false) { super(`Linear answered ${code}`); }
}

/** A Linear error code: letters, digits and `_`. Anything else is not repeated. */
const errorCode = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null);

type GraphqlBody = { data?: unknown; errors?: { extensions?: { code?: unknown } }[] };
function parseBody(text: string): GraphqlBody | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as GraphqlBody : null;
  } catch { return null; }
}

/** One GraphQL request; the `data` object, or a `LinearApiError`. */
export async function linearGraphql<T>(ctx: PluginContext, query: string, variables: Record<string, PluginJsonValue> = {}): Promise<T> {
  let status: number; let retryAfter: string | undefined; let text: string;
  try {
    const response = await ctx.http(API_KEY)(LINEAR_GRAPHQL, { method: 'POST', json: { query, variables }, headers: { 'content-type': 'application/json' } });
    status = response.status; retryAfter = response.headers['retry-after'];
    text = (await response.text()).slice(0, 512 * 1024);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') throw new LinearApiError('not_connected', true, null, true);
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) throw new LinearApiError(`request_refused_${sdk.code}`, true);
    throw new LinearApiError('unreachable', false);
  }
  const body = parseBody(text);
  const codes = Array.isArray(body?.errors) ? body.errors.map(e => errorCode(e?.extensions?.code)).filter((c): c is string => c !== null) : [];
  if (status === 429 || codes.includes('RATELIMITED')) throw new LinearApiError('RATELIMITED', false, parsePluginRetryAfter(retryAfter));
  if (status >= 500 || status === 408) throw new LinearApiError(`http_${status}`, false, parsePluginRetryAfter(retryAfter));
  if (status === 401 || codes.some(c => AUTH_CODES.has(c))) throw new LinearApiError(codes.find(c => AUTH_CODES.has(c)) ?? 'AUTHENTICATION_ERROR', true, null, true);
  if (status >= 200 && status < 300 && body?.data && typeof body.data === 'object' && !codes.length && !body.errors) return body.data as T;
  throw new LinearApiError(codes[0] ?? `http_${status}`, true);
}

/** A `LinearApiError` (or any other error) as the delivery's failure. */
export function deliveryFailure(error: unknown, what: string): Error {
  if (!(error instanceof LinearApiError)) return error instanceof Error ? error : new Error(String(error));
  if (error.notConnected) return new PluginDeliveryError(`Linear refused ${what} (${error.code}). Set a valid Linear API key under Connections`, { permanent: true });
  if (!error.permanent) return new PluginDeliveryError(`Linear answered ${error.code} for ${what}; it is retried`, { retryAfterMs: error.retryAfterMs });
  return new PluginDeliveryError(`Linear refused ${what} with ${error.code}; it is not retried. Check the API key's permissions`, { permanent: true });
}

export interface LinearTeam { id: string; key: string; name: string }
export interface LinearProject { id: string; name: string }
export interface LinearState { id: string; name: string; team?: { id: string; key: string } | null }

const nodes = <T>(value: unknown): T[] => (value && typeof value === 'object' && Array.isArray((value as { nodes?: unknown }).nodes) ? (value as { nodes: T[] }).nodes : []);

export async function listTeams(ctx: PluginContext): Promise<LinearTeam[]> {
  const data = await linearGraphql<{ teams?: unknown }>(ctx, 'query ProprTeams { teams(first: 250) { nodes { id key name } } }');
  return nodes<LinearTeam>(data.teams).filter(team => typeof team?.id === 'string' && typeof team.name === 'string');
}

export async function listProjects(ctx: PluginContext): Promise<LinearProject[]> {
  const data = await linearGraphql<{ projects?: unknown }>(ctx, 'query ProprProjects { projects(first: 250) { nodes { id name } } }');
  return nodes<LinearProject>(data.projects).filter(project => typeof project?.id === 'string' && typeof project.name === 'string');
}

export async function listWorkflowStates(ctx: PluginContext): Promise<LinearState[]> {
  const data = await linearGraphql<{ workflowStates?: unknown }>(ctx, 'query ProprStates { workflowStates(first: 250) { nodes { id name team { id key } } } }');
  return nodes<LinearState>(data.workflowStates).filter(state => typeof state?.id === 'string' && typeof state.name === 'string');
}

/** The workflow states of one team. */
export async function teamStates(ctx: PluginContext, teamId: string): Promise<LinearState[]> {
  const data = await linearGraphql<{ team?: { states?: unknown } | null }>(ctx, 'query ProprTeamStates($id: String!) { team(id: $id) { states(first: 100) { nodes { id name } } } }', { id: teamId });
  return nodes<LinearState>(data.team?.states).filter(state => typeof state?.id === 'string' && typeof state.name === 'string');
}

/** `commentCreate`: a comment on the ticket. */
export async function createComment(ctx: PluginContext, issueId: string, body: string): Promise<void> {
  const data = await linearGraphql<{ commentCreate?: { success?: unknown } }>(ctx, 'mutation ProprComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }', { input: { issueId, body } });
  if (data.commentCreate?.success !== true) throw new LinearApiError('comment_not_created', true);
}

/** `issueUpdate`: move the ticket to a workflow state. */
export async function moveTicket(ctx: PluginContext, issueId: string, stateId: string): Promise<void> {
  const data = await linearGraphql<{ issueUpdate?: { success?: unknown } }>(ctx, 'mutation ProprMove($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: issueId, input: { stateId } });
  if (data.issueUpdate?.success !== true) throw new LinearApiError('issue_not_updated', true);
}
