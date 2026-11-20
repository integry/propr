import type { PluginContext, PluginJsonValue, PluginWebhookInput } from '@propr/shared';
import { githubTriggerLabel, handOffTicket } from '../_shared/trackerIssue.js';
import { deliveryFailure, getTicket, type LinearTicket } from './api.js';
import { LINEAR_SETTINGS, linearTriggerLabel, teamsMappedByKey, ticketRepository } from './settings.js';

/**
 * Linear, inbound: the `issues` webhook receives Linear's data change events
 * (https://linear.app/developers/webhooks). ProPR verifies each request before
 * any of this runs: `Linear-Signature` is the hex HMAC-SHA256 of the raw body
 * with the webhook's signing secret, and `Linear-Delivery` (the payload's
 * UUID) is the delivery id, so a replayed delivery is refused. Here a request
 * whose `webhookTimestamp` is more than a minute from when ProPR received it
 * is ignored, as Linear recommends.
 *
 * An Issue created with, or updated to have, the trigger label, in a team or
 * project mapped to exactly one repository, is handed to ProPR: one GitHub
 * issue (see `_shared/trackerIssue.ts`). The ticket is read back from
 * Linear's API, so the labels, team and project are Linear's current ones,
 * not the payload's. Removing the label or closing the ticket does nothing.
 */

/** How far `webhookTimestamp` may be from the time ProPR received the request. */
export const WEBHOOK_TOLERANCE_MS = 60_000;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const REFERENCE = /^[A-Z][A-Z0-9_]{0,9}-\d{1,9}$/;
const TICKET_URL = /^https:\/\/linear\.app\/[A-Za-z0-9._~%/-]{1,400}$/;

export type IntakeOutcome = 'created' | 'duplicate' | 'ignored';
export interface IntakeResult { [key: string]: PluginJsonValue; outcome: IntakeOutcome; reason: string | null; ticket: string | null; repository: string | null; issue: number | null }
const result = (outcome: IntakeOutcome, reason: string | null, extra: Partial<IntakeResult> = {}): IntakeResult => ({ outcome, reason, ticket: null, repository: null, issue: null, ...extra });

interface LinearPayload {
  action?: unknown; type?: unknown; webhookTimestamp?: unknown;
  data?: { id?: unknown; teamId?: unknown; projectId?: unknown; labelIds?: unknown };
  updatedFrom?: { labelIds?: unknown };
}

const ids = (value: unknown): string[] | null => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null);
const idOrNull = (value: unknown): string | null => (typeof value === 'string' && ID.test(value) ? value : null);

/**
 * Whether the payload may have added a label: an Issue created with labels,
 * or updated with `labelIds` among the changed properties. Anything else
 * (a title edit, a state change, a label removed only) is ignored before
 * Linear is asked anything.
 */
function labelsMayBeAdded(payload: LinearPayload): boolean {
  if (payload.action === 'create') return (ids(payload.data?.labelIds) ?? []).length > 0 || payload.data?.labelIds === undefined;
  if (payload.action !== 'update' || !payload.updatedFrom || !Object.hasOwn(payload.updatedFrom, 'labelIds')) return false;
  const before = ids(payload.updatedFrom.labelIds) ?? [];
  const after = ids(payload.data?.labelIds);
  return after === null || after.some(id => !before.includes(id));
}

/** The trigger label's id when the ticket has it now and (for an update) did not before. */
function triggerAdded(ticket: LinearTicket, payload: LinearPayload, label: string): boolean {
  const wanted = label.toLowerCase();
  const trigger = ticket.labels.find(l => typeof l.name === 'string' && l.name.trim().toLowerCase() === wanted);
  if (!trigger) return false;
  if (payload.action === 'create') return true;
  return !(ids(payload.updatedFrom?.labelIds) ?? []).includes(trigger.id);
}

export async function handleLinearWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<IntakeResult> {
  let payload: LinearPayload;
  try { payload = JSON.parse(input.body) as LinearPayload; } catch { return result('ignored', 'not_json'); }
  if (!payload || typeof payload !== 'object') return result('ignored', 'not_json');
  const sentAt = typeof payload.webhookTimestamp === 'number' ? payload.webhookTimestamp : NaN;
  if (!Number.isFinite(sentAt) || Math.abs(input.receivedAt - sentAt) > WEBHOOK_TOLERANCE_MS) {
    ctx.log.warn('Ignored a Linear webhook whose webhookTimestamp is more than a minute from when ProPR received it');
    return result('ignored', 'stale');
  }
  if (payload.type !== 'Issue') return result('ignored', 'not_an_issue');
  const id = idOrNull(payload.data?.id);
  if (!id) return result('ignored', 'no_issue_id');
  if (!labelsMayBeAdded(payload)) return result('ignored', 'no_label_added');
  // The payload's team and project spare an API call for an unmapped ticket; the ticket's own are checked again below.
  // Only when every team is mapped by id: a team mapped by its key is matched once the ticket is read.
  const early = ticketRepository(ctx.settings, { teamId: idOrNull(payload.data?.teamId), teamKey: null, projectId: idOrNull(payload.data?.projectId) });
  if (early.problem === 'unmapped' && typeof payload.data?.teamId === 'string' && !teamsMappedByKey(ctx.settings)) return result('ignored', 'unmapped');

  let ticket: LinearTicket;
  try { ticket = await getTicket(ctx, id); } catch (error) { throw deliveryFailure(error, 'reading the ticket'); }
  const reference = typeof ticket.identifier === 'string' && REFERENCE.test(ticket.identifier) ? ticket.identifier : null;
  if (!reference || ticket.id !== id) return result('ignored', 'unreadable_ticket');
  if (!triggerAdded(ticket, payload, linearTriggerLabel(ctx.settings))) return result('ignored', 'other_label', { ticket: reference });
  const mapping = ticketRepository(ctx.settings, { teamId: idOrNull(ticket.team?.id), teamKey: ticket.team?.key ?? null, projectId: idOrNull(ticket.project?.id) });
  if (!mapping.repository) {
    ctx.log.info(`Ticket ${reference} has the trigger label but its ${mapping.problem === 'ambiguous' ? 'team or project is mapped to several repositories' : 'team and project are not mapped to a repository'}; nothing was created`, { ticket: reference });
    return result('ignored', mapping.problem, { ticket: reference });
  }
  const handed = await handOffTicket(ctx, {
    id, reference, url: typeof ticket.url === 'string' && TICKET_URL.test(ticket.url) ? ticket.url : null,
    title: typeof ticket.title === 'string' ? ticket.title : '', description: typeof ticket.description === 'string' ? ticket.description : '',
    repository: mapping.repository, githubLabel: githubTriggerLabel(ctx.settings, LINEAR_SETTINGS.githubLabel),
    service: 'Linear', trigger: `adding the \`${linearTriggerLabel(ctx.settings).replace(/`/g, '')}\` label`,
  });
  return result(handed.outcome, null, { ticket: handed.ticket, repository: handed.repository, issue: handed.issue });
}
