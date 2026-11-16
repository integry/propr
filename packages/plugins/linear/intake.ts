import type { PluginContext, PluginJsonValue, PluginSettingValues, PluginWebhookInput } from '@propr/shared';
import { startFromTicket, type Ticket } from '../_shared/tracker.js';
import { markStep, stepDone } from '../_shared/trackerLinks.js';
import { DEFAULT_ISSUE_LABEL, DEFAULT_TRIGGER_LABEL, LINEAR_SETTINGS, labelSetting, mappedRepositories, mappingValue } from './settings.js';
import { postSyncComment } from './sync.js';

/**
 * Linear, inbound: the plugin's `linear` webhook receives Linear's data
 * change webhooks (https://linear.app/developers/webhooks). ProPR verifies
 * each request before any of this runs: `Linear-Signature` is the hex
 * HMAC-SHA256 of the raw body with the webhook's signing secret, and a
 * repeated `Linear-Delivery` id is refused as a replay.
 *
 * An `Issue` webhook hands a ticket to ProPR when the trigger label is added
 * to it (or it is created with the label), in a team or project Repository
 * mapping maps to exactly one repository. The plugin then creates one GitHub
 * issue there with the ProPR trigger label; ProPR's label-triggered intake
 * starts the task. Every other change, an unmapped ticket, and removing the
 * label or closing the ticket do nothing (the work is not cancelled).
 */

/** Linear advises refusing a webhook whose `webhookTimestamp` is more than a minute from the time it was received. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Z][A-Z0-9_]{0,15}-\d{1,9}$/;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

interface LinearIssueData {
  id?: unknown; identifier?: unknown; title?: unknown; description?: unknown; url?: unknown;
  teamId?: unknown; team?: { id?: unknown } | null; projectId?: unknown; labelIds?: unknown; labels?: { id?: unknown; name?: unknown }[];
}
interface LinearWebhook { action?: unknown; type?: unknown; data?: LinearIssueData; updatedFrom?: { labelIds?: unknown }; url?: unknown; webhookTimestamp?: unknown }

export type IntakeOutcome = 'created' | 'duplicate' | 'ignored';
export interface IntakeResult { [key: string]: PluginJsonValue; outcome: IntakeOutcome; reason: string | null; repository: string | null; issue: number | null }
const result = (outcome: IntakeOutcome, reason: string | null, repository: string | null = null, issue: number | null = null): IntakeResult => ({ outcome, reason, repository, issue });

/** Whether this webhook adds the trigger label: the ticket has it now, and was created with it or did not have it before. */
export function addsTriggerLabel(body: LinearWebhook, trigger: string): boolean {
  const wanted = trigger.toLowerCase();
  const labels = Array.isArray(body.data?.labels) ? body.data!.labels : [];
  const matching = labels.filter(l => typeof l?.id === 'string' && typeof l.name === 'string' && l.name.trim().toLowerCase() === wanted).map(l => l.id as string);
  const current = new Set(ids(body.data?.labelIds));
  // The label as Linear has it on the ticket now: listed in labels and, when labelIds is sent, in it too.
  const present = matching.filter(id => !current.size || current.has(id));
  if (!present.length) return false;
  if (body.action === 'create') return true;
  if (body.action !== 'update' || !body.updatedFrom || !Array.isArray(body.updatedFrom.labelIds)) return false;
  const before = new Set(ids(body.updatedFrom.labelIds));
  return present.some(id => !before.has(id));
}

/** The repository a ticket maps to: its project's mapping first, else its team's. `ambiguous` when that mapping names several. */
export function ticketRepository(settings: PluginSettingValues, data: LinearIssueData): { repository: string | null; reason: 'unmapped' | 'ambiguous' | null } {
  const team = text(data.teamId) || text(data.team?.id);
  const project = text(data.projectId);
  for (const value of [project && mappingValue('project', project), team && mappingValue('team', team)]) {
    if (!value) continue;
    const repositories = mappedRepositories(settings, value);
    if (repositories.length === 1) return { repository: repositories[0], reason: null };
    if (repositories.length > 1) return { repository: null, reason: 'ambiguous' };
  }
  return { repository: null, reason: 'unmapped' };
}

/** Handle one verified Linear webhook request. Nothing of the ticket's text is logged or returned. */
export async function handleLinearWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<IntakeResult> {
  let body: LinearWebhook;
  try { body = JSON.parse(input.body) as LinearWebhook; } catch { return result('ignored', 'not_json'); }
  if (!body || typeof body !== 'object' || body.type !== 'Issue') return result('ignored', 'not_an_issue');
  if (body.action !== 'create' && body.action !== 'update') return result('ignored', 'other_action');
  const sent = typeof body.webhookTimestamp === 'number' ? body.webhookTimestamp : Number.NaN;
  if (!Number.isFinite(sent) || Math.abs(input.receivedAt - sent) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    ctx.log.warn('Ignored a Linear webhook whose webhookTimestamp is missing or more than a minute from when it was received (a replay, or a clock out of step)');
    return result('ignored', 'stale_timestamp');
  }
  const data = body.data ?? {};
  const id = text(data.id); const key = text(data.identifier);
  if (!ID.test(id) || !KEY.test(key)) return result('ignored', 'not_a_ticket');
  if (!addsTriggerLabel(body, labelSetting(ctx.settings, LINEAR_SETTINGS.triggerLabel, DEFAULT_TRIGGER_LABEL))) return result('ignored', 'no_trigger_label_added');
  const { repository, reason } = ticketRepository(ctx.settings, data);
  if (!repository) {
    if (reason === 'ambiguous') ctx.log.warn(`${key} is in a Linear team or project mapped to several repositories; nothing was created. Map it to one repository`, { ticket: key });
    else ctx.log.info(`${key} is not in a mapped Linear team or project; ignored`, { ticket: key });
    return result('ignored', reason);
  }
  const url = text(data.url) || text(body.url);
  const ticket: Ticket = {
    id, key, url: /^https:\/\/linear\.app\//.test(url) ? url : null,
    title: typeof data.title === 'string' ? data.title : '', description: typeof data.description === 'string' ? data.description : '',
    scope: text(data.teamId) || text(data.team?.id) || null,
  };
  const label = labelSetting(ctx.settings, LINEAR_SETTINGS.issueLabel, DEFAULT_ISSUE_LABEL);
  // The comment with the issue link. A failure fails the delivery; its retry finds the issue created and posts only the comment.
  const started = await startFromTicket(ctx, { service: 'Linear', ticket, repository, label }, async link => {
    if (!stepDone(link, 'created') && await postSyncComment(ctx, 'issue_created', link, null, null)) await markStep(ctx, link, 'created');
  });
  return result(started.outcome, null, started.repository, started.issue);
}
