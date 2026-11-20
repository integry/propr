import { PluginDeliveryError, type PluginContext, type PluginEventInput, type PluginJsonValue } from '@propr/shared';
import { eventName } from '../_shared/eventSelection.js';
import { markSyncDone, planSync, type SyncAction } from '../_shared/trackerSync.js';
import type { TicketRecord } from '../_shared/trackerRecords.js';
import { addNote, deliveryFailure, issueOnSite, resolveIssue } from './api.js';
import { syncSettings } from './settings.js';

/**
 * Sentry, outbound: when ProPR's pull request for a Sentry issue handed over
 * by this plugin merges, one note on the Sentry issue with the pull request
 * link and, if switched on, the issue marked resolved. The pull request is
 * linked to the Sentry issue as `_shared/trackerSync.ts` does for tracker
 * tickets: from the task that opened it (`task.completed`), its opening, or
 * its head branch (`<issue number>/…`). Each action is done once: a
 * redelivered merge posts no second note.
 *
 * The note is ProPR's own sentence and a GitHub link; nothing from the code,
 * the task's logs or the error is sent to Sentry.
 */

export interface SyncResult { [key: string]: PluginJsonValue; event: string; sentryIssue: string | null; skipped: string | null; commented: boolean; resolved: boolean }

function noteText(action: Extract<SyncAction, { kind: 'comment' }>): string {
  const link = action.message.link;
  return link ? `ProPR's pull request [${link.label}](${link.url}) for this issue was merged.` : 'ProPR\'s pull request for this issue was merged.';
}

async function run(ctx: PluginContext, ticket: TicketRecord, id: string, action: SyncAction): Promise<'commented' | 'resolved'> {
  if (action.kind === 'comment') await addNote(ctx, id, noteText(action));
  else await resolveIssue(ctx, id);
  await markSyncDone(ctx, ticket, action.marker);
  ctx.log.info(action.kind === 'comment' ? `Commented on Sentry issue ${ticket.k}` : `Marked Sentry issue ${ticket.k} resolved`, { sentryIssue: ticket.k });
  return action.kind === 'comment' ? 'commented' : 'resolved';
}

export async function syncSentryIssue(input: PluginEventInput, ctx: PluginContext): Promise<SyncResult> {
  const event = eventName(input.event);
  const settings = syncSettings(ctx.settings);
  const none: SyncResult = { event, sentryIssue: null, skipped: null, commented: false, resolved: false };
  if (!settings.comment) return { ...none, skipped: 'switched_off' };
  const outcome = await planSync(ctx, input, { events: ['pull_request.merged'], moves: { opened: false, merged: settings.resolve } });
  if (!outcome.plan) return { ...none, skipped: outcome.skipped };
  const { ticket, actions } = outcome.plan;
  const summary: SyncResult = { ...none, sentryIssue: ticket.k };
  const id = issueOnSite(ctx.settings, ticket.t);
  if (!id) {
    ctx.log.warn(`${ticket.k} was handed over from another Sentry or organization than the configured one, so it was not updated`, { sentryIssue: ticket.k });
    return { ...summary, skipped: 'other_site' };
  }
  const failures: Error[] = [];
  for (const action of actions) {
    try {
      const done = await run(ctx, ticket, id, action);
      if (done === 'commented') summary.commented = true; else summary.resolved = true;
    } catch (error) {
      failures.push(deliveryFailure(error, action.kind === 'comment' ? `the note on ${ticket.k}` : `resolving ${ticket.k}`));
    }
  }
  if (failures.length) throw failures.find(f => !(f instanceof PluginDeliveryError && f.permanent)) ?? failures[0];
  return summary;
}
