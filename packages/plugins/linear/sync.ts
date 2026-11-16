import { PluginDeliveryError, type PluginContext, type PluginEventInput, type PluginJsonValue } from '@propr/shared';
import { eventName } from '../_shared/eventSelection.js';
import { markSyncDone, planSync, syncEventsSetting, type SyncAction, type SyncMessage, type TrackerMove } from '../_shared/trackerSync.js';
import type { TicketRecord } from '../_shared/trackerRecords.js';
import { commentOnTicket, deliveryFailure, moveTicket, ticketTeamStates } from './api.js';
import { LINEAR_SETTINGS } from './settings.js';

/**
 * Linear, outbound: a ProPR event about a ticket handed over by this plugin
 * comments on the ticket and, for "pull request opened" and "merged", moves
 * it to the configured workflow state (see `_shared/trackerSync.ts`). The
 * comment is ProPR's own sentence and a GitHub link; nothing from the ticket,
 * the code or the task's logs is sent to Linear.
 *
 * A state name the ticket's team does not have is logged as a warning (shown
 * in Activity) and skipped; the comment and later events go ahead.
 */

export interface SyncResult { [key: string]: PluginJsonValue; event: string; ticket: string | null; skipped: string | null; commented: boolean; moved: string | null; problems: string[] }

const STATE_SETTING: Record<TrackerMove, string> = { opened: LINEAR_SETTINGS.openedState, merged: LINEAR_SETTINGS.mergedState };
const stateName = (ctx: PluginContext, move: TrackerMove): string => {
  const value = ctx.settings[STATE_SETTING[move]];
  return typeof value === 'string' ? value.trim() : '';
};

/** The comment as Linear Markdown: the sentence, the link, and who posted it. */
export function linearComment(message: SyncMessage): string {
  const link = message.link ? ` [${message.link.label}](${message.link.url})` : '';
  return `${message.sentence}${link}\n\n_Posted by ProPR._`;
}

type ActionOutcome = { commented?: true; moved?: string; problem?: string };

async function run(ctx: PluginContext, ticket: TicketRecord, action: SyncAction): Promise<ActionOutcome> {
  if (action.kind === 'comment') {
    await commentOnTicket(ctx, ticket.t, linearComment(action.message));
    await markSyncDone(ctx, ticket, action.marker);
    ctx.log.info(`Commented on ${ticket.k}`, { ticket: ticket.k });
    return { commented: true };
  }
  const name = stateName(ctx, action.move);
  const { team, states } = await ticketTeamStates(ctx, ticket.t);
  const state = states.find(s => typeof s.name === 'string' && s.name.trim().toLowerCase() === name.toLowerCase());
  if (!state) {
    // Reported, not retried: the name stays missing until the settings change. Other events go ahead.
    await markSyncDone(ctx, ticket, action.marker);
    const problem = `Linear team ${team} has no workflow state named "${name}", so ${ticket.k} was not moved. Choose a state the team has in the plugin's settings`;
    ctx.log.warn(problem, { ticket: ticket.k, team, state: name });
    return { problem };
  }
  await moveTicket(ctx, ticket.t, state.id);
  await markSyncDone(ctx, ticket, action.marker);
  ctx.log.info(`Moved ${ticket.k} to ${state.name}`, { ticket: ticket.k, state: state.name });
  return { moved: state.name };
}

export async function syncLinearTicket(input: PluginEventInput, ctx: PluginContext): Promise<SyncResult> {
  const event = eventName(input.event);
  const outcome = await planSync(ctx, input, {
    events: syncEventsSetting(ctx.settings, LINEAR_SETTINGS.syncEvents),
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
