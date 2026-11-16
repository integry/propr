import type { PluginContext, PluginEventInput, PluginJsonValue, RepositoryEvent } from '@propr/shared';
import { eventName } from '../_shared/eventSelection.js';
import { eventLink, switchedOn, syncComment, syncKind, syncStep, type SyncKind } from '../_shared/tracker.js';
import { markStep, stepDone, type TrackerLink } from '../_shared/trackerLinks.js';
import { createComment, deliveryFailure, moveTicket, teamStates } from './api.js';
import { LINEAR_SETTINGS, repositoryMapped } from './settings.js';

/**
 * Linear, outbound: the sync-back. Each subscribed journal event about a
 * ticket's issue or pull request may post a comment on the ticket (each kind
 * switched on in Comment on the ticket) and, for "pull request opened" and
 * "merged", move the ticket to the workflow state its setting names. Each
 * step is remembered on the ticket's link, so a repeated delivery posts
 * nothing twice. A state name the ticket's team does not have is reported in
 * Activity (a warning) and the delivery still succeeds; the other steps run.
 */

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Post a sync-back comment when its kind is switched on; false when it is off. Linear's refusals fail the delivery. */
export async function postSyncComment(ctx: PluginContext, kind: SyncKind, link: Pick<TrackerLink, 't' | 'k' | 'r' | 'n'>, event: RepositoryEvent | null, pullRequest: number | null): Promise<boolean> {
  if (!switchedOn(ctx.settings, LINEAR_SETTINGS.comments).includes(kind)) return false;
  try {
    await createComment(ctx, link.t, syncComment(kind, link, event, pullRequest));
  } catch (error) {
    throw deliveryFailure(error, `the ${kind.replace(/_/g, ' ')} comment on ${link.k}`);
  }
  ctx.log.info(`Commented on ${link.k} (${kind})`, { ticket: link.k, kind });
  return true;
}

/** The workflow state setting of a sync-back kind: only "pull request opened" and "merged" move the ticket. */
export function stateSetting(kind: SyncKind): string | null {
  if (kind === 'pull_request_opened') return LINEAR_SETTINGS.stateOnPullRequestOpened;
  if (kind === 'pull_request_merged') return LINEAR_SETTINGS.stateOnMerged;
  return null;
}

export type StateOutcome = 'moved' | 'missing_state' | 'unknown_team';

/** Move the ticket to the named state of its team; a name the team does not have moves nothing. */
async function moveToState(ctx: PluginContext, link: TrackerLink, name: string): Promise<StateOutcome> {
  if (!link.g) {
    ctx.log.warn(`The Linear team of ${link.k} is not known, so it was not moved to "${name}"`, { ticket: link.k });
    return 'unknown_team';
  }
  try {
    const wanted = name.toLowerCase();
    const state = (await teamStates(ctx, link.g)).find(s => s.name.trim().toLowerCase() === wanted);
    if (!state) {
      ctx.log.warn(`The Linear workflow state "${name}" does not exist in the team of ${link.k}, so the ticket was not moved. Choose another state in the plugin's settings`, { ticket: link.k, state: name });
      return 'missing_state';
    }
    await moveTicket(ctx, link.t, state.id);
  } catch (error) {
    throw deliveryFailure(error, `moving ${link.k} to "${name}"`);
  }
  ctx.log.info(`Moved ${link.k} to "${name}"`, { ticket: link.k, state: name });
  return 'moved';
}

export interface SyncResult {
  [key: string]: PluginJsonValue;
  event: string; kind: SyncKind | null; ticket: string | null;
  comment: boolean; state: StateOutcome | null;
  skipped: 'not_a_sync_event' | 'switched_off' | 'repository_not_mapped' | 'no_ticket' | null;
}

export async function syncTicket(input: PluginEventInput, ctx: PluginContext): Promise<SyncResult> {
  const { event } = input;
  const base = { event: eventName(event), comment: false, state: null };
  const kind = syncKind(event);
  if (!kind) return { ...base, kind: null, ticket: null, skipped: 'not_a_sync_event' };
  const comment = switchedOn(ctx.settings, LINEAR_SETTINGS.comments).includes(kind);
  const key = stateSetting(kind);
  const stateName = key ? text(ctx.settings[key]) : '';
  // Switched off: nothing is read or sent.
  if (!comment && !stateName) return { ...base, kind, ticket: null, skipped: 'switched_off' };
  if (!repositoryMapped(ctx.settings, event.repository)) return { ...base, kind, ticket: null, skipped: 'repository_not_mapped' };
  const found = await eventLink(ctx, event);
  if (!found) return { ...base, kind, ticket: null, skipped: 'no_ticket' };
  let { link } = found;
  const step = syncStep(kind, event, found.pullRequest);
  let commented = false;
  let state: StateOutcome | null = null;
  if (comment && !stepDone(link, `${step}:comment`)) {
    commented = await postSyncComment(ctx, kind, link, event, found.pullRequest);
    link = await markStep(ctx, link, `${step}:comment`);
  }
  if (stateName && !stepDone(link, `${step}:state`)) {
    state = await moveToState(ctx, link, stateName);
    link = await markStep(ctx, link, `${step}:state`);
  }
  return { ...base, kind, ticket: link.k, comment: commented, state, skipped: null };
}
