import type { PluginContext, PluginJsonValue, PluginWebhookInput } from '@propr/shared';
import { githubTriggerLabel, handOffTicket } from '../_shared/trackerIssue.js';
import { adfToMarkdown } from './adf.js';
import { deliveryFailure, getTicket, jiraSite, siteTicketId, type JiraTicket } from './api.js';
import { JIRA_SETTINGS, jiraTriggerLabel, ticketRepository } from './settings.js';

/**
 * Jira, inbound: the `issues` webhook receives the `jira:issue_created` and
 * `jira:issue_updated` events of a webhook an administrator registered under
 * Jira settings, System, WebHooks
 * (https://developer.atlassian.com/cloud/jira/platform/webhooks/). ProPR
 * verifies each request before any of this runs: the webhook is registered
 * with a secret, and Jira sends `X-Hub-Signature: sha256=<hex HMAC-SHA256 of
 * the body>`; `X-Atlassian-Webhook-Identifier` (the same across Jira's
 * retries) is the delivery id, so a replayed delivery is refused.
 *
 * A ticket created with, or updated to have, the trigger label, in a project
 * mapped to exactly one repository, is handed to ProPR: one GitHub issue (see
 * `_shared/trackerIssue.ts`). The webhook's changelog only tells whether the
 * label was added; the ticket is then read back from the configured site's
 * REST API by its id, so the labels, project, summary and description are
 * Jira's current ones, not the payload's. Removing the label or closing the
 * ticket does nothing. A webhook about a ticket of another site (its `self`
 * URL on another host, such as a webhook still registered on a site the
 * settings no longer name) is ignored: the id would read the configured
 * site's ticket of that number. The ticket is recorded under the site and its
 * id (`siteTicketId`), so de-duplication and sync-back never mistake another
 * site's ticket with the same id for it.
 */

const ISSUE_ID = /^\d{1,18}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,254}-\d{1,18}$/;
const EVENTS = new Set(['jira:issue_created', 'jira:issue_updated']);

export type IntakeOutcome = 'created' | 'duplicate' | 'ignored';
export interface IntakeResult { [key: string]: PluginJsonValue; outcome: IntakeOutcome; reason: string | null; ticket: string | null; repository: string | null; issue: number | null }
const result = (outcome: IntakeOutcome, reason: string | null, extra: Partial<IntakeResult> = {}): IntakeResult => ({ outcome, reason, ticket: null, repository: null, issue: null, ...extra });

interface ChangeItem { field?: unknown; fieldId?: unknown; fromString?: unknown; toString?: unknown }
interface JiraPayload {
  webhookEvent?: unknown;
  issue?: { id?: unknown; key?: unknown; self?: unknown; fields?: { project?: { id?: unknown; key?: unknown } | null; labels?: unknown } | null };
  changelog?: { items?: unknown };
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** Jira writes a labels change as the space-separated labels before and after. */
const labelList = (value: unknown): string[] => (typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : []);
/** The origin of a URL the payload gives, or null when it gives none or it is not a URL. */
const originOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try { return new URL(value).origin; } catch { return null; }
};
const hasLabel = (labels: readonly unknown[], wanted: string) => labels.some(label => typeof label === 'string' && label.trim().toLowerCase() === wanted.toLowerCase());

/**
 * Whether the payload says the trigger label was added: a ticket created
 * with it, or an update whose changelog has a labels change that adds it.
 * `no_label_added` when the labels did not change, `other_label` when they
 * changed without adding the trigger.
 */
function triggerAdded(payload: JiraPayload, label: string): { added: true } | { added: false; reason: 'no_label_added' | 'other_label' } {
  if (payload.webhookEvent === 'jira:issue_created') {
    const labels = payload.issue?.fields?.labels;
    if (!Array.isArray(labels)) return labels === undefined ? { added: true } : { added: false, reason: 'no_label_added' };
    return hasLabel(labels, label) ? { added: true } : { added: false, reason: labels.length ? 'other_label' : 'no_label_added' };
  }
  const items = Array.isArray(payload.changelog?.items) ? payload.changelog!.items as ChangeItem[] : [];
  const changes = items.filter(item => !!item && typeof item === 'object' && (item.fieldId === 'labels' || item.field === 'labels'));
  if (!changes.length) return { added: false, reason: 'no_label_added' };
  return changes.some(item => hasLabel(labelList(item.toString), label) && !hasLabel(labelList(item.fromString), label))
    ? { added: true } : { added: false, reason: 'other_label' };
}

export async function handleJiraWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<IntakeResult> {
  let payload: JiraPayload;
  try { payload = JSON.parse(input.body) as JiraPayload; } catch { return result('ignored', 'not_json'); }
  if (!payload || typeof payload !== 'object') return result('ignored', 'not_json');
  if (!EVENTS.has(String(payload.webhookEvent))) return result('ignored', 'not_an_issue_event');
  const id = str(payload.issue?.id);
  if (!id || !ISSUE_ID.test(id)) return result('ignored', 'no_issue_id');
  const site = jiraSite(ctx.settings);
  const from = originOf(payload.issue?.self);
  if (site && from && from !== site) return result('ignored', 'other_site');
  const label = jiraTriggerLabel(ctx.settings);
  const added = triggerAdded(payload, label);
  if (!added.added) return result('ignored', added.reason);
  // The payload's project spares an API call for an unmapped ticket; the ticket's own is checked again below.
  const early = ticketRepository(ctx.settings, { id: str(payload.issue?.fields?.project?.id), key: str(payload.issue?.fields?.project?.key) });
  if (early.problem === 'unmapped' && payload.issue?.fields?.project) return result('ignored', 'unmapped');

  let ticket: JiraTicket;
  try { ticket = await getTicket(ctx, id); } catch (error) { throw deliveryFailure(error, 'reading the ticket'); }
  const reference = typeof ticket.key === 'string' && KEY.test(ticket.key) ? ticket.key : null;
  if (!reference || ticket.id !== id) return result('ignored', 'unreadable_ticket');
  // Removed again since the webhook was sent: nothing is handed over.
  if (!hasLabel(Array.isArray(ticket.fields.labels) ? ticket.fields.labels : [], label)) return result('ignored', 'other_label', { ticket: reference });
  const mapping = ticketRepository(ctx.settings, { id: str(ticket.fields.project?.id), key: str(ticket.fields.project?.key) });
  if (!mapping.repository) {
    ctx.log.info(`Ticket ${reference} has the trigger label but its project is ${mapping.problem === 'ambiguous' ? 'mapped to several repositories' : 'not mapped to a repository'}; nothing was created`, { ticket: reference });
    return result('ignored', mapping.problem, { ticket: reference });
  }
  // getTicket answered, so the site is set: the ticket is recorded as that site's.
  const handed = await handOffTicket(ctx, {
    id: siteTicketId(site!, id), reference, url: `${site}/browse/${reference}`,
    title: typeof ticket.fields.summary === 'string' ? ticket.fields.summary : '',
    description: adfToMarkdown(ticket.fields.description),
    repository: mapping.repository, githubLabel: githubTriggerLabel(ctx.settings, JIRA_SETTINGS.githubLabel),
    service: 'Jira', trigger: `adding the \`${label.replace(/`/g, '')}\` label`,
  });
  return result(handed.outcome, null, { ticket: handed.ticket, repository: handed.repository, issue: handed.issue });
}
