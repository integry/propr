import { PluginDeliveryError, PluginSdkError, parsePluginRetryAfter, pluginHttpsUrlSettingProblem, type PluginContext, type PluginJsonValue, type PluginSettingValues } from '@propr/shared';

/**
 * Jira Cloud's REST API, version 3
 * (https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/), on the
 * site the plugin's settings name, through `ctx.http('api-token')`. ProPR
 * sends the stored `<account email>:<API token>` as HTTP Basic credentials
 * (https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/;
 * the connection declares `authorization: basic`) and only to that site: its
 * host is derived from the Jira site URL setting (`outboundHostsFromSettings`),
 * which must be on `*.atlassian.net`. Errors are reported by HTTP status only:
 * Jira's error messages may quote input, so they are never repeated. Rate
 * limits answer 429 with `Retry-After`
 * (https://developer.atlassian.com/cloud/jira/platform/rate-limiting/).
 */

export const API_TOKEN = 'api-token';
export const JIRA_SITE_HOSTS = ['*.atlassian.net'] as const;

/** What the configure form shows before the API token is set. */
export const NOT_CONNECTED = 'Jira is not connected yet. Set the Jira site URL, save, set the account email and API token under Connections, then choose Reload choices.';

/** `ctx.http` refusals that are configuration problems: retrying cannot help. */
const PERMANENT_SDK_CODES = new Set(['host_not_allowed', 'insecure_url', 'private_address', 'invalid_input', 'permission_denied']);

/** The site's origin (`https://acme.atlassian.net`), or null when the setting is unset or not a Jira Cloud site. */
export function jiraSite(settings: PluginSettingValues, key = 'siteUrl'): string | null {
  const value = settings[key];
  if (typeof value !== 'string' || !value.trim()) return null;
  return pluginHttpsUrlSettingProblem({ hosts: JIRA_SITE_HOSTS }, value.trim()) ? null : new URL(value.trim()).origin;
}

/**
 * The id a ticket is recorded under (`ctx.state`, see `_shared/trackerRecords.ts`):
 * the site's host and the ticket's issue id, `acme.atlassian.net/10123`. Issue
 * ids are numbered per site, so a ticket is known by both: after the site URL
 * setting changes, another site's ticket with the same id is neither taken for
 * a duplicate nor updated by the sync-back of a ticket handed over from the
 * first site.
 */
export const siteTicketId = (site: string, id: string): string => `${new URL(site).host}/${id}`;

/**
 * The issue id of a recorded ticket when it was handed over from the site the
 * settings name now; null when it came from another site (or the site is not
 * set), as it cannot be reached there.
 */
export function ticketOnSite(settings: PluginSettingValues, recordId: string): string | null {
  const site = jiraSite(settings);
  const slash = recordId.lastIndexOf('/');
  if (!site || slash < 0) return null;
  const id = recordId.slice(slash + 1);
  return recordId.slice(0, slash) === new URL(site).host && /^\d{1,18}$/.test(id) ? id : null;
}

/** A refusal from Jira; `permanent` unless it may succeed later. Its message holds only a coded reason. */
export class JiraApiError extends Error {
  readonly name = 'JiraApiError';
  constructor(readonly code: string, readonly permanent: boolean, readonly retryAfterMs: number | null = null) { super(`Jira answered ${code}`); }
}

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED' };

/**
 * One request to `<site>/rest/api/3/<path>`. Throws `JiraApiError` for Jira's
 * answers and `PluginDeliveryError` when the site or token is not set or Jira
 * cannot be reached. Returns the parsed JSON body (null for an empty one).
 */
export async function jiraRequest<T>(ctx: PluginContext, method: 'GET' | 'POST', path: string, json?: Record<string, PluginJsonValue>): Promise<T | null> {
  const site = jiraSite(ctx.settings);
  if (!site) throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
  let status: number; let retryAfter: string | undefined; let text: string;
  try {
    const response = await ctx.http(API_TOKEN)(`${site}/rest/api/3/${path}`, {
      method, headers: { accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) }, ...(json ? { json } : {}),
    });
    status = response.status; retryAfter = response.headers['retry-after'];
    text = (await response.text()).slice(0, 1_000_000);
  } catch (error) {
    const sdk = error instanceof PluginSdkError ? error : null;
    if (sdk?.code === 'connection_unavailable') throw new PluginDeliveryError(NOT_CONNECTED, { permanent: true });
    if (sdk && PERMANENT_SDK_CODES.has(sdk.code)) throw new PluginDeliveryError(`The Jira API request was refused: ${sdk.message}`, { permanent: true });
    throw new PluginDeliveryError(`Jira could not be reached: ${sdk ? sdk.message : 'the request failed'}`);
  }
  if (status === 429) throw new JiraApiError('RATE_LIMITED', false, parsePluginRetryAfter(retryAfter));
  if (status >= 500 || status === 408) throw new JiraApiError(`HTTP_${status}`, false, parsePluginRetryAfter(retryAfter));
  if (status < 200 || status >= 300) throw new JiraApiError(CODES[status] ?? `HTTP_${status}`, true);
  if (!text.trim()) return null;
  try { return JSON.parse(text) as T; } catch { throw new JiraApiError('NOT_JSON', false); }
}

