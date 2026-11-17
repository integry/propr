import { PluginDeliveryError, type PluginContext, type PluginEventInput, type PluginJsonValue } from '@propr/shared';
import { eventName } from '../_shared/eventSelection.js';
import { markSyncDone, moveSuperseded, planSync, syncEventsSetting, type SyncAction, type TrackerMove } from '../_shared/trackerSync.js';
import type { TicketRecord } from '../_shared/trackerRecords.js';
import { adfComment } from './adf.js';
import { commentOnTicket, deliveryFailure, ticketTransitions, transitionTicket } from './api.js';
import { JIRA_SETTINGS } from './settings.js';

/**
 * Jira, outbound: a ProPR event about a ticket handed over by this plugin
 * comments on the ticket and, for "pull request opened" and "merged", moves
 * it to the configured status (see `_shared/trackerSync.ts`). A Jira ticket
 * changes status only through its workflow's transitions, so the move takes
 * the transition the ticket offers to a status of that name. The comment is
 * ProPR's own sentence and a GitHub link, as an ADF document; nothing from
 * the ticket, the code or the task's logs is sent to Jira.
 *
 * A status no transition from the ticket's current status reaches is logged
 * as a warning (shown in Activity) and skipped; the comment and later events
 * go ahead.
 */

export interface SyncResult { [key: string]: PluginJsonValue; event: string; ticket: string | null; skipped: string | null; commented: boolean; moved: string | null; problems: string[] }

const STATE_SETTING: Record<TrackerMove, string> = { opened: JIRA_SETTINGS.openedState, merged: JIRA_SETTINGS.mergedState };
const stateName = (ctx: PluginContext, move: TrackerMove): string => {
  const value = ctx.settings[STATE_SETTING[move]];
  return typeof value === 'string' ? value.trim() : '';
};
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A Jira name as shown in a log line: quotes and control characters dropped, capped. */
const shown = (name: string) => name.replace(/["\x00-\x1f\x7f]/g, '').slice(0, 100);

type ActionOutcome = { commented?: true; moved?: string; problem?: string };

async function run(ctx: PluginContext, ticket: TicketRecord, action: SyncAction): Promise<ActionOutcome> {
  if (action.kind === 'comment') {
    await commentOnTicket(ctx, ticket.t, adfComment(action.message.sentence, action.message.link));
    await markSyncDone(ctx, ticket, action.marker);
    ctx.log.info(`Commented on ${ticket.k}`, { ticket: ticket.k });
    return { commented: true };
  }
  const name = stateName(ctx, action.move);
  const { status, transitions } = await ticketTransitions(ctx, ticket.t);
  if (await moveSuperseded(ctx, ticket, action)) {
    ctx.log.info(`Did not move ${ticket.k} back: its pull request was merged already`, { ticket: ticket.k });
    return {};
  }
  if (status !== null && same(status, name)) {
    await markSyncDone(ctx, ticket, action.marker);
    ctx.log.info(`${ticket.k} is already in ${shown(status)}`, { ticket: ticket.k, state: shown(status) });
    return {};
  }
  const transition = transitions.find(t => same(t.to.name, name));
  if (!transition) {
    // Reported, not retried: the status stays unreachable until the settings or the workflow change. Other events go ahead.
    await markSyncDone(ctx, ticket, action.marker);
    const from = status === null ? '' : ` from its current status "${shown(status)}"`;
    const problem = `Jira offers no transition to a status named "${shown(name)}"${from} for ${ticket.k}, so it was not moved. Choose a status the project's workflow reaches in the plugin's settings`;
    ctx.log.warn(problem, { ticket: ticket.k, state: shown(name) });
    return { problem };
  }
  await transitionTicket(ctx, ticket.t, transition.id);
  await markSyncDone(ctx, ticket, action.marker);
  ctx.log.info(`Moved ${ticket.k} to ${shown(transition.to.name)}`, { ticket: ticket.k, state: shown(transition.to.name) });
  return { moved: transition.to.name };
}

export async function syncJiraTicket(input: PluginEventInput, ctx: PluginContext): Promise<SyncResult> {
  const event = eventName(input.event);
  const outcome = await planSync(ctx, input, {
    events: syncEventsSetting(ctx.settings, JIRA_SETTINGS.syncEvents),
    moves: { opened: stateName(ctx, 'opened') !== '', merged: stateName(ctx, 'merged') !== '' },
  });
  if (!outcome.plan) return { event, ticket: null, skipped: outcome.skipped, commented: false, moved: null, problems: [] };
  const { ticket, actions } = outcome.plan;
  const summary: SyncResult = { event, ticket: ticket.k, skipped: null, commented: false, moved: null, problems: [] };
  // Each action runs even when another failed; done ones are not repeated when the delivery is retried.
  const failures: Error[] = [];
  for (const action of actions) {
    try {
      const done = await run(ctx, ticket, action);
      if (done.commented) summary.commented = true;
      if (done.moved) summary.moved = done.moved;
      if (done.problem) summary.problems.push(done.problem);
    } catch (error) {
      failures.push(deliveryFailure(error, action.kind === 'comment' ? `the comment on ${ticket.k}` : `moving ${ticket.k}`));
    }
  }
  if (failures.length) {
    const retryable = failures.find(f => !(f instanceof PluginDeliveryError && f.permanent));
    throw retryable ?? failures[0];
  }
  return summary;
}