/** A `JiraApiError` (or any other error) as the delivery's failure. */
export function deliveryFailure(error: unknown, what: string): Error {
  if (!(error instanceof JiraApiError)) return error instanceof Error ? error : new Error(String(error));
  if (!error.permanent) {
    const wait = error.retryAfterMs === null ? '' : `; it asked to retry after ${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} s`;
    return new PluginDeliveryError(`Jira answered ${error.code} for ${what}${wait}`, { retryAfterMs: error.retryAfterMs });
  }
  const hint = error.code === 'UNAUTHORIZED'
    ? 'Check the account email and API token under Connections'
    : 'Check that the account can browse the project, add comments and transition issues, and the plugin\'s settings';
  return new PluginDeliveryError(`Jira refused ${what} with ${error.code}; it is not retried. ${hint}`, { permanent: true });
}

const ISSUE_ID = /^\d{1,18}$/;
const checkedId = (id: string) => {
  if (!ISSUE_ID.test(id)) throw new JiraApiError('INVALID_ISSUE_ID', true);
  return id;
};

export interface JiraTicket {
  id: string; key: string;
  fields: {
    summary?: unknown; description?: unknown; labels?: unknown;
    project?: { id?: unknown; key?: unknown } | null;
    status?: { name?: unknown } | null;
  };
}

/** The ticket as Jira has it now (permission: Browse projects). */
export async function getTicket(ctx: PluginContext, id: string): Promise<JiraTicket> {
  const issue = await jiraRequest<JiraTicket>(ctx, 'GET', `issue/${checkedId(id)}?fields=summary,description,labels,project,status`);
  if (!issue || typeof issue !== 'object' || !issue.fields || typeof issue.fields !== 'object') throw new JiraApiError('NOT_FOUND', true);
  return issue;
}

/** Comment on the ticket (permission: Add comments). `body` is an ADF document of ProPR's own text. */
export async function commentOnTicket(ctx: PluginContext, id: string, body: Record<string, unknown>): Promise<void> {
  const created = await jiraRequest<{ id?: unknown }>(ctx, 'POST', `issue/${checkedId(id)}/comment`, { body: body as PluginJsonValue });
  if (!created || typeof created.id !== 'string') throw new JiraApiError('COMMENT_NOT_CREATED', false);
}

export interface JiraTransition { id: string; name: string; to: { name: string } }

/** The ticket's current status and the transitions its workflow offers from it. */
export async function ticketTransitions(ctx: PluginContext, id: string): Promise<{ status: string | null; transitions: JiraTransition[] }> {
  const issue = await jiraRequest<JiraTicket>(ctx, 'GET', `issue/${checkedId(id)}?fields=status`);
  const listed = await jiraRequest<{ transitions?: unknown }>(ctx, 'GET', `issue/${checkedId(id)}/transitions`);
  const transitions = (Array.isArray(listed?.transitions) ? listed!.transitions : []).filter((t): t is JiraTransition => {
    const value = t as Partial<JiraTransition> | null;
    return !!value && typeof value.id === 'string' && /^\d{1,18}$/.test(value.id) && typeof value.to?.name === 'string';
  });
  const status = typeof issue?.fields?.status?.name === 'string' ? issue.fields.status.name : null;
  return { status, transitions };
}

/** Move the ticket along a transition (permission: Transition issues). */
export async function transitionTicket(ctx: PluginContext, id: string, transitionId: string): Promise<void> {
  await jiraRequest(ctx, 'POST', `issue/${checkedId(id)}/transitions`, { transition: { id: transitionId } });
}

export interface JiraProject { id: string; key: string; name: string }

/** The projects the account can see, at most `limit` (permission: Browse projects). */
export async function listProjects(ctx: PluginContext, limit: number): Promise<JiraProject[]> {
  const projects: JiraProject[] = [];
  for (let startAt = 0, pages = 0; projects.length < limit && pages < 10; pages += 1) {
    const page = await jiraRequest<{ values?: unknown; isLast?: unknown }>(ctx, 'GET', `project/search?startAt=${startAt}&maxResults=50&orderBy=name`);
    const values = Array.isArray(page?.values) ? page!.values as Partial<JiraProject>[] : [];
    projects.push(...values.filter((p): p is JiraProject => typeof p?.id === 'string' && typeof p.key === 'string' && typeof p.name === 'string'));
    if (page?.isLast !== false || !values.length) break;
    startAt += values.length;
  }
  return projects.slice(0, limit);
}

export const PROJECT_REFERENCE = /^(?:[A-Za-z][A-Za-z0-9_]{0,254}|\d{1,18})$/;

/** The status names of a project's workflows, over all its issue types (permission: Browse projects). */
export async function projectStatuses(ctx: PluginContext, project: string): Promise<string[]> {
  if (!PROJECT_REFERENCE.test(project)) throw new JiraApiError('INVALID_PROJECT', true);
  const types = await jiraRequest<unknown>(ctx, 'GET', `project/${encodeURIComponent(project)}/statuses`);
  const names = new Set<string>();
  for (const type of Array.isArray(types) ? types : []) {
    const statuses = (type as { statuses?: unknown })?.statuses;
    for (const status of Array.isArray(statuses) ? statuses : []) {
      const name = (status as { name?: unknown })?.name;
      if (typeof name === 'string' && name.trim()) names.add(name.trim());
    }
  }
  return [...names];
}
